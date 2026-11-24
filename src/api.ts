import type { DesktopApi } from '../electron/preload/index'
import { DEFAULT_AGENTS, defaultPermissionPolicy, newId, nowIso } from '@shared/index'
import type {
  AgentDefinition, AgentEvent, AgentMessage, ApiProvider, Approval, CustomAdapter, FileChange,
  MemoryEntry, ReviewCycle, Team, TeamMember, Task, Template, UsageRecord
} from '@shared/index'

const PREFIX = 'atd-demo-'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch { return fallback }
}

function save<T>(key: string, value: T): T {
  localStorage.setItem(PREFIX + key, JSON.stringify(value))
  return value
}

function seedTeam(): Team {
  return {
    id: 'team-default', name: '默认团队', description: '示例：规划 → 开发 → 审查',
    defaultWorkspace: '', maxConcurrency: 2, permissionMode: 'ask',
    isolation: 'none', policy: defaultPermissionPolicy(),
    leadAgentId: 'agent-trae', reviewFlow: 'agent_approval', reviewFlowPrompt: '', defaultActionMode: 'do'
  }
}

function seedTasks(): Task[] {
  const base = {
    teamId: 'team-default', status: 'pending' as const, priority: 0, inputContext: '',
    outputSummary: '', approvalRequired: false, createdAt: nowIso(),
    actionMode: 'do' as const, boardColumn: 'todo' as const, reviewState: 'none' as const
  }
  return [
    { ...base, taskId: 'task-plan', title: '拆解需求', description: '输出任务清单与依赖', assigneeAgentId: 'agent-trae', dependsOn: [] },
    { ...base, taskId: 'task-dev', title: '实现核心逻辑', description: '在工作目录实现最小可用版本', assigneeAgentId: 'agent-qoder', dependsOn: ['task-plan'] },
    { ...base, taskId: 'task-review', title: '审查变更', description: '只审查 Diff，不修改文件', assigneeAgentId: 'agent-minimax', dependsOn: ['task-dev'] }
  ]
}

