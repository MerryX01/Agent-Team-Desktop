import { contextBridge, ipcRenderer } from 'electron'
import type {
  AgentDefinition, AgentEvent, AgentMessage, ApiProvider, Approval, CustomAdapter, FileChange,
  MemoryEntry, ReviewCycle, Team, TeamMember, Task, Template, UsageRecord
} from '@shared/index'

type ProviderView = ApiProvider & { hasKey?: boolean }
type Settings = Record<string, unknown>
type RunResult = { runId: string; completed: string[]; failed: string[]; cancelled: string[] }

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

const api = {
  agents: {
    list: () => invoke<AgentDefinition[]>('agents:list'),
    save: (agent: AgentDefinition) => invoke<AgentDefinition[]>('agents:save', agent),
    detect: (id: string) => invoke<{ installed: boolean; version?: string; commandPath?: string; detail?: string }>('agents:detect', id),
    detectAll: () => invoke<Record<string, { installed: boolean; detail?: string; version?: string }>>('agents:detectAll'),
    loginStatus: (id: string) => invoke<{ state: string; detail: string }>('agents:login', id)
  },
  providers: {
    list: () => invoke<ProviderView[]>('providers:list'),
    save: (provider: Partial<ApiProvider>, apiKey?: string) => invoke<ProviderView[]>('providers:save', { provider, apiKey }),
    test: (id: string, apiKey?: string) => invoke<{ ok: boolean; detail: string }>('providers:test', { id, apiKey }),
    models: (id: string, apiKey?: string) => invoke<string[]>('providers:models', { id, apiKey }),
    remove: (id: string) => invoke<boolean>('providers:remove', id)
  },
  teams: {
    list: () => invoke<Team[]>('teams:list'),
    save: (team: Team) => invoke<Team[]>('teams:save', team),
    members: (teamId: string) => invoke<TeamMember[]>('teams:members', teamId),
    setMembers: (teamId: string, members: TeamMember[]) => invoke<TeamMember[]>('teams:setMembers', { teamId, members })
  },
  tasks: {
    list: (teamId?: string) => invoke<Task[]>('tasks:list', teamId),
    save: (task: Task) => invoke<Task[]>('tasks:save', task),
    run: (teamId: string, taskIds: string[], cwd: string) => invoke<RunResult>('tasks:run', { teamId, taskIds, cwd }),
    retry: (taskId: string, teamId: string, cwd: string) => invoke<RunResult>('tasks:retry', { taskId, teamId, cwd }),
    cancel: (runId: string) => invoke<boolean>('tasks:cancel', runId)
  },
  approvals: {
    list: () => invoke<Approval[]>('approvals:list'),
    resolve: (id: string, decision: 'approved' | 'rejected') => invoke<boolean>('approvals:resolve', { id, decision })
  },
  files: {
    list: (input?: { runId?: string; taskId?: string }) => invoke<FileChange[]>('files:list', input)
  },
  messages: {
    list: (teamId?: string, taskId?: string) => invoke<AgentMessage[]>('messages:list', { teamId, taskId }),
    send: (input: Omit<AgentMessage, 'id' | 'createdAt'>) => invoke<AgentMessage>('messages:send', input)
  },
  reviews: {
    list: (taskId?: string) => invoke<ReviewCycle[]>('reviews:list', taskId),
    request: (taskId: string, options: { reviewerAgentId?: string; requesterAgentId?: string; runId?: string }) =>
      invoke<ReviewCycle>('reviews:request', { taskId, ...options }),
    start: (cycleId: string) => invoke<ReviewCycle>('reviews:start', cycleId),
    resolve: (cycleId: string, decision: 'approve' | 'changes_requested', options?: { summary?: string; findings?: string }) =>
      invoke<{ cycle: ReviewCycle; task: Task; nextStage: string }>('reviews:resolve', { cycleId, decision, ...options }),
    leadSignoff: (cycleId: string, decision: 'approve' | 'reject') =>
      invoke<ReviewCycle>('reviews:leadSignoff', { cycleId, decision }),
    humanApprove: (taskId: string) => invoke<Task>('reviews:humanApprove', taskId)
  },
  templates: {
    list: (kind?: Template['kind']) => invoke<Template[]>('templates:list', kind),
    save: (template: Template) => invoke<Template[]>('templates:save', template),
    apply: (templateId: string, options?: { teamId?: string; title?: string }) =>
      invoke<{ kind: 'team' | 'task'; team?: Team; members?: TeamMember[]; task?: Task }>('templates:apply', { templateId, ...options })
  },
  memory: {
    list: (input?: { scope?: MemoryEntry['scope']; scopeId?: string }) => invoke<MemoryEntry[]>('memory:list', input),
    save: (entry: MemoryEntry) => invoke<MemoryEntry[]>('memory:save', entry),
    remove: (id: string) => invoke<boolean>('memory:remove', id)
  },
  usage: {
    list: (agentId?: string) => invoke<UsageRecord[]>('usage:list', agentId)
  },
  customAdapters: {
    list: () => invoke<CustomAdapter[]>('customAdapters:list'),
    save: (adapter: CustomAdapter) => invoke<CustomAdapter[]>('customAdapters:save', adapter),
    remove: (id: string) => invoke<boolean>('customAdapters:remove', id)
  },
  system: {
    refreshPath: () => invoke<{ count: number }>('system:refreshPath')
  },
  credentials: {
    set: (secret: string, ref?: string) => invoke<string>('credentials:set', { ref, secret })
  },
  events: {
    list: (limit?: number) => invoke<AgentEvent[]>('events:list', limit),
    clear: () => invoke<boolean>('events:clear'),
    on: (listener: (event: AgentEvent) => void) => {
      const wrapped = (_event: unknown, payload: AgentEvent) => listener(payload)
      ipcRenderer.on('runtime:event', wrapped)
      return () => { ipcRenderer.removeListener('runtime:event', wrapped) }
    }
  },
  settings: {
    get: () => invoke<Settings>('settings:get'),
    set: (patch: Settings) => invoke<Settings>('settings:set', patch)
  },
  workspaces: {
    list: () => invoke<Array<{ id: string; path: string; isolation: string }>>('workspaces:list'),
    add: (path: string) => invoke<{ id: string; path: string }>('workspaces:add', { path })
  }
}

contextBridge.exposeInMainWorld('desktopApi', api)

export type DesktopApi = typeof api
