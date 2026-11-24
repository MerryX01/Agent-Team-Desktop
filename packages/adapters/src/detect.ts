import { execFile } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { constants, existsSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentDefinition } from '@shared/index'

export interface DetectionResult {
  installed: boolean
  version?: string
  commandPath?: string
  detail?: string
}

/** Windows 下拼接 cmd.exe /c 命令行：无空格/元字符的路径与参数不包引号，避免 cmd 把引号当作命令名的一部分。 */
export function buildCmdLine(command: string, args: string[]): string {
  const quote = (value: string) => /[\s&|<>^"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
  return [quote(command), ...args.map(quote)].join(' ')
}

function runCaptured(command: string, args: string[], timeoutMs = 8000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const onWindows = process.platform === 'win32'
    const isScript = onWindows && /\.(cmd|bat)$/i.test(command)
    const child = isScript
      ? execFile('cmd.exe', ['/d', '/s', '/c', buildCmdLine(command, args)], { timeout: timeoutMs, windowsHide: true })
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

/**
 * Electron 从桌面快捷方式启动时拿到的 PATH 往往不包含用户后装的 npm 全局目录，
 * 也不包含 WorkBuddy 自带的 node/CLI 目录，导致「明明装了却检测不到 / 起了就退出」。
 * 这里列出常见的 CLI 安装目录，检测与 spawn 共用，避免依赖启动方式。
 */
export function extraBinDirs(): string[] {
  const home = homedir()
  const dirs = new Set<string>()
  const push = (path: string | undefined) => { if (path) dirs.add(path) }
  push(process.env.APPDATA ? join(process.env.APPDATA, 'npm') : undefined)
  push(process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'npm') : undefined)
  push(join(home, '.opencode', 'bin'))
  push(join(home, '.local', 'bin'))
  push(join(home, '.bun', 'bin'))
  push(join(home, '.qoder', 'bin', 'qodercli'))
  push(join(home, '.cargo', 'bin'))
  const nodeVersions = join(home, '.workbuddy', 'binaries', 'node', 'versions')
  try {
    for (const version of readdirSync(nodeVersions)) push(join(nodeVersions, version))
  } catch { /* ignore */ }
  return [...dirs].filter((dir) => existsSync(dir))
}

/** 为子进程补齐 CLI 所在目录与 node 所在目录（.cmd shim 依赖 node 可执行）。 */
export function augmentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const dirs = extraBinDirs()
  const merged = [...dirs, ...(env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')]
  const path = [...new Set(merged.filter(Boolean))].join(process.platform === 'win32' ? ';' : ':')
  return { ...env, PATH: path }
}

async function resolveCommandPath(command: string): Promise<string | undefined> {
  if (isAbsolute(command)) {
    try { await access(command, constants.X_OK); return command } catch { return undefined }
  }
  if (process.platform !== 'win32') return command || undefined
  const result = await runCaptured('where.exe', [command])
  if (result.code === 0) {
    const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    // npm 全局命令在 Windows 上常同时生成无扩展名 shell shim 与 .cmd；execFile 无法直接启动无扩展名 shim（ENOENT）。
    // 优先选择带可执行扩展名的那一个（其中 .cmd/.bat 会由 runCaptured/spawnProcess 走 cmd.exe 包装）。
    const found = candidates.find((path) => /\.(exe|cmd|bat)$/i.test(path)) ?? candidates[0]
    if (found) return found
  }
  // where.exe 受 PATH 限制；再扫一遍已知安装目录，兼容从桌面快捷方式启动的 Electron。
  const extensions = ['.cmd', '.exe', '.bat', '']
  for (const dir of extraBinDirs()) {
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  const home = process.env.USERPROFILE
  const fallback = command === 'qoder' || command === 'qodercli'
    ? join(home ?? '', '.qoder', 'bin', 'qodercli', 'qodercli.exe')
    : undefined
  if (fallback) {
    try { await access(fallback, constants.X_OK); return fallback } catch { /* ignore */ }
  }
  return undefined
}

const DESKTOP_APP_HINTS: Record<string, string[]> = {
  traecli: ['Trae CN', 'Trae'],
  qoder: ['Qoder CN', 'Qoder'],
  qodercli: ['Qoder CN', 'Qoder'],
  mcode: ['MiniMax Code', 'MiniMax'],
  qwen: ['QianwenApp', 'Qwen Code', '通义'],
  doubao: ['Doubao', '豆包']
}

/** 只读扫描常见安装目录，判断“桌面客户端已装”；这不等于 CLI/ACP 可用。 */
export async function detectDesktopApp(command: string): Promise<string | undefined> {
  const key = command.trim().toLowerCase()
  const hints = DESKTOP_APP_HINTS[key]
  if (!hints) return undefined
  const roots = [
    process.env.LOCALAPPDATA, process.env.APPDATA, process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'], 'D:\\SoftWare', 'D:\\Program Files'
  ].filter((root): root is string => Boolean(root))
  for (const root of roots) {
    let entries: string[]
    try { entries = await readdir(root) } catch { continue }
    for (const hint of hints) {
      const exact = entries.find((entry) => entry.toLowerCase() === hint.toLowerCase())
      if (exact) return join(root, exact)
    }
  }
  return undefined
}

/** WorkBuddy 桌面端自带的 codebuddy CLI：支持 --acp stdio 与 -p headless。 */
export function resolveWorkBuddyCliPath(): string | undefined {
  const resources = process.env.WORKBUDDY_RESOURCES_PATH
  if (!resources) return undefined
  const script = join(resources, 'app.asar.unpacked', 'cli', 'bin', 'codebuddy')
  return existsSync(script) ? script : undefined
}

export async function detectWorkBuddyCli(): Promise<DetectionResult> {
  const script = resolveWorkBuddyCliPath()
  if (!script) {
    return { installed: false, detail: '未找到 WorkBuddy 内置 codebuddy CLI；请从 WorkBuddy 安装目录启动应用后再检测' }
  }
  const node = process.env.CODEBUDDY_NODE_BIN || 'node'
  const result = await runCaptured(node, [script, '--version'], 15000)
  const version = result.code === 0 ? result.stdout.split(/\r?\n/)[0] : process.env.WORKBUDDY_APP_VERSION
  return {
    installed: true,
    commandPath: script,
    version,
    detail: 'WorkBuddy 内置 codebuddy CLI，支持 --acp；复用本机账号登录态'
  }
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
  // 使用 where.exe 解析出的绝对路径，保证 Windows .cmd/.bat 走 cmd.exe 包装。
  const version = await runCaptured(commandPath, ['--version'], 15000)
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
  // 部分 CLI（如 doubao auth status）未登录时仍以退出码 0 返回 login_required 提示，需按文本识别。
  if (/login_required|not\s+logged\s+in|未登录/i.test(text)) {
    return { state: 'not-logged-in', detail: text }
  }
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
