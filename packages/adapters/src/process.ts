import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import type { Readable } from 'node:stream'
import type { AgentDefinition } from '@shared/index'
import { newId, nowIso } from '@shared/index'
import { detectAgent } from './detect'
import type { AgentAdapter, AgentSession, ConnectOptions, EventDraft, EventSink } from './types'
import { AdapterError } from './types'

const DEFAULT_TIMEOUT_MS = 120000

/** 无头 CLI 的 prompt 是命令行参数，只有 send 收到 prompt 后才能拼出完整 argv。
 *  因此 connect 负责校验命令/工作目录并建立会话，子进程在 send 中按提示按需 spawn。 */
interface LiveProcessSession extends AgentSession {
  command: string
  baseArgs: string[]
  promptFlag: string
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  onEvent: EventSink
  agentId: string
  child?: ChildProcessWithoutNullStreams
  cancelled: boolean
}

const sessions = new Map<string, LiveProcessSession>()

/** 把 Windows .cmd/.bat 的单个参数安全地引用起来，避免 & | > < 等被 cmd.exe 解释。 */
function quoteCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function spawnProcess(command: string, args: string[], cwd: string, env: Record<string, string>): ChildProcessWithoutNullStreams {
  const fullEnv = { ...process.env, ...env }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    // 仅对 .cmd/.bat 使用 cmd.exe；参数逐个引用后原样传递，不拼接用户字符串。
    const cmdLine = [quoteCmdArg(command), ...args.map(quoteCmdArg)].join(' ')
    return spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], {
      cwd, env: fullEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams
  }
  // 非脚本路径：shell:false，参数以数组原样传递，杜绝 shell 注入。
  return spawn(command, args, { cwd, env: fullEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
}

function useHeadless(definition: AgentDefinition): boolean {
  return Boolean(definition.headlessCommand) || (definition.headlessArgs?.length ?? 0) > 0
}

function lineReader(stream: Readable, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve) => {
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line) onLine(line)
        index = buffer.indexOf('\n')
      }
    })
    stream.on('end', () => {
      if (buffer.trim()) onLine(buffer.replace(/\r$/, ''))
      resolve()
    })
    stream.on('error', () => resolve())
  })
}

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> {
  return new Promise((resolve) => {
    let spawnError: Error | undefined
    child.on('error', (error) => { spawnError = error })
    child.on('close', (code, signal) => resolve({ code, signal, error: spawnError }))
  })
}

function extractText(value: unknown, depth = 0): string {
  if (depth > 4) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => extractText(item, depth + 1)).join('')
  if (!value || typeof value !== 'object') return ''
  const object = value as Record<string, unknown>
  for (const key of ['text', 'content', 'result', 'delta', 'message', 'completion', 'choices']) {
    if (key in object) {
      const found = extractText(object[key], depth + 1)
      if (found) return found
    }
  }
  return ''
}

const SILENT_TYPES = new Set(['ping', 'log', 'usage', 'error', 'failed', 'tool', 'tool_call', 'tool_call_update', 'tool_result'])

/** 单行解析：JSON 成功则按 type/content/text 取文本，失败则把整行当作纯文本。 */
function parseLine(line: string): string {
  const trimmed = line.trim()
  if (!trimmed) return ''
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return trimmed
    const object = parsed as Record<string, unknown>
    const type = String(object.type ?? object.event ?? object.role ?? '').toLowerCase()
    if (SILENT_TYPES.has(type)) return ''
    return extractText(object)
  } catch {
    return trimmed
  }
}

export class NativeProcessAdapter implements AgentAdapter {
  readonly id = 'process'
  readonly kind = 'native-process' as const

  constructor(private readonly options: { promptFlag?: string; defaultTimeoutMs?: number } = {}) {}

  detect(definition: AgentDefinition) {
    const command = definition.headlessCommand || definition.command
    return detectAgent({ ...definition, command, args: [] })
  }

