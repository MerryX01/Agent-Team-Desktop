import type { SqliteStore } from '@storage/index'
import type { AgentDefinition, AgentEvent, FileChange, PermissionPolicy } from '@shared/index'
import { newId, nowIso } from '@shared/index'
import { acpAdapter } from './acp'
import { ApiProviderAdapter, MemoryCredentialStore, type CredentialStore } from './api-provider'
import { checkLoginStatus, detectAgent, detectDesktopApp } from './detect'
import { processAdapter } from './process'
import { RemoteAcpAdapter } from './remote'
import type { AgentAdapter, AgentSession, ApprovalDecision, ApprovalRequest, ConnectOptions, EventDraft, EventSink } from './types'

const ADAPTER_ID_BY_KIND: Record<AgentDefinition['kind'], string> = {
  'native-acp': 'acp',
  'native-process': 'process',
  'remote-acp': 'remote',
  'api-provider': 'api-provider'
}

export class AdapterRegistry {
  readonly credentials: CredentialStore
  readonly api: ApiProviderAdapter
  private readonly adapters = new Map<string, AgentAdapter>()
  private readonly sessions = new Map<string, { session: AgentSession; adapter: AgentAdapter }>()

  constructor(private readonly store: SqliteStore, credentials: CredentialStore = new MemoryCredentialStore()) {
    this.credentials = credentials
    this.api = new ApiProviderAdapter(() => this.store.providers(), credentials)
    this.register(acpAdapter)
    this.register(processAdapter)
    this.register(new RemoteAcpAdapter(credentials))
    this.register(this.api)
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  adapterFor(definition: AgentDefinition): AgentAdapter {
    const id = ADAPTER_ID_BY_KIND[definition.kind]
    const adapter = this.adapters.get(id)
    if (!adapter) throw new Error(`未注册的 Adapter 类型: ${definition.kind}`)
    return adapter
  }

  /** ACP 失败且允许无头回退时，改用 process Adapter；远程通道绝不参与此回退。 */
  private fallbackAdapter(definition: AgentDefinition, attempted: AgentAdapter): AgentAdapter | undefined {
    if (!definition.headlessFallback || attempted.id !== 'acp') return undefined
    return this.adapters.get('process')
  }

  async detect(agentId: string): Promise<{ installed: boolean; version?: string; commandPath?: string; detail?: string }> {
    const definition = this.store.get<AgentDefinition>('agents', 'id', agentId)
    if (!definition) throw new Error(`Agent 不存在: ${agentId}`)
    if (definition.kind === 'api-provider') return { installed: true, detail: 'API Key 通道' }
    const result = definition.kind === 'remote-acp'
      ? await this.adapterFor(definition).detect(definition)
      : definition.kind === 'native-process'
        ? await this.adapterFor(definition).detect(definition)
        : await detectAgent(definition)
    const desktopPath = result.installed ? undefined : await detectDesktopApp(definition.command ?? '')
    this.store.update('agents', 'id', agentId, {
      installed: result.installed,
      commandPath: result.commandPath,
      desktopPath,
      version: result.version,
      lastCheck: nowIso(),
      note: result.detail ?? definition.note
    })
    return result
  }

  async loginStatus(agentId: string): Promise<{ state: string; detail: string }> {
    const definition = this.store.get<AgentDefinition>('agents', 'id', agentId)
    if (!definition) throw new Error(`Agent 不存在: ${agentId}`)
    if (!['native-acp', 'native-process'].includes(definition.kind)) {
      return { state: 'unknown', detail: '仅本机原生 Agent 支持登录状态检查' }
    }
    return checkLoginStatus(definition)
  }

  async connect(
    agentId: string,
    cwd: string,
    options: {
      onEvent: EventSink
      requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>
      taskId?: string
      runId?: string
      permissionMode?: 'ask' | 'auto-deny' | 'plan'
      policy?: PermissionPolicy
      workspacePaths?: string[]
      onFileChange?: (change: FileChange) => void
      onUsage?: (raw: unknown) => void
    }
  ): Promise<AgentSession> {
    const definition = this.store.get<AgentDefinition>('agents', 'id', agentId)
    if (!definition) throw new Error(`Agent 不存在: ${agentId}`)
    if (!definition.enabled) throw new Error(`Agent 已禁用: ${agentId}`)
    const adapter = this.adapterFor(definition)
    const connectOptions: ConnectOptions = { ...options }
    let session: AgentSession
    try {
      session = await adapter.connect(definition, cwd, connectOptions)
    } catch (error) {
      const fallback = this.fallbackAdapter(definition, adapter)
      if (!fallback) throw error
      connectOptions.onEvent({
        type: 'system', agentId: definition.id,
        message: `ACP 连接失败，按 headlessFallback 回退到无头进程: ${error instanceof Error ? error.message : String(error)}`
      })
      session = await fallback.connect(definition, cwd, connectOptions)
      this.trackSession(session, fallback, agentId, cwd)
      return session
    }
    this.trackSession(session, adapter, agentId, cwd)
    return session
  }

  private trackSession(session: AgentSession, adapter: AgentAdapter, agentId: string, cwd: string): void {
    this.sessions.set(session.id, { session, adapter })
    this.store.insert('agent_sessions', {
      id: session.id, agentId, sessionId: session.sessionId, pid: session.pid,
      protocol: session.protocol, status: session.status, cwd, createdAt: session.startedAt
    })
  }

  async send(sessionId: string, prompt: string, context?: { taskId?: string; runId?: string }): Promise<string> {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`会话不存在: ${sessionId}`)
    return entry.adapter.send(entry.session, prompt, context)
  }

  async cancel(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    await entry.adapter.cancel(entry.session)
    this.store.update('agent_sessions', 'id', sessionId, { status: 'closed' })
  }

  async disconnect(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    await entry.adapter.disconnect(entry.session)
    this.sessions.delete(sessionId)
    this.store.update('agent_sessions', 'id', sessionId, { status: 'closed' })
  }

  async disconnectAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.disconnect(id)
  }

  session(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)?.session
  }

  emitEvent(draft: EventDraft, context: { runId?: string; taskId?: string } = {}): AgentEvent {
    const event: AgentEvent = {
      id: newId('event'), runId: context.runId, taskId: context.taskId,
      agentId: draft.agentId, type: draft.type, message: draft.message,
      data: draft.data ?? {}, timestamp: nowIso()
    }
    this.store.appendEvent(event)
    return event
  }
}
