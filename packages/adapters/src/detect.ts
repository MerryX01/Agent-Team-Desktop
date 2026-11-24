import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { AgentDefinition } from '@shared/index'

export interface DetectionResult {
  installed: boolean
  version?: string
  commandPath?: string
  detail?: string
}

function runCaptured(command: string, args: string[], timeoutMs = 8000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const onWindows = process.platform === 'win32'
    const isScript = onWindows && /\.(cmd|bat)$/i.test(command)
    const child = isScript
      ? execFile('cmd.exe', ['/d', '/s', '/c', `"${command}" ${args.map((a) => `"${a}"`).join(' ')}`], { timeout: timeoutMs, windowsHide: true })
      : execFile(command, args, { timeout: timeoutMs, windowsHide: true })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

async function resolveCommandPath(command: string): Promise<string | undefined> {
  if (isAbsolute(command)) {
    try { await access(command, constants.X_OK); return command } catch { return undefined }
  }
  if (process.platform !== 'win32') return command || undefined
  const result = await runCaptured('where.exe', [command])
  if (result.code !== 0) return undefined
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
}

/** 只调用官方 CLI 与系统 where.exe，不读取任何第三方私有凭据文件。 */
export async function detectAgent(definition: AgentDefinition): Promise<DetectionResult> {
  if (!definition.command) {
    return { installed: false, detail: '未配置命令；该 Agent 需实机确认公开接入方式' }
  }
  const commandPath = await resolveCommandPath(definition.command)
  if (!commandPath) {
    return { installed: false, detail: `未找到命令 ${definition.command}（可用 UI 指定绝对路径）` }
  }
  const version = await runCaptured(definition.command, ['--version'])
  return {
    installed: true,
    commandPath,
    version: version.code === 0 ? version.stdout.split(/\r?\n/)[0] : undefined,
    detail: version.code === 0 ? undefined : `版本命令失败：${(version.stderr || version.stdout).slice(0, 200)}`
  }
}

export interface LoginStatus {
  state: 'logged-in' | 'not-logged-in' | 'unknown'
  detail: string
}

/** 仅当厂商提供官方登录状态命令时才执行；否则明确返回 unknown。 */
export async function checkLoginStatus(definition: AgentDefinition): Promise<LoginStatus> {
  if (!definition.command || !definition.statusArgs?.length) {
    return {
      state: 'unknown',
      detail: '该 Agent 未提供可自动调用的登录状态命令；请在原 CLI 内确认登录状态（平台不读取私有凭据）'
    }
  }
  const result = await runCaptured(definition.command, definition.statusArgs, 12000)
  const text = `${result.stdout}\n${result.stderr}`.trim().slice(0, 300)
  if (result.code === 0) return { state: 'logged-in', detail: text || '官方 CLI 状态命令返回成功' }
  return { state: 'not-logged-in', detail: text || '官方 CLI 状态命令返回失败，请在原 CLI 中登录' }
}

export async function refreshPath(): Promise<string[]> {
  const read = async (name: string) => {
    if (process.platform !== 'win32') return (process.env.PATH ?? '').split(':')
    const user = await runCaptured('reg.exe', ['query', 'HKCU\\Environment', '/v', 'Path'])
    const system = await runCaptured('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path'])
    const parse = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('Path'))?.split(/\s{2,}/).pop() ?? ''
    return [...parse(user.stdout).split(';'), ...parse(system.stdout).split(';')]
  }
  const parts = await read('PATH')
  const merged = [...new Set([...(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':'), ...parts].filter(Boolean))]
  process.env.PATH = merged.join(process.platform === 'win32' ? ';' : ':')
  return merged
}
