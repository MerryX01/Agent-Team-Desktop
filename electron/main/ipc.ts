import { ipcMain, dialog, type WebContents } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SqliteStore } from '@storage/index'
import type { AdapterRegistry } from '@adapters/index'
import { refreshPath } from '@adapters/index'
import type { Orchestrator } from '@orchestrator/index'
import { humanApprove, leadSignoff, requestReview, resolveReview, startReview } from '@orchestrator/review'
import { sendMessage } from '@orchestrator/messaging'
import { probeAgentOnce, probeAgents } from '@orchestrator/health'
import type { AgentDefinition, ApiProvider, ChatRun, Team, TeamMember, Task, Template, MemoryEntry, CustomAdapter, ReviewCycle } from '@shared/index'
import {
  AgentDefinitionSchema, ApiProviderSchema, TeamSchema, TaskSchema,
  TemplateSchema, MemoryEntrySchema, CustomAdapterSchema, newId, nowIso
} from '@shared/index'
import type { ElectronCredentialStore } from './credentials'

export const IPC = {
  AGENTS_LIST: 'agents:list',
  AGENTS_SAVE: 'agents:save',
  AGENTS_REMOVE: 'agents:remove',
  AGENTS_DETECT: 'agents:detect',
  AGENTS_LOGIN: 'agents:login',
  AGENTS_DETECT_ALL: 'agents:detectAll',
  AGENTS_PROBE: 'agents:probe',
  AGENTS_PROBE_ALL: 'agents:probeAll',
  CHAT_DISPATCH: 'chat:dispatch',
  CHAT_RUNS: 'chat:runs',
  CHAT_CANCEL: 'chat:cancel',
  PATH_REFRESH: 'system:refreshPath',
  PICK_FOLDER: 'system:pickFolder',
  CREDENTIALS_SET: 'credentials:set',
  PROVIDERS_MODELS: 'providers:models',
  PROVIDERS_LIST: 'providers:list',
  PROVIDERS_SAVE: 'providers:save',
  PROVIDERS_TEST: 'providers:test',
  PROVIDERS_REMOVE: 'providers:remove',
  TEAMS_LIST: 'teams:list',
  TEAMS_SAVE: 'teams:save',
  TEAMS_MEMBERS: 'teams:members',
  TEAMS_SET_MEMBERS: 'teams:setMembers',
  TASKS_LIST: 'tasks:list',
  TASKS_SAVE: 'tasks:save',
  TASKS_RUN: 'tasks:run',
  TASKS_RETRY: 'tasks:retry',
  TASKS_CANCEL: 'tasks:cancel',
  APPROVALS_LIST: 'approvals:list',
  APPROVALS_RESOLVE: 'approvals:resolve',
  FILES_LIST: 'files:list',
  MESSAGES_LIST: 'messages:list',
  MESSAGES_SEND: 'messages:send',
  REVIEWS_LIST: 'reviews:list',
  REVIEWS_REQUEST: 'reviews:request',
  REVIEWS_START: 'reviews:start',
  REVIEWS_RESOLVE: 'reviews:resolve',
  REVIEWS_LEAD_SIGNOFF: 'reviews:leadSignoff',
  REVIEWS_HUMAN_APPROVE: 'reviews:humanApprove',
  TEMPLATES_LIST: 'templates:list',
  TEMPLATES_SAVE: 'templates:save',
  TEMPLATES_APPLY: 'templates:apply',
  MEMORY_LIST: 'memory:list',
  MEMORY_SAVE: 'memory:save',
  MEMORY_REMOVE: 'memory:remove',
  USAGE_LIST: 'usage:list',
  CUSTOM_ADAPTERS_LIST: 'customAdapters:list',
  CUSTOM_ADAPTERS_SAVE: 'customAdapters:save',
  CUSTOM_ADAPTERS_REMOVE: 'customAdapters:remove',
  EVENTS_LIST: 'events:list',
  EVENTS_CLEAR: 'events:clear',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  WORKSPACES_LIST: 'workspaces:list',
  WORKSPACES_ADD: 'workspaces:add',
  EVENT: 'runtime:event'
} as const

