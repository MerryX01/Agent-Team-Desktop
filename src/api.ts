import type { DesktopApi } from '../electron/preload/index'
import { DEFAULT_AGENTS, defaultPermissionPolicy, newId, nowIso } from '@shared/index'
import type {
  AgentDefinition, AgentEvent, AgentMessage, AgentProbeResult, ApiProvider, Approval, ChatRun, CustomAdapter, FileChange,
  MemoryEntry, ReviewCycle, Team, TeamMember, Task, Template, UsageRecord
} from '@shared/index'

const PREFIX = 'atd-demo-'
const mockListeners = new Set<(event: AgentEvent) => void>()

function emitMock(draft: Omit<AgentEvent, 'id' | 'timestamp'> & { data?: Record<string, unknown> }): AgentEvent {
  const event: AgentEvent = { ...draft, data: draft.data ?? {}, id: newId('event'), timestamp: nowIso() }
  const events = load<AgentEvent[]>('events', [])
  save('events', [...events, event].slice(-500))
  for (const listener of mockListeners) listener(event)
  return event
}

const PREVIEW_READY = new Set(['agent-opencode', 'agent-claude', 'agent-codex', 'agent-doubao'])
const PREVIEW_NO_QUOTA = new Set(['agent-minimax'])
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

function previewAgent(id: string): AgentDefinition | undefined {
  return load<AgentDefinition[]>('agents', DEFAULT_AGENTS).find((agent) => agent.id === id)
    ?? DEFAULT_AGENTS.find((agent) => agent.id === id)
}

function persistHealth(agentId: string, patch: Partial<AgentDefinition>) {
  const agents = load<AgentDefinition[]>('agents', DEFAULT_AGENTS)
  save('agents', agents.map((agent) => agent.id === agentId ? { ...agent, ...patch } : agent))
}

async function mockProbe(agentId: string): Promise<AgentProbeResult> {
  const agent = previewAgent(agentId)
  const name = agent?.name ?? agentId
  await sleep(500 + Math.random() * 700)
  let state: AgentProbeResult['state'] = 'not-installed'
  let detail = '浏览器预览模式：模拟未安装，桌面端会真实检测'
  let reply = ''
  if (PREVIEW_NO_QUOTA.has(agentId)) {
    state = 'no-quota'
    detail = '预览模式：模拟官方额度用尽，群聊会自动跳过'
  } else if (PREVIEW_READY.has(agentId)) {
    state = 'ready'
    detail = '预览模式：模拟真实应答'
    reply = `可用（${name} 预览应答）`
  }
  persistHealth(agentId, { health: state, healthDetail: detail, latencyMs: 600, lastProbeAt: nowIso() })
  return {
    agentId, agentName: name, vendor: agent?.vendor ?? '', role: agent?.role ?? '',
    state, latencyMs: 600 + Math.round(Math.random() * 400), reply, detail, checkedAt: nowIso()
  }
}

const PREVIEW_REPLIES: Record<string, string> = {
  architect: '结论：先稳住主链路，再做可视化协同。\n1. 群聊消息必须触发真实 Agent 调用，而不是只落库；\n2. 每个成员要独立流式回传思考与工具事件；\n3. 最后由 Lead 收口，门禁通过才算交付。\n\n@OpenCode 请补充前端实时轨迹的关键实现点。',
  developer: '实现要点：\n- 事件总线按 messageId 聚合，思考流与正文流分开渲染；\n- 并发上限 4，失败按额度/登录/超时归因并跳过；\n- 交付卡只在 gate.passed 时出现，否则显示阻塞原因。\n\n已把关键路径拆成 3 个可验证步骤。',
  reviewer: '风险与审查意见：\n1. 未体检的 Agent 不能算可用，需要真实探测；\n2. 无额度必须显式跳过，不能静默失败；\n3. 汇总失败时不能交付，应标记 partial 并列出原因。\n\n结论：需要修改（预览模拟，不阻断演示）。',
  qa: '验收步骤：\n1. 群聊发送指令后 3 秒内出现成员思考流；\n2. 无额度成员显示「已跳过 · 无额度」；\n3. 交付卡出现「已交付」且有完整 Markdown；\n4. 断开任一成员时，门禁显示禁止交付。'
}

