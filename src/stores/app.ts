import { defineStore } from 'pinia'
import { api } from '../api'
import type { AgentDefinition, AgentEvent, AgentProbeResult, ApiProvider, Approval, ChatRun, CustomAdapter, FileChange, MemoryEntry, ReviewCycle, Team, TeamMember, Task, Template, UsageRecord, AgentMessage } from '@shared/index'
import { newId, nowIso } from '@shared/index'

export interface LiveChatAgent {
  messageId: string
  agentId: string
  name: string
  role: string
  phase: 'connecting' | 'replying' | 'synthesis' | 'completed' | 'failed'
  output: string
  thought: string
  tools: Array<{ name: string; status: string }>
  startedAt: number
  synthesis?: boolean
  error?: string
}

export const useAppStore = defineStore('app', {
  state: () => ({
    agents: [] as AgentDefinition[],
    providers: [] as Array<ApiProvider & { hasKey?: boolean }>,
    teams: [] as Team[],
    members: [] as TeamMember[],
    tasks: [] as Task[],
    events: [] as AgentEvent[],
    approvals: [] as Approval[],
    files: [] as FileChange[],
    templates: [] as Template[],
    memory: [] as MemoryEntry[],
    usage: [] as UsageRecord[],
    customAdapters: [] as CustomAdapter[],
    messages: [] as AgentMessage[],
    reviews: [] as ReviewCycle[],
    settings: {} as Record<string, unknown>,
    currentTeamId: 'team-default',
    currentRunId: '',
    busy: false,
    notice: '',
    chatRun: null as ChatRun | null,
    chatLive: {} as Record<string, LiveChatAgent>,
    probes: [] as AgentProbeResult[],
    probing: false,
    dispatching: false,
    activeChatRunId: ''
  }),
  getters: {
    currentTeam(state) { return state.teams.find((team) => team.id === state.currentTeamId) ?? state.teams[0] },
    teamTasks(state) { return state.tasks.filter((task) => task.teamId === state.currentTeamId) },
    agentById: (state) => (id?: string) => state.agents.find((agent) => agent.id === id),
    pendingApprovals(state) { return state.approvals.filter((item) => item.status === 'pending') },
    chatLiveList(state) {
      return Object.values(state.chatLive).sort((a, b) => a.startedAt - b.startedAt)
    },
    readyAgents(state) { return state.agents.filter((agent) => agent.enabled && agent.health === 'ready') }
  },
  actions: {
    async refresh() {
      this.agents = await api.agents.list()
      this.providers = await api.providers.list()
      this.teams = await api.teams.list()
      this.tasks = await api.tasks.list()
      this.events = await api.events.list(300)
      this.approvals = await api.approvals.list()
      this.files = await api.files.list()
      await this.loadAuxiliary()
      await this.loadMessages()
      await this.loadReviews()
      this.settings = await api.settings.get()
      if (!this.teams.some((team) => team.id === this.currentTeamId) && this.teams[0]) {
        this.currentTeamId = this.teams[0].id
      }
      this.members = await api.teams.members(this.currentTeamId)
      await this.loadChatRuns()
    },
    subscribeEvents() {
      return api.events.on((event) => {
        this.events.push(event)
        if (event.type === 'agent.permission.required') void this.loadApprovals()
        if (event.type.startsWith('review.')) void this.loadReviews()
        if (event.type === 'message.sent') void this.loadMessages()
        this.applyChatEvent(event)
      })
    },
    applyChatEvent(event: AgentEvent) {
      const data = event.data as Record<string, unknown>
      if (event.type === 'probe.completed') {
        const result = data.result as AgentProbeResult | undefined
        if (result) {
          this.probes = [...this.probes.filter((item) => item.agentId !== result.agentId), result]
          const agent = this.agents.find((item) => item.id === result.agentId)
          if (agent) {
            agent.health = result.state
            agent.healthDetail = result.detail
            agent.latencyMs = result.latencyMs
            agent.lastProbeAt = result.checkedAt
          }
        }
        return
      }
      if (event.type === 'chat.dispatch.started') {
        const participants = (data.participants as ChatRun['participants']) ?? []
        this.chatLive = {}
        this.activeChatRunId = String(data.runId ?? '')
        this.chatRun = {
          id: String(data.chatRunId ?? ''), runId: String(data.runId ?? ''),
          teamId: this.currentTeamId, content: String(data.content ?? ''),
          status: 'running', participants, deliverable: '',
          deliverableAgentId: undefined, deliverableMessageId: undefined,
          gate: { passed: false, reasons: [], checks: [] },
          durationMs: 0, createdAt: nowIso()
        }
        return
      }
      if (event.type === 'chat.agent.started') {
        const messageId = String(data.messageId ?? '')
        if (!messageId) return
        this.chatLive = {
          ...this.chatLive,
          [messageId]: {
            messageId, agentId: String(data.agentId ?? ''), name: String(data.name ?? ''),
            role: String(data.role ?? ''), phase: (data.phase as LiveChatAgent['phase']) ?? 'connecting',
            output: '', thought: '', tools: [], startedAt: Date.now(),
            synthesis: Boolean(data.synthesis)
          }
        }
        return
      }
      if (event.type === 'chat.agent.delta' || event.type === 'chat.agent.thought' || event.type === 'chat.agent.tool') {
        const messageId = String(data.messageId ?? '')
        const live = this.chatLive[messageId]
        if (!live) return
        if (event.type === 'chat.agent.delta') {
          live.output += String(data.delta ?? '')
          live.phase = live.synthesis ? 'synthesis' : 'replying'
        } else if (event.type === 'chat.agent.thought') {
          live.thought += String(data.delta ?? '')
        } else {
          const tool = { name: String(data.tool ?? event.message), status: String(data.status ?? 'running') }
          const existing = live.tools.findIndex((item) => item.name === tool.name && item.status === 'running')
          if (tool.status === 'done' && existing >= 0) live.tools[existing] = tool
          else live.tools.push(tool)
        }
        this.chatLive = { ...this.chatLive }
        return
      }
      if (event.type === 'chat.agent.completed') {
        const messageId = String(data.messageId ?? '')
        const live = this.chatLive[messageId]
        if (live) {
          live.phase = 'completed'
          if (data.reply) live.output = String(data.reply)
          this.chatLive = { ...this.chatLive }
        }
        void this.loadMessages()
        return
      }
      if (event.type === 'chat.agent.failed') {
        const messageId = String(data.messageId ?? '')
        const live = this.chatLive[messageId]
        if (live) {
          live.phase = 'failed'
          live.error = String(data.error ?? event.message)
          this.chatLive = { ...this.chatLive }
        }
        return
      }
      if (event.type === 'chat.dispatch.completed') {
        const result = data.result as {
          runId: string; chatRunId: string; status: ChatRun['status']; participants: ChatRun['participants']
          deliverable: string; deliverableAgentId?: string; gate: ChatRun['gate']; durationMs: number
        } | undefined
        if (result) {
          this.chatRun = {
            id: result.chatRunId, runId: result.runId, teamId: this.currentTeamId,
            content: this.chatRun?.content ?? '', status: result.status,
            participants: result.participants, deliverable: result.deliverable,
            deliverableAgentId: result.deliverableAgentId,
            deliverableMessageId: undefined, gate: result.gate,
            durationMs: result.durationMs, createdAt: this.chatRun?.createdAt ?? nowIso(), completedAt: nowIso()
          }
          this.notice = result.gate.passed
            ? `本轮协同完成，已交付（${Math.round(result.durationMs / 1000)}s）`
            : `本轮未完成，禁止交付：${result.gate.reasons.join('；')}`
        }
        this.dispatching = false
        this.activeChatRunId = ''
        void Promise.all([this.loadMessages(), this.loadChatRuns(), this.refresh()])
      }
    },
    async loadAuxiliary() {
      this.templates = await api.templates.list()
      this.memory = await api.memory.list()
      this.usage = await api.usage.list()
      this.customAdapters = await api.customAdapters.list()
    },
    async loadApprovals() { this.approvals = await api.approvals.list() },
    async detectAgent(id: string) {
      const result = await api.agents.detect(id)
      await this.refresh()
      return result
    },
    async checkLogin(id: string) { return api.agents.loginStatus(id) },
    async saveAgent(agent: AgentDefinition) {
      this.agents = await api.agents.save(agent)
    },
    async removeAgent(id: string) {
      this.agents = await api.agents.remove(id)
      this.notice = '成员已删除'
      await this.refresh()
    },
    async saveProvider(provider: Partial<ApiProvider>, apiKey?: string) {
      this.providers = await api.providers.save(provider, apiKey)
    },
    async testProvider(id: string, apiKey?: string) { return api.providers.test(id, apiKey) },
    async removeProvider(id: string) { await api.providers.remove(id); await this.refresh() },
    async saveTeam(team: Team) {
      this.teams = await api.teams.save(team)
      this.currentTeamId = team.id
    },
    async setMembers(members: TeamMember[]) {
      this.members = await api.teams.setMembers(this.currentTeamId, members)
    },
    async saveTask(task: Partial<Task>) {
      const full: Task = {
        taskId: task.taskId ?? newId('task'),
        teamId: task.teamId ?? this.currentTeamId,
        parentTaskId: task.parentTaskId,
        title: task.title ?? '未命名任务',
        description: task.description ?? '',
        assigneeAgentId: task.assigneeAgentId,
        actionMode: task.actionMode ?? 'do', boardColumn: task.boardColumn ?? 'todo',
        reviewState: task.reviewState ?? 'none', status: task.status ?? 'pending',
        priority: task.priority ?? 0,
        dependsOn: task.dependsOn ?? [],
        inputContext: task.inputContext ?? '',
        outputSummary: task.outputSummary ?? '',
        workspaceId: task.workspaceId,
        cwd: task.cwd,
        approvalRequired: task.approvalRequired ?? false,
        errorMessage: task.errorMessage,
        createdAt: task.createdAt ?? nowIso(),
        startedAt: task.startedAt,
        completedAt: task.completedAt
      }
      this.tasks = await api.tasks.save(full)
    },
    async runTasks(taskIds: string[]) {
      if (!this.currentTeam || taskIds.length === 0) return
      this.busy = true
      try {
        const result = await api.tasks.run(this.currentTeam.id, taskIds, String(this.settings.defaultWorkspace ?? ''))
        this.currentRunId = result.runId
        await this.refresh()
        this.notice = `运行完成：成功 ${result.completed.length}，失败 ${result.failed.length}，取消 ${result.cancelled.length}`
      } finally {
        this.busy = false
      }
    },
    async retryTask(taskId: string) {
      if (!this.currentTeam) return
      this.busy = true
      try {
        await api.tasks.retry(taskId, this.currentTeam.id, String(this.settings.defaultWorkspace ?? ''))
        await this.refresh()
      } finally { this.busy = false }
    },
    async cancelRun() {
      if (!this.currentRunId) return
      await api.tasks.cancel(this.currentRunId)
      this.notice = '已发送取消请求'
    },
    async resolveApproval(id: string, decision: 'approved' | 'rejected') {
      await api.approvals.resolve(id, decision)
      await this.loadApprovals()
    },
    async saveSettings(patch: Record<string, unknown>) {
      this.settings = await api.settings.set(patch)
      this.notice = '设置已保存'
    },
    async saveTemplate(kind: 'team' | 'task', name: string, payload: Record<string, unknown>, description = '') {
      const template: Template = { id: newId('template'), kind, name, description, payload, createdAt: nowIso() }
      this.templates = await api.templates.save(template)
    },
    async applyTemplate(id: string, options?: { teamId?: string; title?: string }) {
      await api.templates.apply(id, options)
      await this.refresh()
      this.notice = '模板已应用'
    },
    async saveMemory(scope: MemoryEntry['scope'], scopeId: string, key: string, value: string, source = '手动记录') {
      const entry: MemoryEntry = { id: newId('memory'), scope, scopeId, key, value, source, createdAt: nowIso() }
      this.memory = await api.memory.save(entry)
    },
    async removeMemory(id: string) { await api.memory.remove(id); await this.loadAuxiliary() },
    async saveCustomAdapter(adapter: CustomAdapter) {
      this.customAdapters = await api.customAdapters.save(adapter)
    },
    async removeCustomAdapter(id: string) { await api.customAdapters.remove(id); await this.loadAuxiliary() },
    async refreshPaths() {
      const result = await api.system.refreshPath()
      this.notice = `PATH 已刷新，共 ${result.count} 个条目`
    },
    async loadMessages() { this.messages = await api.messages.list(this.currentTeamId) },
    async loadReviews() { this.reviews = await api.reviews.list() },
    async loadChatRuns() {
      const runs = await api.chat.runs(this.currentTeamId)
      if (!this.dispatching) this.chatRun = runs[0] ?? null
    },
    async dispatchChat(content: string, targetAgentId?: string) {
      if (!this.currentTeam || this.dispatching) return
      this.dispatching = true
      this.chatLive = {}
      this.notice = ''
      try {
        const result = await api.chat.dispatch({
          teamId: this.currentTeam.id,
          content,
          targetAgentId,
          cwd: this.currentTeam.defaultWorkspace || String(this.settings.defaultWorkspace ?? '') || undefined
        })
        this.chatRun = {
          id: result.chatRunId, runId: result.runId, teamId: this.currentTeam.id, content,
          status: result.status, participants: result.participants,
          deliverable: result.deliverable, deliverableAgentId: result.deliverableAgentId,
          gate: result.gate, durationMs: result.durationMs, createdAt: nowIso(), completedAt: nowIso()
        }
        if (!result.gate.passed && !this.notice) {
          this.notice = `本轮未完成，禁止交付：${result.gate.reasons.join('；')}`
        }
        await Promise.all([this.loadMessages(), this.loadChatRuns(), this.refresh()])
        return result
      } catch (error) {
        this.notice = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        this.dispatching = false
      }
    },
    async cancelChat() {
      if (!this.activeChatRunId) return
      await api.chat.cancel(this.activeChatRunId)
      this.notice = '已发送取消请求'
    },
    async probeAll() {
      if (this.probing) return
      this.probing = true
      try {
        const results = await api.agents.probeAll(this.currentTeamId)
        this.probes = results
        await this.refresh()
        const ready = results.filter((item) => item.state === 'ready').length
        const skipped = results.filter((item) => item.state !== 'ready').length
        this.notice = `体检完成：${ready} 个可用，${skipped} 个跳过（无额度/未登录/未安装等，详见列表）`
        return results
      } finally {
        this.probing = false
      }
    },
    async probeAgent(agentId: string) {
      const result = await api.agents.probe(agentId, this.currentTeamId)
      this.probes = [...this.probes.filter((item) => item.agentId !== agentId), result]
      await this.refresh()
      return result
    },
    async sendMessage(input: Omit<AgentMessage, 'id' | 'createdAt'>) {
      await api.messages.send(input)
      await this.loadMessages()
    },
    async requestReview(taskId: string, reviewerAgentId?: string) {
      await api.reviews.request(taskId, { reviewerAgentId, requesterAgentId: 'user' })
      await Promise.all([this.loadReviews(), this.refresh()])
      this.notice = '已请求审查'
    },
    async resolveReview(cycleId: string, decision: 'approve' | 'changes_requested', options?: { summary?: string; findings?: string }) {
      const result = await api.reviews.resolve(cycleId, decision, options)
      await Promise.all([this.loadReviews(), this.refresh()])
      this.notice = `审查完成，下一阶段：${result.nextStage}`
    },
    async leadSignoff(cycleId: string, decision: 'approve' | 'reject') {
      await api.reviews.leadSignoff(cycleId, decision)
      await this.loadReviews()
    },
    async humanApprove(taskId: string) {
      await api.reviews.humanApprove(taskId)
      await Promise.all([this.loadReviews(), this.refresh()])
      this.notice = '已人工批准'
    },
    async clearEvents() { await api.events.clear(); this.events = [] }
  }
})