function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***')
    .replace(/x-api-key:\s*[^\s"']+/gi, 'x-api-key: ***')
}

export function registerIpc(
  store: SqliteStore,
  registry: AdapterRegistry,
  orchestrator: Orchestrator,
  credentials: ElectronCredentialStore,
  getWebContents: () => WebContents | undefined,
  userDataPath: string
): void {
  const settingsFile = join(userDataPath, 'settings.json')
  const readSettings = () => existsSync(settingsFile)
    ? JSON.parse(readFileSync(settingsFile, 'utf8')) as Record<string, unknown>
    : {}
  const writeSettings = (patch: Record<string, unknown>) => {
    writeFileSync(settingsFile, JSON.stringify({ ...readSettings(), ...patch }, null, 2), 'utf8')
  }

  orchestrator.onEvent((event) => {
    getWebContents()?.send(IPC.EVENT, event)
  })

  ipcMain.handle(IPC.AGENTS_LIST, () => store.agents())
  ipcMain.handle(IPC.AGENTS_SAVE, (_event, input: unknown) => {
    const agent = AgentDefinitionSchema.parse(input)
    store.insert('agents', agent)
    return store.agents()
  })
  ipcMain.handle(IPC.AGENTS_REMOVE, (_event, agentId: string) => {
    store.remove('agents', 'id', agentId)
    for (const team of store.teams()) store.removeTeamMember(team.id, agentId)
    return store.agents()
  })
  ipcMain.handle(IPC.AGENTS_DETECT, async (_event, agentId: string) => registry.detect(agentId))
  ipcMain.handle(IPC.AGENTS_LOGIN, async (_event, agentId: string) => registry.loginStatus(agentId))

  ipcMain.handle(IPC.AGENTS_DETECT_ALL, async () => {
    const results: Record<string, { installed: boolean; detail?: string; version?: string }> = {}
    for (const agent of store.agents()) {
      results[agent.id] = await registry.detect(agent.id)
    }
    return results
  })

  /** 单个 Agent 的真实应答体检：真连一次、真发一句话。 */
  ipcMain.handle(IPC.AGENTS_PROBE, async (_event, input: { agentId: string; teamId?: string }) => {
    const team = input.teamId ? store.get<Team>('teams', 'id', input.teamId) : undefined
    const result = await probeAgentOnce(store, registry, input.agentId, { cwd: team?.defaultWorkspace })
    getWebContents()?.send(IPC.EVENT, {
      id: newId('event'), type: 'probe.completed', agentId: result.agentId,
      message: `应答体检：${result.agentName} · ${result.state}（${result.latencyMs}ms）`,
      data: { result }, timestamp: result.checkedAt
    })
    return result
  })

  /** 全群体检：并发可控，进度逐条推给渲染层。 */
  ipcMain.handle(IPC.AGENTS_PROBE_ALL, async (_event, input?: { teamId?: string; agentIds?: string[] }) => {
    const team = input?.teamId ? store.get<Team>('teams', 'id', input.teamId) : undefined
    return probeAgents(store, registry, {
      teamId: input?.teamId,
      agentIds: input?.agentIds,
      cwd: team?.defaultWorkspace,
      concurrency: 3,
      onResult: (result) => {
        getWebContents()?.send(IPC.EVENT, {
          id: newId('event'), type: 'probe.completed', agentId: result.agentId,
          message: `应答体检：${result.agentName} · ${result.state}（${result.latencyMs}ms）`,
          data: { result }, timestamp: result.checkedAt
        })
      }
    })
  })

  ipcMain.handle(IPC.CHAT_DISPATCH, async (_event, input: {
    teamId: string; content: string; targetAgentId?: string; cwd?: string; maxParticipants?: number
  }) => {
    const team = store.get<Team>('teams', 'id', input.teamId)
    if (!team) throw new Error('群聊不存在')
    return orchestrator.dispatchChat({
      ...input,
      cwd: input.cwd || team.defaultWorkspace || undefined
    })
  })
  ipcMain.handle(IPC.CHAT_RUNS, (_event, teamId?: string) => store.chatRuns(teamId) as ChatRun[])
  ipcMain.handle(IPC.CHAT_CANCEL, (_event, runId: string) => orchestrator.cancelRun(runId))

  ipcMain.handle(IPC.PATH_REFRESH, async () => ({ count: (await refreshPath()).length }))
  ipcMain.handle(IPC.PICK_FOLDER, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择群聊项目文件夹' })
    return result.canceled || !result.filePaths.length ? '' : result.filePaths[0]
  })
  ipcMain.handle(IPC.CREDENTIALS_SET, (_event, input: { ref?: string; secret: string }) => {
    const ref = input.ref || newId('cred')
    credentials.set(ref, input.secret)
    return ref
  })

  ipcMain.handle(IPC.PROVIDERS_LIST, () => store.providers().map((provider) => ({
    ...provider,
    hasKey: Boolean(credentials.get(provider.credentialRef))
  })))
  ipcMain.handle(IPC.PROVIDERS_SAVE, (_event, input: { provider: unknown; apiKey?: string }) => {
    const provider = ApiProviderSchema.parse(input.provider)
    if (input.apiKey) {
      if (!credentials.get(provider.credentialRef)) {
        provider.credentialRef = newId('cred')
      }
      credentials.set(provider.credentialRef, input.apiKey)
    }
    store.insert('api_providers', provider)
    if (!input.apiKey && !credentials.get(provider.credentialRef)) {
      throw new Error('首次添加 Provider 必须提供 API Key')
    }
    return store.providers().map((item) => ({ ...item, hasKey: Boolean(credentials.get(item.credentialRef)) }))
  })
  ipcMain.handle(IPC.PROVIDERS_TEST, async (_event, input: { id: string; apiKey?: string }) => {
    const provider = store.get<ApiProvider>('api_providers', 'id', input.id)
    if (!provider) throw new Error('Provider 不存在')
    const key = input.apiKey || credentials.get(provider.credentialRef) || ''
    if (!key) return { ok: false, detail: '未提供 API Key' }
    const result = await registry.api.testConnection(provider, key)
    store.update('api_providers', 'id', input.id, { verified: result.ok })
    return { ok: result.ok, detail: redact(result.detail) }
  })
  ipcMain.handle(IPC.PROVIDERS_MODELS, async (_event, input: { id: string; apiKey?: string }) => {
    const provider = store.get<ApiProvider>('api_providers', 'id', input.id)
    if (!provider) throw new Error('Provider 不存在')
    const key = input.apiKey || credentials.get(provider.credentialRef) || ''
    if (!key) return []
    const models = await registry.api.listModels(provider, key)
    store.update('api_providers', 'id', input.id, { models })
    return models
  })
  ipcMain.handle(IPC.PROVIDERS_REMOVE, (_event, id: string) => {
    const provider = store.get<ApiProvider>('api_providers', 'id', id)
    if (provider) credentials.delete(provider.credentialRef)
    store.remove('api_providers', 'id', id)
    return true
  })

  ipcMain.handle(IPC.TEAMS_LIST, () => store.teams())
  ipcMain.handle(IPC.TEAMS_SAVE, (_event, input: unknown) => {
    const team = TeamSchema.parse(input)
    store.insert('teams', team)
    return store.teams()
  })
  ipcMain.handle(IPC.TEAMS_MEMBERS, (_event, teamId: string) => store.teamMembers(teamId))
  ipcMain.handle(IPC.TEAMS_SET_MEMBERS, (_event, input: { teamId: string; members: TeamMember[] }) => {
    store.remove('team_members', 'teamId', input.teamId)
    for (const member of input.members) {
      store.insert('team_members', { ...member, teamId: input.teamId })
    }
    return store.teamMembers(input.teamId)
  })

  ipcMain.handle(IPC.TASKS_LIST, (_event, teamId?: string) => store.tasks(teamId))
  ipcMain.handle(IPC.TASKS_SAVE, (_event, input: unknown) => {
    const task = TaskSchema.parse(input)
    store.insert('tasks', task)
    for (const dep of task.dependsOn ?? []) {
      store.insert('task_dependencies', { taskId: task.taskId, dependsOn: dep })
    }
    return store.tasks(task.teamId)
  })
  ipcMain.handle(IPC.TASKS_RUN, (_event, input: { teamId: string; taskIds: string[]; cwd: string }) => orchestrator.run(input))
  ipcMain.handle(IPC.TASKS_RETRY, (_event, input: { taskId: string; teamId: string; cwd: string }) => {
    const task = store.get<Task>('tasks', 'taskId', input.taskId)
    if (!task) throw new Error('任务不存在')
    return orchestrator.retryTask(input.taskId, input.teamId, task.cwd || input.cwd)
  })
  ipcMain.handle(IPC.TASKS_CANCEL, (_event, runId: string) => orchestrator.cancelRun(runId))

  ipcMain.handle(IPC.APPROVALS_LIST, () => store.approvals())
  ipcMain.handle(IPC.APPROVALS_RESOLVE, (_event, input: { id: string; decision: 'approved' | 'rejected' }) => {
    return orchestrator.resolveApproval(input.id, input.decision)
  })

  ipcMain.handle(IPC.FILES_LIST, (_event, input?: { runId?: string; taskId?: string }) =>
    store.fileChanges(input?.runId, input?.taskId))

  ipcMain.handle(IPC.MESSAGES_LIST, (_event, input?: { teamId?: string; taskId?: string }) =>
    store.messages(input?.teamId, input?.taskId))
  ipcMain.handle(IPC.MESSAGES_SEND, (_event, input: Parameters<typeof sendMessage>[1]) => {
    const message = sendMessage(store, input)
    getWebContents()?.send(IPC.EVENT, {
      id: message.id, type: 'message.sent', message: message.summary || message.content,
      data: { teamId: message.teamId, taskId: message.taskId }, timestamp: message.createdAt
    })
    return message
  })
  ipcMain.handle(IPC.REVIEWS_LIST, (_event, taskId?: string) => store.reviews(taskId))
  ipcMain.handle(IPC.REVIEWS_REQUEST, (_event, input: { taskId: string; reviewerAgentId?: string; requesterAgentId?: string; runId?: string }) => {
    const team = store.get<Team>('teams', 'id', store.get<Task>('tasks', 'taskId', input.taskId)?.teamId ?? '')
    const cycle = requestReview(store, input.taskId, { ...input, actorName: '用户', team })
    return cycle
  })
  ipcMain.handle(IPC.REVIEWS_START, (_event, cycleId: string) => startReview(store, cycleId))
  ipcMain.handle(IPC.REVIEWS_RESOLVE, (_event, input: { cycleId: string; decision: 'approve' | 'changes_requested'; summary?: string; findings?: string }) => {
    const cycle = store.get<ReviewCycle>('review_cycles', 'id', input.cycleId)
    if (!cycle) throw new Error('审查记录不存在')
    const task = store.get<Task>('tasks', 'taskId', cycle.taskId)
    const team = task ? store.get<Team>('teams', 'id', task.teamId) : undefined
    return resolveReview(store, input.cycleId, input.decision, {
      summary: input.summary, findings: input.findings, actorId: 'user', team
    })
  })
  ipcMain.handle(IPC.REVIEWS_LEAD_SIGNOFF, (_event, input: { cycleId: string; decision: 'approve' | 'reject' }) =>
    leadSignoff(store, input.cycleId, input.decision, { actorId: 'user' }))
  ipcMain.handle(IPC.REVIEWS_HUMAN_APPROVE, (_event, taskId: string) => humanApprove(store, taskId, { actorId: 'user' }).task)

  ipcMain.handle(IPC.TEMPLATES_LIST, (_event, kind?: Template['kind']) => store.templates(kind))
  ipcMain.handle(IPC.TEMPLATES_SAVE, (_event, input: unknown) => {
    const template = TemplateSchema.parse(input)
    store.insert('templates', template)
    return store.templates()
  })
  ipcMain.handle(IPC.TEMPLATES_APPLY, (_event, input: { templateId: string; teamId?: string; title?: string }) => {
    const template = store.get<Template>('templates', 'id', input.templateId)
    if (!template) throw new Error('模板不存在')
    if (template.kind === 'team') {
      const payload = template.payload as unknown as { team?: Partial<Team>; members?: TeamMember[] }
      const team: Team = {
        ...TeamSchema.parse({
          id: newId('team'), name: template.name,
          description: template.description, defaultWorkspace: '', maxConcurrency: 2,
          permissionMode: 'ask', isolation: 'none', policy: {}
        }),
        ...payload.team,
        id: newId('team')
      }
      const members = (payload.members ?? []).map((member) => ({ ...member, teamId: team.id }))
      store.insert('teams', team)
      for (const member of members) store.insert('team_members', member)
      return { kind: 'team', team, members }
    }
    const payload = template.payload as unknown as Partial<Task>
    const task: Task = {
      taskId: newId('task'), teamId: input.teamId ?? 'team-default',
      title: input.title ?? template.name, description: template.description,
      assigneeAgentId: payload.assigneeAgentId, status: 'pending', priority: payload.priority ?? 0,
      dependsOn: payload.dependsOn ?? [], inputContext: payload.inputContext ?? '',
      outputSummary: '', approvalRequired: payload.approvalRequired ?? false,
      workspaceId: payload.workspaceId, cwd: payload.cwd, createdAt: nowIso()
    }
    store.insert('tasks', task)
    return { kind: 'task', task }
  })

  ipcMain.handle(IPC.MEMORY_LIST, (_event, input?: { scope?: MemoryEntry['scope']; scopeId?: string }) =>
    store.memory(input?.scope, input?.scopeId))
  ipcMain.handle(IPC.MEMORY_SAVE, (_event, input: unknown) => {
    const entry = MemoryEntrySchema.parse(input)
    store.insert('memory_entries', entry)
    return store.memory()
  })
  ipcMain.handle(IPC.MEMORY_REMOVE, (_event, id: string) => {
    store.remove('memory_entries', 'id', id)
    return true
  })
  ipcMain.handle(IPC.USAGE_LIST, (_event, agentId?: string) => store.usage(agentId))

  ipcMain.handle(IPC.CUSTOM_ADAPTERS_LIST, () => store.customAdapters())
  ipcMain.handle(IPC.CUSTOM_ADAPTERS_SAVE, (_event, input: unknown) => {
    const adapter = CustomAdapterSchema.parse(input)
    store.insert('custom_adapters', adapter)
    return store.customAdapters()
  })
  ipcMain.handle(IPC.CUSTOM_ADAPTERS_REMOVE, (_event, id: string) => {
    store.remove('custom_adapters', 'id', id)
    return true
  })

  ipcMain.handle(IPC.EVENTS_LIST, (_event, limit?: number) => store.events(limit ?? 300))
  ipcMain.handle(IPC.EVENTS_CLEAR, () => { store.clearEvents(); return true })

  ipcMain.handle(IPC.SETTINGS_GET, () => readSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_event, patch: Record<string, unknown>) => {
    writeSettings(patch)
    return readSettings()
  })
  ipcMain.handle(IPC.WORKSPACES_LIST, () => store.all('workspaces'))
  ipcMain.handle(IPC.WORKSPACES_ADD, (_event, input: { path: string; isolation?: string }) => {
    const workspace = {
      id: newId('ws'), path: input.path, gitInfo: null,
      isolation: input.isolation ?? 'none', createdAt: nowIso()
    }
    store.insert('workspaces', workspace)
    return workspace
  })
}