async function mockDispatch(input: {
  teamId: string; content: string; targetAgentId?: string; maxParticipants?: number
}): Promise<{
  runId: string; chatRunId: string; taskId: string; status: ChatRun['status']; participants: ChatRun['participants'];
  deliverable: string; deliverableAgentId?: string; gate: ChatRun['gate']; durationMs: number
}> {
  const startedAt = Date.now()
  const runId = newId('run')
  const chatRunId = newId('chatrun')
  const taskId = newId('task')
  const team = load<Team[]>('teams', [seedTeam()]).find((item) => item.id === input.teamId) ?? seedTeam()
  const members = load<TeamMember[]>('members', []).filter((item) => item.teamId === team.id)
  const roster = (members.length ? members.map((member) => ({ agent: previewAgent(member.agentId), role: member.role })) : [
    { agent: previewAgent('agent-opencode'), role: 'developer' },
    { agent: previewAgent('agent-claude'), role: 'architect' },
    { agent: previewAgent('agent-codex'), role: 'reviewer' }
  ]).filter((item): item is { agent: AgentDefinition; role: string } => Boolean(item.agent))

  const pool = input.targetAgentId ? roster.filter((item) => item.agent.id === input.targetAgentId) : roster
  const selected = pool.slice(0, Math.max(1, input.maxParticipants ?? 4))
  const participants: ChatRun['participants'] = []
  for (const item of pool) {
    const inRound = selected.some((entry) => entry.agent.id === item.agent.id)
    const bad = PREVIEW_NO_QUOTA.has(item.agent.id) || !PREVIEW_READY.has(item.agent.id)
    participants.push({
      agentId: item.agent.id, name: item.agent.name, role: item.role,
      status: !inRound ? 'skipped' : bad ? 'skipped' : 'pending',
      reply: '', error: '', latencyMs: 0,
      skipReason: !inRound ? '本轮未入选（并发上限）' : bad ? (PREVIEW_NO_QUOTA.has(item.agent.id) ? '无额度（已跳过）' : '未安装（已跳过）') : ''
    })
  }

  const messages = load<AgentMessage[]>('messages', [])
  const userMessage: AgentMessage = {
    id: newId('msg'), teamId: team.id, runId, taskId, fromAgentId: 'user', sender: '群主',
    content: input.content, summary: input.content.slice(0, 60), kind: 'user', createdAt: nowIso()
  }
  save('messages', [...messages, userMessage])
  emitMock({
    type: 'chat.dispatch.started', message: `群聊协同开始（预览模拟）`,
    data: { chatRunId, runId, taskId, content: input.content, participants }
  })

  const speaking = participants.filter((item) => item.status === 'pending')
  for (const item of participants.filter((entry) => entry.status === 'skipped')) {
    emitMock({ type: 'chat.agent.skipped', agentId: item.agentId, message: `${item.name} 已跳过：${item.skipReason}`, data: { ...item } })
  }

  const replies: Array<{ agentId: string; name: string; role: string; content: string }> = []
  for (const [index, item] of speaking.entries()) {
    const messageId = newId('msg')
    item.status = 'replying'
    item.messageId = messageId
    emitMock({
      type: 'chat.agent.started', agentId: item.agentId, message: `${item.name} 开始思考`,
      data: { messageId, agentId: item.agentId, name: item.name, role: item.role, phase: 'connecting' }
    })
    await sleep(220)
    const thoughts = ['先理解群主目标与约束…', '对照自己的角色职责拆分要点…', '检查依赖与风险，准备结论…']
    for (const thought of thoughts) {
      emitMock({ type: 'chat.agent.thought', agentId: item.agentId, message: thought, data: { messageId, agentId: item.agentId, delta: thought } })
      await sleep(160)
    }
    emitMock({
      type: 'chat.agent.tool', agentId: item.agentId, message: '读取群聊上下文',
      data: { messageId, agentId: item.agentId, tool: '读取群聊上下文', status: 'running' }
    })
    const reply = PREVIEW_REPLIES[item.role] ?? PREVIEW_REPLIES.developer
    for (const chunk of reply.match(/[\s\S]{1,18}/g) ?? [reply]) {
      emitMock({ type: 'chat.agent.delta', agentId: item.agentId, message: chunk, data: { messageId, agentId: item.agentId, delta: chunk } })
      await sleep(28 + index * 6)
    }
    item.status = 'replied'
    item.reply = reply
    item.latencyMs = 900 + index * 300
    replies.push({ agentId: item.agentId, name: item.name, role: item.role, content: reply })
    save('messages', [...load<AgentMessage[]>('messages', []), {
      id: newId('msg'), teamId: team.id, runId, taskId, fromAgentId: item.agentId,
      content: reply, summary: `${item.role} · ${item.name}`, kind: 'coordination', createdAt: nowIso()
    }])
    emitMock({
      type: 'chat.agent.completed', agentId: item.agentId, message: `${item.name} 已回复`,
      data: { messageId, agentId: item.agentId, name: item.name, reply, latencyMs: item.latencyMs }
    })
  }

  const lead = speaking[0]
  const deliverable = replies.length
    ? [
        '## 结论',
        '群聊已具备真实协同能力：消息触达 Agent、过程可见、按额度跳过、门禁控制交付。',
        '',
        '## 分工与依据',
        ...replies.map((reply) => `- **${reply.name}（${reply.role}）**：${reply.content.split('\n')[0].replace(/^结论[：:]\s*/, '')}`),
        '',
        '## 风险与未完成项',
        PREVIEW_NO_QUOTA.size ? '- MiniMax Code 当前无额度，已在群聊中自动跳过。' : '- 无。',
        '- 本段为浏览器预览模拟，真实 CLI 结果以桌面端为准。',
        '',
        '## 下一步',
        '1. 在桌面端点击「全群体检」确认真实应答；',
        '2. 发送同一条指令，核对思考流与交付卡；',
        '3. 对失败成员按提示重新登录或补充额度。'
      ].join('\n')
    : ''
  if (deliverable && lead) {
    const messageId = newId('msg')
    for (const chunk of deliverable.match(/[\s\S]{1,24}/g) ?? [deliverable]) {
      emitMock({ type: 'chat.agent.delta', agentId: lead.agentId, message: chunk, data: { messageId, agentId: lead.agentId, delta: chunk, synthesis: true } })
      await sleep(18)
    }
    save('messages', [...load<AgentMessage[]>('messages', []), {
      id: newId('msg'), teamId: team.id, runId, taskId, fromAgentId: lead.agentId,
      content: deliverable, summary: '最终交付', kind: 'deliverable', createdAt: nowIso()
    }])
    emitMock({ type: 'chat.agent.completed', agentId: lead.agentId, message: `${lead.name} 已产出交付物`, data: { messageId, agentId: lead.agentId, reply: deliverable, synthesis: true } })
  }

  const failed = participants.filter((item) => item.status === 'failed')
  const repliedCount = participants.filter((item) => item.status === 'replied').length
  const passed = repliedCount > 0 && failed.length === 0 && deliverable.length > 20
  const gate: ChatRun['gate'] = {
    passed,
    reasons: passed ? [] : ['至少 1 个 Agent 完成应答：0 位应答'],
    checks: [
      { key: 'agents-replied', label: '至少 1 个 Agent 完成应答', ok: repliedCount > 0, detail: `${repliedCount} 位应答` },
      { key: 'no-failed', label: '应到成员无失败', ok: failed.length === 0, detail: failed.length ? '有成员失败' : '无失败' },
      { key: 'synthesis', label: 'Lead 已产出综合交付物', ok: deliverable.length > 20, detail: deliverable ? `${deliverable.length} 字` : '未生成' }
    ]
  }
  const result = {
    runId, chatRunId, taskId,
    status: (passed ? 'completed' : 'failed') as ChatRun['status'],
    participants, deliverable, deliverableAgentId: lead?.agentId, gate,
    durationMs: Date.now() - startedAt
  }
  const chatRun: ChatRun = {
    id: chatRunId, runId, teamId: team.id, content: input.content, status: result.status,
    participants, deliverable, deliverableAgentId: lead?.agentId,
    gate, durationMs: result.durationMs, createdAt: nowIso(), completedAt: nowIso()
  }
  save('chat_runs', [chatRun, ...load<ChatRun[]>('chat_runs', [])].slice(0, 30))
  emitMock({
    type: 'chat.dispatch.completed',
    message: passed ? '本轮协同完成，已生成交付物（预览模拟）' : `本轮未完成，禁止交付：${gate.reasons.join('；')}`,
    data: { result }
  })
  return result
}

