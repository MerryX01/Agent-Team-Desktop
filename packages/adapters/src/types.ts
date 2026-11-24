import type { AgentDefinition, AgentEvent, FileChange, PermissionPolicy } from '@shared/index'

export type EventDraft = Omit<AgentEvent, 'id' | 'timestamp' | 'data'> & { data?: Record<string, unknown> }
export type EventSink = (event: EventDraft) => void

export interface ApprovalRequest {
  title: string
  detail: string
  agentId: string
  taskId?: string
  runId?: string
  kind?: 'file-write' | 'shell' | 'network' | 'install' | 'other'
  risk?: 'low' | 'medium' | 'high'
  path?: string
  command?: string
  reason?: string
}
export type ApprovalDecision = 'approved' | 'rejected'

export interface ConnectOptions {
  onEvent: EventSink
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>
  timeoutMs?: number
  permissionMode?: 'ask' | 'auto-deny' | 'plan'
  taskId?: string
  runId?: string
  policy?: PermissionPolicy
  workspacePaths?: string[]
  onFileChange?: (change: FileChange) => void
  onUsage?: (raw: unknown) => void
}

export interface AgentTaskContext {
  taskId?: string
  runId?: string
  cwd: string
  upstream?: string[]
  role?: string
}

export interface AgentSession {
  id: string
  agentId: string
  sessionId?: string
  pid?: number
  protocol: 'acp' | 'http' | 'stdio'
  status: 'connecting' | 'online' | 'busy' | 'closed' | 'failed'
  cwd: string
  startedAt: string
  providerRef?: string
}

export interface DetectResult {
  installed: boolean
  version?: string
  commandPath?: string
  detail?: string
}

export interface AgentAdapter {
  id: string
  kind: AgentDefinition['kind']
  detect(definition: AgentDefinition): Promise<DetectResult>
  connect(definition: AgentDefinition, cwd: string, options: ConnectOptions): Promise<AgentSession>
  send(session: AgentSession, prompt: string, context?: Partial<AgentTaskContext>): Promise<string>
  cancel(session: AgentSession): Promise<void>
  disconnect(session: AgentSession): Promise<void>
  loginStatus?(definition: AgentDefinition): Promise<{ state: string; detail: string }>
}

export class AdapterError extends Error {
  constructor(message: string, public readonly phase: 'detect' | 'connect' | 'send' | 'cancel' | 'test') {
    super(message)
    this.name = 'AdapterError'
  }
}
