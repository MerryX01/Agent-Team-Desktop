import { defineStore } from 'pinia'
import { api } from '../api'
import type { AgentDefinition, AgentEvent, ApiProvider, Approval, CustomAdapter, FileChange, MemoryEntry, ReviewCycle, Team, TeamMember, Task, Template, UsageRecord, AgentMessage } from '@shared/index'
import { newId, nowIso } from '@shared/index'

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
    notice: ''
  }),
  getters: {
    currentTeam(state) { return state.teams.find((team) => team.id === state.currentTeamId) ?? state.teams[0] },
    teamTasks(state) { return state.tasks.filter((task) => task.teamId === state.currentTeamId) },
    agentById: (state) => (id?: string) => state.agents.find((agent) => agent.id === id),
    pendingApprovals(state) { return state.approvals.filter((item) => item.status === 'pending') }
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
    },
    subscribeEvents() {
      return api.events.on((event) => {
        this.events.push(event)
        if (event.type === 'agent.permission.required') void this.loadApprovals()
        if (event.type.startsWith('review.')) void this.loadReviews()
        if (event.type === 'message.sent') void this.loadMessages()
      })
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