const mockApi = {
  agents: {
    list: async () => load('agents', DEFAULT_AGENTS),
    save: async (agent) => save('agents', [...load('agents', DEFAULT_AGENTS).filter((a) => a.id !== agent.id), agent]),
    remove: async (id) => save('agents', load('agents', DEFAULT_AGENTS).filter((a) => a.id !== id)),
    detect: async (id) => PREVIEW_READY.has(id)
      ? { installed: true, version: 'preview', detail: '浏览器预览模式：模拟已安装' }
      : { installed: false, detail: '浏览器预览模式：不会启动本机 CLI' },
    detectAll: async () => Object.fromEntries(DEFAULT_AGENTS.map((agent) => [agent.id, {
      installed: PREVIEW_READY.has(agent.id),
      detail: PREVIEW_READY.has(agent.id) ? '预览模式模拟已安装' : '预览模式未安装'
    }])),
    loginStatus: async () => ({ state: 'unknown', detail: '浏览器预览模式：不检查登录状态' }),
    probe: async (id) => mockProbe(id),
    probeAll: async (teamId) => {
      const team = load<Team[]>('teams', [seedTeam()]).find((item) => item.id === teamId) ?? seedTeam()
      const members = load<TeamMember[]>('members', []).filter((item) => item.teamId === team.id)
      const ids = members.length ? members.map((item) => item.agentId) : DEFAULT_AGENTS.map((item) => item.id)
      const results: AgentProbeResult[] = []
      for (const agentId of ids) {
        const result = await mockProbe(agentId)
        results.push(result)
        emitMock({ type: 'probe.completed', agentId, message: `应答体检：${result.agentName} · ${result.state}`, data: { result } })
      }
      return results
    }
  },
  chat: {
    dispatch: async (input) => mockDispatch(input),
    runs: async (teamId) => load<ChatRun[]>('chat_runs', []).filter((run) => !teamId || run.teamId === teamId),
    cancel: async () => true
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
    list: async (limit = 300) => load('events', [] as AgentEvent[]).slice(-limit),
    clear: async () => { save('events', []); return true },
    on: (listener) => {
      mockListeners.add(listener)
      return () => { mockListeners.delete(listener) }
    }
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
