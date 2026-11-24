import * as acp from '@agentclientprotocol/sdk'
import type { AgentDefinition } from '@shared/index'
import { newId, nowIso } from '@shared/index'
import { MemoryCredentialStore, type CredentialStore } from './api-provider'
import type { AgentAdapter, AgentSession, ApprovalDecision, ConnectOptions, DetectResult, EventDraft } from './types'
import { AdapterError } from './types'

const DEFAULT_TIMEOUT_MS = 20000

interface LiveRemoteSession extends AgentSession {
  conn: acp.ClientConnection
  active: acp.ActiveSession
}

const sessions = new Map<string, LiveRemoteSession>()

function describeUpdate(update: acp.SessionUpdate): EventDraft | undefined {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text'
        ? { type: 'agent.message.delta', message: update.content.text }
        : { type: 'agent.message.delta', message: `[${update.content.type}]` }
    case 'agent_thought_chunk':
      return { type: 'agent.message.delta', message: update.content.type === 'text' ? update.content.text : '[thought]' }
    case 'tool_call':
      return { type: 'agent.tool.started', message: update.title || '工具调用', data: { toolCallId: update.toolCallId, status: update.status ?? 'pending' } }
    case 'tool_call_update':
      return { type: 'agent.tool.finished', message: `工具调用 ${update.toolCallId}: ${update.status ?? 'unknown'}`, data: { toolCallId: update.toolCallId, status: update.status ?? 'unknown' } }
    case 'plan':
      return { type: 'system', message: 'Agent 更新了执行计划', data: { plan: update.entries?.map((entry) => entry.content) ?? [] } }
    default:
      return undefined
  }
}

function pickOutcome(options: acp.PermissionOption[], decision: ApprovalDecision): acp.PermissionOption | undefined {
  if (decision === 'approved') {
    return options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always') ?? options[0]
  }
  return options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always') ?? options.at(-1)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new AdapterError(`${label} 超时 (${ms}ms)`, 'connect')), ms) })
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

/** 远程通道配置校验；任何失败都给出可执行的提示，而非静默回退到本机登录态。 */
function validateRemote(definition: AgentDefinition): { url: string; tokenRef: string } {
  const url = (definition.remoteUrl ?? '').trim()
  const tokenRef = (definition.remoteTokenRef ?? '').trim()
  if (!url) throw new AdapterError('未配置 remoteUrl：请在 Agent 管理页填写企业远程 ACP 地址', 'connect')
  if (!tokenRef) throw new AdapterError('未配置 remoteTokenRef：远程 ACP 必须引用独立凭据', 'connect')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new AdapterError(`remoteUrl 不是合法 URL: ${url}`, 'connect')
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    throw new AdapterError(`remoteUrl 仅支持 http(s)/ws(s): ${url}`, 'connect')
  }
  return { url, tokenRef }
}

type HttpStreamFactory = (url: string, options?: { headers?: Record<string, string> }) => acp.Stream
type WsStreamFactory = (url: string, options?: {
  protocols?: string[]
  headers?: Record<string, string>
  WebSocket?: unknown
}) => acp.Stream

/** 优先使用 SDK 的 Streamable HTTP/SSE 传输；不可用时退到 WebSocket。
 *  两个传输都来自 @agentclientprotocol/sdk 的 experimental 子路径，按需动态加载。 */
async function openRemoteStream(url: string, token: string): Promise<{ stream: acp.Stream; transport: string }> {
  const headers = { Authorization: `Bearer ${token}` }

  try {
    const module = await import('@agentclientprotocol/sdk/experimental/http-client')
    const createHttpStream = module.createHttpStream as HttpStreamFactory
    if (typeof createHttpStream === 'function') {
      return { stream: createHttpStream(url, { headers }), transport: 'http-sse' }
    }
  } catch (error) {
    // HTTP 传输不可用时继续尝试 WebSocket；错误在两者都失败时统一报告。
    void error
  }

  try {
    const module = await import('@agentclientprotocol/sdk/experimental/ws-client')
    const createWebSocketStream = module.createWebSocketStream as WsStreamFactory
    if (typeof createWebSocketStream === 'function') {
      if (typeof globalThis.WebSocket !== 'function') {
        throw new AdapterError('当前运行环境没有全局 WebSocket，无法建立远程 ACP WebSocket 连接', 'connect')
      }
      // 浏览器 WebSocket 不支持自定义 header，因此 token 通过查询参数传递。
      const target = new URL(url)
      if (!target.searchParams.has('token')) target.searchParams.set('token', token)
      return {
        stream: createWebSocketStream(target.toString(), {
          protocols: ['acp'], headers, WebSocket: globalThis.WebSocket
        }),
        transport: 'websocket'
      }
    }
  } catch (error) {
    if (error instanceof AdapterError) throw error
    // 继续抛出统一的可读错误。
  }

  throw new AdapterError(
    '远程 ACP 传输不可用：需要 @agentclientprotocol/sdk 的 HTTP/SSE 或 WebSocket 传输（experimental/http-client、experimental/ws-client）；请确认 SDK 版本或改用本机 ACP',
    'connect'
  )
}

export class RemoteAcpAdapter implements AgentAdapter {
  readonly id = 'remote'
  readonly kind = 'remote-acp' as const

