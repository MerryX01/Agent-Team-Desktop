import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultPermissionPolicy } from '@shared/index'
import { evaluatePermission, isPathInWorkspace } from '@adapters/policy'
import { diffSnapshots, readFileSafe, snapshotWorkspace, writeFileSafe } from '@adapters/diff'

const createdDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('权限策略', () => {
  it('工作区校验包含精确路径与子路径，并阻断前缀绕过', () => {
    const workspace = tempDir('atd-policy-ws-')
    const sibling = `${workspace}-evil`
    expect(isPathInWorkspace(workspace, [workspace])).toBe(true)
    expect(isPathInWorkspace(resolve(workspace, 'sub', 'a.txt'), [workspace])).toBe(true)
    expect(isPathInWorkspace(resolve(sibling, 'a.txt'), [workspace])).toBe(false)
    expect(isPathInWorkspace(resolve(workspace, 'a.txt'), [resolve(tempDir('atd-other-')), workspace])).toBe(true)
    expect(isPathInWorkspace(resolve(workspace, 'a.txt'), [])).toBe(false)

    const evaluation = evaluatePermission(
      { kind: 'file-write', path: resolve(sibling, 'a.txt') },
      defaultPermissionPolicy(), [workspace]
    )
    expect(evaluation.decision).toBe('deny')
    expect(evaluation.risk).toBe('high')
    expect(evaluation.reason).toContain('工作')
  })

  it('denyPatterns 大小写不敏感，并优先于 allow', () => {
    const policy = {
      ...defaultPermissionPolicy(),
      shellCommand: 'allow' as const,
      allowPatterns: ['rm -rf']
    }
    expect(evaluatePermission({ kind: 'shell', command: 'RM -RF /some/data' }, policy, []).decision).toBe('deny')
    expect(evaluatePermission({ kind: 'shell', command: 'echo hello' }, policy, []).decision).toBe('allow')
  })

  it('安装依赖包默认拒绝，且 allowPatterns 可将 ask 提升为 allow', () => {
    const policy = defaultPermissionPolicy()
    const install = evaluatePermission({ kind: 'install', command: 'npm install lodash' }, policy, [])
    expect(install.decision).toBe('deny')
    expect(install.kind).toBe('install')

    const withAllow = { ...policy, allowPatterns: ['git status'] }
    expect(evaluatePermission({ kind: 'shell', command: 'git status' }, withAllow, []).decision).toBe('allow')
    expect(evaluatePermission({ kind: 'shell', command: 'git push' }, withAllow, []).decision).toBe('ask')
  })

  it('file-write 默认 ask，auto-deny/plan 模式一律 deny', () => {
    const workspace = tempDir('atd-policy-ask-')
    const policy = defaultPermissionPolicy()
    const ask = evaluatePermission({ kind: 'file-write', path: resolve(workspace, 'a.txt') }, policy, [workspace])
    expect(ask.decision).toBe('ask')
    expect(ask.risk).toBe('medium')
    expect(ask.reason).toContain('审批')

    for (const permissionMode of ['auto-deny', 'plan'] as const) {
      const result = evaluatePermission(
        { kind: 'file-write', path: resolve(workspace, 'a.txt') },
        { ...policy, permissionMode }, [workspace]
      )
      expect(result.decision).toBe('deny')
      expect(result.risk).toBe('high')
    }
  })

  it('网络与 shell 分别遵循各自策略', () => {
    const policy = { ...defaultPermissionPolicy(), network: 'allow' as const, shellCommand: 'deny' as const }
    expect(evaluatePermission({ kind: 'network', title: 'GET https://example.com' }, policy, []).decision).toBe('allow')
    expect(evaluatePermission({ kind: 'shell', command: 'echo hi' }, policy, []).decision).toBe('deny')
  })
})

describe('文件快照与 Diff', () => {
  it('生成快照时跳过依赖/构建目录并识别二进制文件', async () => {
    const cwd = tempDir('atd-snapshot-')
    mkdirSync(join(cwd, 'node_modules'))
    writeFileSync(join(cwd, 'a.txt'), 'line1\nline2\nline3\n')
    writeFileSync(join(cwd, 'node_modules', 'ignored.txt'), 'should be skipped')
    writeFileSync(join(cwd, 'bin.dat'), Buffer.from([0, 1, 2, 3]))

    const snapshot = await snapshotWorkspace(cwd)
    const paths = Object.keys(snapshot)
    expect(paths.some((path) => path.endsWith('a.txt'))).toBe(true)
    expect(paths.some((path) => path.includes('node_modules'))).toBe(false)
    expect(Object.values(snapshot).some((file) => file.binary)).toBe(true)
  })

  it('对比前后快照生成可读 unified diff 与 FileChange', async () => {
    const cwd = tempDir('atd-diff-')
    const target = join(cwd, 'a.txt')
    writeFileSync(target, 'line1\nline2\nline3\n')
    const before = await snapshotWorkspace(cwd)

    writeFileSync(target, 'line1\nCHANGED\nline3\n')
    writeFileSync(join(cwd, 'new.txt'), 'new file\n')
    const after = await snapshotWorkspace(cwd)

    const changes = diffSnapshots(before, after, { runId: 'run-1', taskId: 'task-1' })
    expect(changes).toHaveLength(2)
    const modified = changes.find((change) => change.path === target)!
    expect(modified.diff).toContain('--- a/')
    expect(modified.diff).toContain('@@')
    expect(modified.diff).toContain('-line2')
    expect(modified.diff).toContain('+CHANGED')
    expect(modified.before).toContain('line2')
    expect(modified.after).toContain('CHANGED')
    expect(modified.runId).toBe('run-1')
    expect(modified.taskId).toBe('task-1')
    expect(changes.some((change) => change.path.endsWith('new.txt'))).toBe(true)
    expect(diffSnapshots(before, before, {})).toHaveLength(0)
  })

  it('readFileSafe 安全读取文本，缺失文件返回 undefined', async () => {
    const workspace = tempDir('atd-read-')
    const target = join(workspace, 'sample.txt')
    writeFileSync(target, 'abc')
    expect(await readFileSafe(target)).toEqual({ content: 'abc', binary: false })
    expect(await readFileSafe(join(workspace, 'missing.txt'))).toBeUndefined()
  })

  it('writeFileSafe 允许工作区内写入，拒绝越权写入', async () => {
    const workspace = tempDir('atd-write-')
    const target = join(workspace, 'sub', 'note.txt')
    await writeFileSafe(target, 'hello', [workspace])
    expect(readFileSync(target, 'utf8')).toBe('hello')

    const outside = join(`${workspace}-evil`, 'note.txt')
    await expect(writeFileSafe(outside, 'x', [workspace])).rejects.toThrow(/工作目录之外/)
    expect(existsSync(outside)).toBe(false)
  })
})