  async connect(definition: AgentDefinition, cwd: string, options: ConnectOptions): Promise<AgentSession> {
    const command = definition.headlessCommand || definition.command
    if (!command) throw new AdapterError('未配置无头命令（headlessCommand/command）', 'connect')
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new AdapterError(`工作目录不存在或不是目录: ${cwd}`, 'connect')
    }
    const baseArgs = (useHeadless(definition) ? definition.headlessArgs : definition.args) ?? []
    const session: LiveProcessSession = {
      id: newId('session'), agentId: definition.id, protocol: 'stdio', status: 'online', cwd,
      startedAt: nowIso(), command, baseArgs: [...baseArgs],
      promptFlag: this.options.promptFlag ?? '',
      env: { ...(definition.env ?? {}) },
      timeoutMs: options.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      onEvent: options.onEvent, cancelled: false
    }
    sessions.set(session.id, session)
    options.onEvent({
      type: 'system', agentId: definition.id,
      message: `无头进程通道已就绪: ${command}（cwd: ${cwd}）`
    })
    return session
  }

  async send(session: AgentSession, prompt: string, context?: { taskId?: string; runId?: string }): Promise<string> {
    const live = sessions.get(session.id)
    if (!live) throw new AdapterError('会话不存在或已关闭', 'send')
    if (live.child && !live.child.killed) throw new AdapterError('该会话已有正在执行的命令', 'send')
    live.cancelled = false
    live.status = 'busy'

    const args = [...live.baseArgs]
    if (live.promptFlag) args.push(live.promptFlag)
    args.push(prompt) // prompt 必须是最后一个参数
    const child = spawnProcess(live.command, args, live.cwd, live.env)
    live.child = child

    const emit = (draft: EventDraft) => live.onEvent({
      ...draft,
      agentId: live.agentId,
      taskId: draft.taskId ?? context?.taskId,
      runId: draft.runId ?? context?.runId,
      data: { ...(draft.data ?? {}), sessionId: live.id }
    })

    let output = ''
    let stderrTail = ''
    const onOutputLine = (line: string) => {
      const text = parseLine(line)
      if (!text) return
      output += text
      emit({ type: 'agent.message.delta', message: text })
    }
    const onErrorLine = (line: string) => {
      stderrTail = `${stderrTail}\n${line}`.slice(-500)
      const text = parseLine(line)
      if (text) {
        output += text
        emit({ type: 'agent.message.delta', message: text, data: { stream: 'stderr' } })
      }
    }

    const stdoutDone = lineReader(child.stdout, onOutputLine)
    const stderrDone = lineReader(child.stderr, onErrorLine)
    const closed = waitForClose(child)

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        live.cancelled = true
        if (!child.killed) child.kill()
        reject(new AdapterError(`无头命令超时 (${live.timeoutMs}ms)`, 'send'))
      }, live.timeoutMs)
    })

    try {
      const outcome = await Promise.race([
        Promise.all([stdoutDone, stderrDone, closed]).then(([, , result]) => result),
        timeout
      ])
      if (outcome.error) throw new AdapterError(`无法启动命令 ${live.command}: ${outcome.error.message}`, 'send')
      if (!live.cancelled && outcome.code !== 0 && !output) {
        throw new AdapterError(`命令退出码 ${outcome.code}: ${stderrTail || '无输出'}`, 'send')
      }
      live.status = live.cancelled ? 'closed' : 'online'
      return output
    } catch (error) {
      live.status = 'failed'
      throw error instanceof AdapterError ? error : new AdapterError(String(error), 'send')
    } finally {
      if (timer) clearTimeout(timer)
      live.child = undefined
    }
  }

  async cancel(session: AgentSession): Promise<void> {
    const live = sessions.get(session.id)
    if (!live) return
    live.cancelled = true
    if (live.child && !live.child.killed) live.child.kill()
    live.status = 'closed'
  }

  async disconnect(session: AgentSession): Promise<void> {
    const live = sessions.get(session.id)
    if (!live) return
    live.cancelled = true
    if (live.child && !live.child.killed) live.child.kill()
    live.status = 'closed'
    sessions.delete(session.id)
  }
}

export const processAdapter = new NativeProcessAdapter()