  constructor(
    private readonly credentials: CredentialStore,
    private readonly options: { defaultTimeoutMs?: number } = {}
  ) {}

  async detect(definition: AgentDefinition): Promise<DetectResult> {
    try {
      const { url, tokenRef } = validateRemote(definition)
      const hasToken = Boolean(this.credentials.get(tokenRef))
      return {
        installed: hasToken,
        detail: hasToken
          ? `已配置企业远程 ACP: ${url}（非本机桌面额度，需服务端授权）`
          : `已配置 remoteUrl=${url}，但凭据引用 ${tokenRef} 尚无可用 token`
      }
    } catch (error) {
      return { installed: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  async connect(definition: AgentDefinition, cwd: string, options: ConnectOptions): Promise<AgentSession> {
    const { url, tokenRef } = validateRemote(definition)
    const token = this.credentials.get(tokenRef)
    if (!token) throw new AdapterError(`远程 ACP 凭据为空: ${tokenRef}（请先在设置中保存企业远程 token）`, 'connect')

    const { stream, transport } = await openRemoteStream(url, token)
    const client = acp.client({ name: 'agent-team-desktop' })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        const draft = describeUpdate(ctx.params.update)
        if (draft) options.onEvent({ ...draft, agentId: definition.id, data: { ...(draft.data ?? {}), sessionId: ctx.params.sessionId } })
      })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const detail = ctx.params.toolCall.title || JSON.stringify(ctx.params.toolCall.rawInput ?? {})
        options.onEvent({
          type: 'agent.permission.required', agentId: definition.id,
          message: `远程 Agent 请求权限: ${detail}`,
          data: { toolCallId: ctx.params.toolCall.toolCallId, options: ctx.params.options.map((item) => item.name) }
        })
        let decision: ApprovalDecision = 'rejected'
        if (options.permissionMode === 'ask' && options.requestApproval) {
          try {
            decision = await options.requestApproval({
              title: ctx.params.toolCall.title || '远程 Agent 请求执行操作',
              detail, agentId: definition.id, runId: options.runId, taskId: options.taskId
            })
          } catch { decision = 'rejected' }
        }
        const selected = pickOutcome(ctx.params.options, decision)
        return { outcome: { outcome: 'selected', optionId: selected?.optionId ?? '' } }
      })
      .onRequest(acp.methods.client.fs.readTextFile, () => {
        throw acp.RequestError.methodNotFound('fs/read_text_file 未在平台启用')
      })
      .onRequest(acp.methods.client.fs.writeTextFile, () => {
        throw acp.RequestError.methodNotFound('fs/write_text_file 未在平台启用')
      })

    const conn = client.connect(stream)
    const timeoutMs = options.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    try {
      const init = await withTimeout(
        conn.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {}
        }),
        timeoutMs, '远程 ACP initialize'
      )
      const active = await withTimeout(conn.agent.buildSession(cwd).start(), timeoutMs, '远程 ACP session/new')
      options.onEvent({
        type: 'system', agentId: definition.id,
        message: `远程 ACP 已连接（${transport}，协议 ${init.protocolVersion}）；企业账号额度与本机无关`
      })
      const session: LiveRemoteSession = {
        id: newId('session'), agentId: definition.id, sessionId: active.sessionId,
        protocol: 'http', status: 'online', cwd, startedAt: nowIso(), conn, active
      }
      sessions.set(session.id, session)
      return session
    } catch (error) {
      try { conn.close() } catch { /* ignore */ }
      throw new AdapterError(
        `远程 ACP 连接失败: ${error instanceof Error ? error.message : String(error)}`,
        'connect'
      )
    }
  }

  async send(session: AgentSession, prompt: string, context?: { taskId?: string; runId?: string }): Promise<string> {
    const live = sessions.get(session.id)
    if (!live) throw new AdapterError('远程会话不存在或已关闭', 'send')
    live.status = 'busy'
    const prefix = context?.taskId ? `[任务 ${context.taskId}] ` : ''
    let output = ''
    const promptPromise = live.active.prompt(prefix + prompt)
    promptPromise.catch(() => undefined)

    const pump = (async () => {
      for (;;) {
        const message = await live.active.nextUpdate()
        if (message.kind === 'stop') break
        const draft = describeUpdate(message.update)
        if (draft?.type === 'agent.message.delta' && message.update.sessionUpdate === 'agent_message_chunk') {
          output += draft.message
        }
      }
      await promptPromise
    })()

    try {
      await withTimeout(pump, 120000, '远程 ACP prompt')
      live.status = 'online'
      return output
    } catch (error) {
      live.status = 'failed'
      throw error instanceof AdapterError ? error : new AdapterError(String(error), 'send')
    }
  }

  async cancel(session: AgentSession): Promise<void> {
    const live = sessions.get(session.id)
    if (!live?.sessionId) return
    await live.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: live.sessionId })
    live.status = 'closed'
  }

  async disconnect(session: AgentSession): Promise<void> {
    const live = sessions.get(session.id)
    if (!live) return
    try { live.active.dispose() } catch { /* ignore */ }
    try { live.conn.close() } catch { /* ignore */ }
    live.status = 'closed'
    sessions.delete(session.id)
  }
}

export const remoteAdapter = new RemoteAcpAdapter(new MemoryCredentialStore())
