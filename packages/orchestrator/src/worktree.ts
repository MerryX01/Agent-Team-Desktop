import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface WorktreeHandle {
  path: string
  cleanup: () => Promise<void>
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = (error as { stderr?: unknown }).stderr
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  }
  return error instanceof Error ? error.message : String(error)
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true })
  return stdout.trim()
}

async function assertGitRepo(repoPath: string): Promise<void> {
  try {
    await git(repoPath, ['rev-parse', '--show-toplevel'])
  } catch (error) {
    throw new Error(`不是有效的 Git 仓库: ${repoPath}（${errorText(error)}）`)
  }
}

async function removeWorktreeAt(repoPath: string, path: string): Promise<void> {
  try {
    await git(repoPath, ['worktree', 'remove', '--force', path])
  } catch (error) {
    throw new Error(`移除 Git 工作树失败: ${path}（${errorText(error)}）`)
  }
}

function tempPrefix(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48) || 'run'
  return join(tmpdir(), `atd-wt-${safe}-`)
}

/** 在仓库的 HEAD 上创建一个独立工作树，返回路径与清理函数。 */
export async function createWorktree(repoPath: string, runId: string): Promise<WorktreeHandle> {
  await assertGitRepo(repoPath)

  let path: string
  try {
    path = await mkdtemp(tempPrefix(runId))
  } catch (error) {
    throw new Error(`无法创建工作树临时目录: ${errorText(error)}`)
  }

  try {
    await git(repoPath, ['worktree', 'add', '--detach', path, 'HEAD'])
  } catch (error) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`创建 Git 工作树失败: ${errorText(error)}`)
  }

  return { path, cleanup: () => removeWorktreeAt(repoPath, path) }
}

/** 移除之前创建的工作树，不会删除原仓库。 */
export async function removeWorktree(repoPath: string, path: string): Promise<void> {
  await assertGitRepo(repoPath)
  await removeWorktreeAt(repoPath, path)
}
