import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { newId, nowIso } from '@shared/index'
import type { FileChange } from '@shared/index'
import { isPathInWorkspace } from './policy'

export const MAX_SNAPSHOT_FILES = 2000
export const MAX_FILE_BYTES = 1024 * 1024
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out'])

export interface FileContent {
  content: string
  binary: boolean
}

export type WorkspaceSnapshot = Record<string, FileContent>

export interface DiffMeta {
  runId?: string
  taskId?: string
  agentId?: string
}

export interface ReadFileOptions {
  maxBytes?: number
}

/** 解析路径并校验其（含符号链接解析结果）确实位于允许的工作区内。 */
export async function ensurePathInWorkspace(filePath: string, workspacePaths: string[]): Promise<string> {
  const target = resolve(filePath)
  if (!isPathInWorkspace(target, workspacePaths)) {
    throw new Error(`拒绝访问工作目录之外的路径: ${filePath}`)
  }
  const real = await realpath(target).catch(() => undefined)
  if (real && !isPathInWorkspace(real, workspacePaths)) {
    throw new Error(`符号链接指向工作目录之外: ${filePath}`)
  }
  return target
}

/** 安全读取文本文件：限制大小、识别二进制，失败时返回 undefined。 */
export async function readFileSafe(filePath: string, options: ReadFileOptions = {}): Promise<FileContent | undefined> {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES
  try {
    const info = await stat(filePath)
    if (!info.isFile() || info.size > maxBytes) return undefined
    const buffer = await readFile(filePath)
    if (buffer.includes(0)) return { content: buffer.toString('utf8'), binary: true }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    } catch {
      return { content: buffer.toString('utf8'), binary: true }
    }
    return { content: buffer.toString('utf8'), binary: false }
  } catch {
    return undefined
  }
}

/** 安全写入：目标必须位于工作区内（含符号链接检查），必要时创建父目录。 */
export async function writeFileSafe(filePath: string, content: string, workspacePaths: string[]): Promise<void> {
  const target = resolve(filePath)
  const parent = dirname(target)
  await mkdir(parent, { recursive: true })
  const realParent = await realpath(parent)
  if (!isPathInWorkspace(realParent, workspacePaths)) {
    throw new Error(`拒绝写入工作目录之外的路径: ${filePath}`)
  }
  await ensurePathInWorkspace(target, workspacePaths)
  await writeFile(target, content, 'utf8')
}

/** 递归快照工作区，跳过常见构建/依赖目录，并限制文件数与单文件大小。 */
export async function snapshotWorkspace(cwd: string): Promise<WorkspaceSnapshot> {
  const root = resolve(cwd)
  const result: WorkspaceSnapshot = {}
  const stack: string[] = [root]

  while (stack.length > 0 && Object.keys(result).length < MAX_SNAPSHOT_FILES) {
    const dir = stack.pop() as string
    let entries: Dirent[] = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (Object.keys(result).length >= MAX_SNAPSHOT_FILES) break
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const fullPath = join(dir, entry.name)
      const content = await readFileSafe(fullPath)
      if (content) result[fullPath] = content
    }
  }
  return result
}

interface DiffLine {
  sign: ' ' | '-' | '+'
  text: string
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 基于 LCS 的行级差异；超大文件退化为整体替换，避免 O(n*m) 内存爆炸。 */
function computeDiffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length
  const m = after.length
  if (n * m > 4_000_000) {
    return [
      ...before.map((text): DiffLine => ({ sign: '-', text })),
      ...after.map((text): DiffLine => ({ sign: '+', text }))
    ]
  }

  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = before[i] === after[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      lines.push({ sign: ' ', text: before[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ sign: '-', text: before[i] })
      i += 1
    } else {
      lines.push({ sign: '+', text: after[j] })
      j += 1
    }
  }
  while (i < n) lines.push({ sign: '-', text: before[i++] })
  while (j < m) lines.push({ sign: '+', text: after[j++] })
  return lines
}

function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return ''
  const lines = computeDiffLines(splitLines(before), splitLines(after))
  const context = 3
  const changed = lines.flatMap((line, index) => (line.sign === ' ' ? [] : [index]))
  if (changed.length === 0) return ''

  const groups: Array<{ from: number; to: number }> = []
  let groupStart = changed[0]
  let groupEnd = changed[0]
  for (const index of changed.slice(1)) {
    if (index - groupEnd <= context * 2 + 1) {
      groupEnd = index
    } else {
      groups.push({ from: groupStart, to: groupEnd })
      groupStart = groupEnd = index
    }
  }
  groups.push({ from: groupStart, to: groupEnd })

  let output = `--- a/${path}\n+++ b/${path}\n`
  for (const group of groups) {
    const start = Math.max(0, group.from - context)
    const end = Math.min(lines.length, group.to + context + 1)
    let oldLine = 1
    let newLine = 1
    for (let i = 0; i < start; i += 1) {
      if (lines[i].sign !== '+') oldLine += 1
      if (lines[i].sign !== '-') newLine += 1
    }
    let oldCount = 0
    let newCount = 0
    for (let i = start; i < end; i += 1) {
      if (lines[i].sign !== '+') oldCount += 1
      if (lines[i].sign !== '-') newCount += 1
    }
    output += `@@ -${oldLine},${oldCount} +${newLine},${newCount} @@\n`
    for (let i = start; i < end; i += 1) output += `${lines[i].sign}${lines[i].text}\n`
  }
  return output
}

/** 对比两份快照，生成可直接落库的 FileChange 列表。 */
export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot, meta: DiffMeta = {}): FileChange[] {
  const paths = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()
  const changes: FileChange[] = []
  for (const path of paths) {
    const previous = before[path]
    const current = after[path]
    if (previous?.content === current?.content && previous?.binary === current?.binary) continue
    const beforeContent = previous?.content ?? ''
    const afterContent = current?.content ?? ''
    const binary = Boolean(previous?.binary || current?.binary)
    const diff = binary
      ? `[binary file] ${path}: ${Buffer.byteLength(beforeContent, 'utf8')} -> ${Buffer.byteLength(afterContent, 'utf8')} bytes\n`
      : unifiedDiff(path, beforeContent, afterContent)
    changes.push({
      id: newId('change'),
      ...meta,
      path,
      before: beforeContent,
      after: afterContent,
      diff,
      binary,
      createdAt: nowIso()
    })
  }
  return changes
}