const mockApi = {
  agents: {
    list: async () => load('agents', DEFAULT_AGENTS),
    save: async (agent) => save('agents', [...load('agents', DEFAULT_AGENTS).filter((a) => a.id !== agent.id), agent]),
    remove: async (id) => save('agents', load('agents', DEFAULT_AGENTS).filter((a) => a.id !== id)),
    detect: async () => ({ installed: false, detail: '浏览器预览模式：不会启动本机 CLI' }),
    detectAll: async () => ({ 'agent-trae': { installed: false, detail: '预览模式' } }),
    loginStatus: async () => ({ state: 'unknown', detail: '浏览器预览模式：不检查登录状态' })
  },
  providers: {
    list: async () => load('providers', [] as ApiProvider[]),
    save: async (provider) => save('providers', [{ ...provider, credentialRef: provider.credentialRef ?? newId('cred') } as ApiProvider]),
    test: async () => ({ ok: false, detail: '浏览器预览模式：不发起真实 API 请求' }),
    models: async () => [],
    remove: async () => true
  },
  teams: {
    list: async () => load('teams', [seedTeam()]),
    save: async (team) => save('teams', [team]),
    members: async () => load<TeamMember[]>('members', [
      { teamId: 'team-default', agentId: 'agent-trae', role: 'architect', workflow: '', priority: 0, canWrite: false },
      { teamId: 'team-default', agentId: 'agent-qoder', role: 'developer', workflow: '', priority: 1, canWrite: true },
      { teamId: 'team-default', agentId: 'agent-minimax', role: 'reviewer', workflow: '', priority: 2, canWrite: false }
    ]),
    setMembers: async (_teamId, members) => save('members', members)
  },
  tasks: {
    list: async () => load('tasks', seedTasks()),
    save: async (task) => save('tasks', [...load('tasks', seedTasks()).filter((t) => t.taskId !== task.taskId), task]),
    run: async (teamId, taskIds, cwd) => {
      const tasks = load('tasks', seedTasks()).map((task) => taskIds.includes(task.taskId)
        ? { ...task, status: 'completed' as const, outputSummary: '预览模式：模拟输出', startedAt: nowIso(), completedAt: nowIso() }
        : task)
      save('tasks', tasks)
      const events: AgentEvent[] = taskIds.map((taskId) => ({
        id: newId('event'), runId: 'demo-run', taskId, type: 'task.completed',
        message: `预览模式：任务 ${taskId} 已完成`, data: {}, timestamp: nowIso()
      }))
      save('events', [...events, ...load('events', [] as AgentEvent[])])
      return { runId: 'demo-run', completed: taskIds, failed: [], cancelled: [] }
    },
    retry: async () => ({ runId: 'demo-run', completed: [], failed: [], cancelled: [] }),
    cancel: async () => true
  },
  approvals: {
    list: async () => load<Approval[]>('approvals', []),
    resolve: async () => true
  },
  files: {
    list: async () => load<FileChange[]>('files', [])
  },
  messages: {
    list: async (teamId, taskId) => load<AgentMessage[]>('messages', []).filter((m) => (!teamId || m.teamId === teamId) && (!taskId || m.taskId === taskId)),
    send: async (input) => {
      const message: AgentMessage = { ...input, id: newId('message'), createdAt: nowIso() }
      save('messages', [...load<AgentMessage[]>('messages', []), message])
      return message
    }
  },
  reviews: {
    list: async (taskId) => load<ReviewCycle[]>('reviews', []).filter((r) => !taskId || r.taskId === taskId),
    request: async (taskId, options) => {
      const cycle: ReviewCycle = { id: newId('review'), taskId, ...options, round: 1, status: 'requested', summary: '', findings: '', createdAt: nowIso() }
      save('reviews', [...load<ReviewCycle[]>('reviews', []).filter((r) => r.taskId !== taskId), cycle])
      return cycle
    },
    start: async (cycleId) => {
      const cycles = load<ReviewCycle[]>('reviews', [])
      const cycle = cycles.find((c) => c.id === cycleId)
      if (!cycle) throw new Error('审查记录不存在')
      const next = { ...cycle, status: 'in_review' as const }
      save('reviews', cycles.map((c) => c.id === cycleId ? next : c))
      return next
    },
    resolve: async (cycleId, decision, options) => {
      const cycles = load<ReviewCycle[]>('reviews', [])
      const cycle = cycles.find((c) => c.id === cycleId)
      if (!cycle) throw new Error('审查记录不存在')
      const next = { ...cycle, status: decision === 'approve' ? 'approved' as const : 'changes_requested' as const, summary: options?.summary ?? '', findings: options?.findings ?? '', completedAt: nowIso() }
      save('reviews', cycles.map((c) => c.id === cycleId ? next : c))
      return { cycle: next, task: load('tasks', seedTasks()).find((t) => t.taskId === cycle.taskId)!, nextStage: decision === 'approve' ? 'done' : 'rework' }
    },
    leadSignoff: async (cycleId) => {
      const cycles = load<ReviewCycle[]>('reviews', [])
      const cycle = cycles.find((c) => c.id === cycleId)!
      const next = { ...cycle, status: 'lead_signoff' as const, summary: 'Lead 已签核，等待人工最终确认' }
      save('reviews', cycles.map((c) => c.id === cycleId ? next : c))
      return next
    },
    humanApprove: async (taskId) => {
      const tasks = load('tasks', seedTasks()).map((t) => t.taskId === taskId ? { ...t, reviewState: 'approved' as const, boardColumn: 'approved' as const } : t)
      save('tasks', tasks)
      return tasks.find((t) => t.taskId === taskId)!
    }
  },
  templates: {
    list: async () => load<Template[]>('templates', []),
    save: async (template) => save('templates', [...load<Template[]>('templates', []).filter((t) => t.id !== template.id), template]),
    apply: async (templateId, options) => {
      const template = load<Template[]>('templates', []).find((item) => item.id === templateId)
      if (!template) throw new Error('模板不存在')
      const existing = load('tasks', seedTasks())
      const task: Task = {
        taskId: newId('task'), teamId: options?.teamId ?? 'team-default',
        title: options?.title ?? template.name, description: template.description,
        actionMode: 'do' as const, boardColumn: 'todo' as const, reviewState: 'none' as const, status: 'pending', priority: 0, dependsOn: [], inputContext: '', outputSummary: '',
        approvalRequired: false, createdAt: nowIso()
      }
      save('tasks', [...existing, task])
      return { kind: 'task' as const, task }
    }
  },
  memory: {
    list: async () => load<MemoryEntry[]>('memory', []),
    save: async (entry) => save('memory', [...load<MemoryEntry[]>('memory', []).filter((e) => e.id !== entry.id), entry]),
    remove: async (id) => { save('memory', load<MemoryEntry[]>('memory', []).filter((e) => e.id !== id)); return true }
  },
  usage: {
    list: async () => load<UsageRecord[]>('usage', [])
  },
  customAdapters: {
    list: async () => load<CustomAdapter[]>('customAdapters', []),
    save: async (adapter) => save('customAdapters', [...load<CustomAdapter[]>('customAdapters', []).filter((a) => a.id !== adapter.id), adapter]),
    remove: async (id) => { save('customAdapters', load<CustomAdapter[]>('customAdapters', []).filter((a) => a.id !== id)); return true }
  },
  system: {
    refreshPath: async () => ({ count: 0 }),
    pickFolder: async () => window.prompt('浏览器预览模式：请输入项目文件夹路径') ?? ''
  },
  credentials: {
    set: async (_secret, ref) => ref ?? newId('cred')
  },
  events: {
    list: async (limit = 300) => load('events', [] as AgentEvent[]).slice(0, limit),
    clear: async () => { save('events', []); return true },
    on: () => () => undefined
  },
  settings: {
    get: async () => load('settings', { defaultWorkspace: '', permissionMode: 'ask' }),
    set: async (patch) => save('settings', patch)
  },
  workspaces: {
    list: async () => load('workspaces', [] as Array<{ id: string; path: string; isolation: string }>),
    add: async (path) => {
      const workspace = { id: newId('ws'), path, isolation: 'none' }
      save('workspaces', [...load('workspaces', [] as Array<{ id: string; path: string; isolation: string }>), workspace])
      return workspace
    }
  }
} as DesktopApi

export const api = window.desktopApi ?? mockApi
export const isPreviewMode = !window.desktopApi
