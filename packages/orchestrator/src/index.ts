import type { SqliteStore } from '@storage/index'
import type { AdapterRegistry, ApprovalDecision, ApprovalRequest, EventDraft } from '@adapters/index'
import { diffSnapshots, snapshotWorkspace } from '@adapters/index'
import type { AgentDefinition, FileChange, Task, Team, UsageRecord } from '@shared/index'
import { newId, nowIso } from '@shared/index'
import { buildMemoryContext, saveMemory } from './memory'
import { buildDependencyNotice, buildRosterBriefing, buildTaskBriefing } from './briefing'
import { isDelegateMode, isReadOnlyMode, resolveActionMode } from './actionMode'
import { buildMessageContext, notifyDependencyResolved, sendMessage } from './messaging'
import { buildReviewPrompt, requestReview, resolveReview, resolveReviewFlow, startReview } from './review'
import { createWorktree, removeWorktree } from './worktree'
import { recordUsage } from './usage'

export * from './worktree'
export * from './templates'
export * from './memory'
export * from './usage'
export * from './briefing'
export * from './actionMode'
export * from './review'
export * from './messaging'

export interface RunOptions {
  teamId: string
  taskIds: string[]
  cwd: string
  onEvent?: (event: RuntimeEvent) => void
}

export interface RunResult {
  runId: string
  completed: string[]
  failed: string[]
  cancelled: string[]
}

type RuntimeEvent = EventDraft & { runId?: string; taskId?: string; id?: string; timestamp?: string }
type Listener = (event: RuntimeEvent) => void

function topoSort(tasks: Task[]): string[] {
  const byId = new Map(tasks.map((task) => [task.taskId, task]))
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const result: string[] = []
  const visit = (id: string) => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`任务依赖存在环: ${id}`)
    const task = byId.get(id)
    if (!task) throw new Error(`任务不存在: ${id}`)
    visiting.add(id)
    for (const dep of task.dependsOn ?? []) visit(dep)
    visiting.delete(id)
    visited.add(id)
    result.push(id)
  }
  for (const task of tasks) visit(task.taskId)
  return result
}

function rolePrompt(role: string, task: Task, upstream: Task[], memoryContext = ''): string {
  const context = upstream.length
    ? `\n\n上游任务结果（共享上下文）:\n${upstream.map((item) => `- ${item.title}: ${item.outputSummary || '(无输出)'}`).join('\n')}`
    : ''
  const rules: Record<string, string> = {
    planner: '你是规划者。只输出拆解后的任务清单与依赖，不要直接修改文件。',
    developer: '你是开发者。仅在工作目录内实现任务要求，修改文件前遵守权限策略。',
    reviewer: '你是审查者。只审查上游结果并列出问题与建议，不要修改任何文件。',
    tester: '你是测试者。给出可执行的验证步骤与预期结果，不要修改生产代码。',
    documenter: '你是文档撰写者。只整理清晰简洁的文档内容。'
  }
  return `${rules[role] ?? '请完成以下任务。'}\n\n任务标题: ${task.title}\n任务描述: ${task.description}${task.inputContext ? `\n补充上下文:\n${task.inputContext}` : ''}${context}${memoryContext ? `\n\n团队长期记忆:\n${memoryContext}` : ''}`
}

export class Orchestrator {
  private readonly listeners = new Set<Listener>()
  private readonly pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>()
  private readonly cancelledRuns = new Set<string>()
  private readonly activeSessions = new Map<string, Set<string>>()

  constructor(private readonly store: SqliteStore, private readonly registry: AdapterRegistry) {}

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(draft: EventDraft, runId?: string, taskId?: string): void {
    const event = this.registry.emitEvent(draft, { runId, taskId })
    for (const listener of this.listeners) listener({ ...draft, runId, taskId, id: event.id, timestamp: event.timestamp })
  }

  async requestApproval(request: ApprovalRequest, timeoutMs = 300000): Promise<ApprovalDecision> {
    const id = newId('approval')
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString()
    this.store.insert('approvals', {
      id, runId: request.runId, taskId: request.taskId, agentId: request.agentId,
      title: request.title, detail: request.detail, kind: request.kind ?? 'other',
      risk: request.risk ?? 'medium', path: request.path, command: request.command,
      reason: request.reason, status: 'pending', createdAt, expiresAt
    })
    this.emit({
      type: 'agent.permission.required', agentId: request.agentId,
      message: `${request.risk === 'high' ? '[高风险] ' : ''}${request.title}`,
      data: { approvalId: id, kind: request.kind, risk: request.risk, path: request.path, command: request.command, reason: request.reason }
    }, request.runId, request.taskId)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(id)
        this.store.update('approvals', 'id', id, { status: 'expired', resolvedAt: nowIso() })
        resolve('rejected')
      }, timeoutMs)
      this.pendingApprovals.set(id, (decision) => {
        clearTimeout(timer)
        resolve(decision)
      })
    })
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    const resolve = this.pendingApprovals.get(id)
    if (!resolve) return false
    this.pendingApprovals.delete(id)
    this.store.update('approvals', 'id', id, { status: decision === 'approved' ? 'approved' : 'rejected', resolvedAt: nowIso() })
    resolve(decision)
    return true
  }

  cancelRun(runId: string): boolean {
    this.cancelledRuns.add(runId)
    const sessions = this.activeSessions.get(runId)
    if (sessions) {
      for (const sessionId of sessions) void this.registry.cancel(sessionId)
    }
    return true
  }

  private async executeTask(task: Task, team: Team, runId: string): Promise<boolean> {
    const started = nowIso()
    this.store.update('tasks', 'taskId', task.taskId, { status: 'running', startedAt: started, errorMessage: null })
    this.emit({ type: 'task.started', agentId: task.assigneeAgentId, message: `任务开始: ${task.title}` }, runId, task.taskId)

    const agent = task.assigneeAgentId
      ? this.store.get<AgentDefinition>('agents', 'id', task.assigneeAgentId)
      : undefined
    if (!agent) {
      this.failTask(task, runId, '任务未分配有效 Agent')
      return false
    }

    const mode = resolveActionMode(task, team)
    if (isDelegateMode(mode) && !task.inputContext.includes('[DELEGATED]')) {
      const members = this.store.teamMembers(team.id).filter((member) => member.agentId !== task.assigneeAgentId)
      const teammate = members.find((member) => this.store.get<AgentDefinition>('agents', 'id', member.agentId)?.enabled)
        ?? this.store.agents().find((agent) => agent.enabled && agent.id !== task.assigneeAgentId && !agent.isLead)
      const memberId = members.find((member) => this.store.get<AgentDefinition>('agents', 'id', member.agentId)?.enabled)?.agentId
        ?? this.store.agents().find((agent) => agent.enabled && agent.id !== task.assigneeAgentId && !agent.isLead)?.id
      if (memberId) {
        const delegated: Task = {
          ...task,
          taskId: newId('task'),
          parentTaskId: task.taskId,
          assigneeAgentId: memberId,
          status: 'pending', boardColumn: 'todo',
          inputContext: `[DELEGATED] 来自任务 ${task.taskId}\n${task.inputContext}`,
          outputSummary: '', startedAt: undefined, completedAt: undefined,
          createdAt: nowIso()
        }
        this.store.insert('tasks', delegated)
        const notice = buildDependencyNotice(task, { ...task, status: 'completed' })
        sendMessage(this.store, {
          teamId: team.id, runId, taskId: delegated.taskId,
          fromAgentId: task.assigneeAgentId, toAgentId: delegated.assigneeAgentId,
          content: `${notice}\n${task.description}`, summary: `任务转交：${task.title}`, kind: 'task_assignment'
        })
        this.emit({ type: 'message.sent', agentId: task.assigneeAgentId, message: `任务已转交: ${task.title}` }, runId, task.taskId)
        this.store.update('tasks', 'taskId', task.taskId, {
          status: 'completed', boardColumn: 'done', outputSummary: `已转交给 ${delegated.assigneeAgentId}`, completedAt: nowIso()
        })
        return true
      }
    }

    const upstream = (task.dependsOn ?? [])
      .map((id) => this.store.get<Task>('tasks', 'taskId', id))
      .filter((item): item is Task => Boolean(item))
    const memoryContext = buildMemoryContext(this.store, 'team', team.id, 5, task.description)
    const briefing = buildTaskBriefing(this.store, team, task, agent.id)
    const prompt = `${briefing}\n\n【任务执行要求】\n${task.description}${task.inputContext ? `\n${task.inputContext}` : ''}`
    const cwd = task.cwd || team.defaultWorkspace || process.cwd()
    const workspacePaths = [...new Set([cwd, team.defaultWorkspace, ...this.store.all<{ path: string }>('workspaces').map((item) => item.path)].filter(Boolean))]
    const beforeSnapshot = await snapshotWorkspace(cwd)
    const recordedChanges: FileChange[] = []
    const rawUsage: unknown[] = []

    let sessionId: string | undefined
    try {
      const session = await this.registry.connect(agent.id, cwd, {
        onEvent: (draft) => this.emit(draft, runId, task.taskId),
        requestApproval: (request) => this.requestApproval(
          { ...request, runId, taskId: task.taskId },
          team.policy?.approvalTimeoutMs ?? 300000
        ),
        permissionMode: isReadOnlyMode(mode) ? 'auto-deny' : team.permissionMode,
        policy: team.policy,
        workspacePaths,
        onFileChange: (change) => {
          const enriched = { ...change, runId, taskId: task.taskId, agentId: agent.id, createdAt: change.createdAt || nowIso() }
          this.store.insert('file_changes', enriched)
          recordedChanges.push(enriched)
        },
        onUsage: (raw) => rawUsage.push(raw),
        runId,
        taskId: task.taskId
      })
      sessionId = session.id
      if (!this.activeSessions.has(runId)) this.activeSessions.set(runId, new Set())
      this.activeSessions.get(runId)!.add(sessionId)

      const summary = await this.registry.send(session.id, prompt, { taskId: task.taskId, runId })
      const afterSnapshot = await snapshotWorkspace(cwd)
      const detected = diffSnapshots(beforeSnapshot, afterSnapshot, { runId, taskId: task.taskId, agentId: agent.id })
      const knownPaths = new Set(recordedChanges.map((change) => change.path))
      for (const change of detected) {
        if (knownPaths.has(change.path)) continue
        this.store.insert('file_changes', change)
        this.emit({ type: 'file.changed', agentId: agent.id, message: `文件变更: ${change.path}`, data: { path: change.path, taskId: task.taskId } }, runId, task.taskId)
      }

      if (this.cancelledRuns.has(runId)) {
        this.store.update('tasks', 'taskId', task.taskId, { status: 'cancelled', completedAt: nowIso() })
        this.emit({ type: 'agent.cancelled', message: `任务已取消: ${task.title}` }, runId, task.taskId)
        return false
      }
      this.store.update('tasks', 'taskId', task.taskId, {
        status: 'completed', boardColumn: 'done', outputSummary: summary.slice(0, 20000), completedAt: nowIso(), errorMessage: null
      })
      this.emit({ type: 'task.completed', agentId: agent.id, message: `任务完成: ${task.title}`, data: { chars: summary.length } }, runId, task.taskId)
      if (team.leadAgentId && team.leadAgentId !== agent.id) {
        sendMessage(this.store, {
          teamId: team.id, runId, taskId: task.taskId,
          fromAgentId: agent.id, toAgentId: team.leadAgentId,
          content: summary.slice(0, 4000), summary: `任务完成：${task.title}`, kind: 'report'
        })
        this.emit({ type: 'message.sent', agentId: agent.id, message: `结果已上报 Lead: ${task.title}` }, runId, task.taskId)
      }
      await this.runReviewCycle(task, team, runId, recordedChanges)
      saveMemory(this.store, {
        scope: 'team', scopeId: team.id,
        key: `task:${task.taskId}:summary`,
        value: summary.slice(0, 1200), source: `${agent.name} / ${runId}`
      })
      this.emit({ type: 'memory.saved', agentId: agent.id, message: `已记录任务摘要: ${task.title}` }, runId, task.taskId)
      for (const raw of rawUsage) {
        const result = recordUsage(this.store, {
          agentId: agent.id, runId, taskId: task.taskId,
          raw: typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : { value: raw },
          source: 'agent-reported'
        })
        if (typeof result !== 'string') this.emit({ type: 'usage.updated', agentId: agent.id, message: '收到官方 Agent 返回的用量数据' }, runId, task.taskId)
      }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failTask(task, runId, message, agent.id)
      return false
    } finally {
      if (sessionId) {
        await this.registry.disconnect(sessionId)
        this.activeSessions.get(runId)?.delete(sessionId)
      }
    }
  }

  private failTask(task: Task, runId: string, message: string, agentId?: string): void {
    this.store.update('tasks', 'taskId', task.taskId, { status: 'failed', errorMessage: message, completedAt: nowIso() })
    this.emit({ type: 'task.failed', agentId: agentId ?? task.assigneeAgentId, message: `任务失败: ${task.title} - ${message}` }, runId, task.taskId)
  }

  /** 任务完成后按团队 reviewFlow 自动发起一轮审查，审查者只读 Diff 与上下文。 */
  private async runReviewCycle(task: Task, team: Team, runId: string, changes: FileChange[]): Promise<void> {
    const current = this.store.get<Task>('tasks', 'taskId', task.taskId) ?? task
    const reviewFlow = resolveReviewFlow(team)
    const memberReviewer = this.store.teamMembers(team.id)
      .find((member) => /review|qa|auditor/i.test(member.role))?.agentId
    const reviewerId = current.reviewerAgentId ?? memberReviewer
      ?? this.store.agents().find((agent) => agent.enabled && /review|qa|auditor/i.test(agent.role))?.id
    if (!reviewerId) return

    const reviewer = this.store.get<AgentDefinition>('agents', 'id', reviewerId)
    if (!reviewer?.enabled) return

    const cycle = requestReview(this.store, current.taskId, {
      reviewerAgentId: reviewerId,
      requesterAgentId: current.assigneeAgentId,
      runId,
      actorName: '平台自动审查'
    })
    this.emit({ type: 'review.requested', agentId: reviewerId, message: `已请求审查: ${current.title}`, data: { reviewId: cycle.id } }, runId, current.taskId)
    startReview(this.store, cycle.id, reviewerId)
    this.emit({ type: 'review.started', agentId: reviewerId, message: `审查开始: ${current.title}` }, runId, current.taskId)

    let sessionId: string | undefined
    try {
      const messageContext = buildMessageContext(this.store, team.id, reviewerId)
      const diffs = changes.length ? changes : this.store.fileChanges(undefined, current.taskId)
      const prompt = buildReviewPrompt(current, diffs, messageContext, team.reviewFlowPrompt ?? '')
      const cwd = current.cwd || team.defaultWorkspace || process.cwd()
      const session = await this.registry.connect(reviewerId, cwd, {
        onEvent: (draft) => this.emit(draft, runId, current.taskId),
        permissionMode: 'auto-deny',
        policy: team.policy,
        workspacePaths: [cwd],
        runId,
        taskId: current.taskId
      })
      sessionId = session.id
      const output = await this.registry.send(session.id, prompt, { taskId: current.taskId, runId })
      const needsChanges = /结论[：:]\s*需要修改|需要修改/.test(output)
      const result = resolveReview(this.store, cycle.id, needsChanges ? 'changes_requested' : 'approve', {
        summary: output.slice(0, 1000),
        findings: needsChanges ? output.slice(0, 4000) : '',
        actorId: reviewerId,
        team
      })
      this.emit({
        type: needsChanges ? 'review.changes_requested' : result.nextStage === 'lead_signoff' ? 'review.lead_signoff' : 'review.approved',
        agentId: reviewerId,
        message: `审查结论: ${needsChanges ? '需要修改' : '通过'} · ${current.title}`,
        data: { nextStage: result.nextStage, reviewId: cycle.id }
      }, runId, current.taskId)
      sendMessage(this.store, {
        teamId: team.id, runId, taskId: current.taskId,
        fromAgentId: reviewerId, toAgentId: current.assigneeAgentId,
        content: output.slice(0, 4000), summary: `审查结论：${needsChanges ? '需要修改' : '通过'}`, kind: 'review_request'
      })
      void reviewFlow
    } catch (error) {
      this.store.update('review_cycles', 'id', cycle.id, {
        status: 'changes_requested', findings: error instanceof Error ? error.message : String(error), completedAt: nowIso()
      })
      this.emit({ type: 'review.changes_requested', agentId: reviewerId, message: `审查失败: ${current.title}` }, runId, current.taskId)
    } finally {
      if (sessionId) await this.registry.disconnect(sessionId)
    }
  }

  async run(options: RunOptions): Promise<RunResult> {
    const runId = newId('run')
    this.cancelledRuns.delete(runId)
    const team = this.store.get<Team>('teams', 'id', options.teamId)
    if (!team) throw new Error(`团队不存在: ${options.teamId}`)

    let runCwd = options.cwd
    let worktreeHandle: Awaited<ReturnType<typeof createWorktree>> | undefined
    if (team.isolation === 'worktree') {
      try {
        worktreeHandle = await createWorktree(options.cwd, runId)
        runCwd = worktreeHandle.path
        this.emit({ type: 'system', message: `已创建 Git worktree 隔离: ${runCwd}` }, runId)
      } catch (error) {
        this.emit({
          type: 'system', message: `无法创建 Git worktree，已回退到原工作目录: ${error instanceof Error ? error.message : String(error)}`
        }, runId)
      }
    }

    try {
    const allTasks = this.store.all<Task>('tasks')
    const taskMap = new Map(allTasks.map((task) => [task.taskId, task]))
    const selectedIds = new Set(options.taskIds)
    const closure = new Set<string>()
    const addWithDependencies = (id: string) => {
      if (closure.has(id)) return
      closure.add(id)
      for (const dep of taskMap.get(id)?.dependsOn ?? []) addWithDependencies(dep)
    }
    for (const id of selectedIds) addWithDependencies(id)
    const related = allTasks.filter((task) => closure.has(task.taskId))
    const ordered = topoSort(related)
    const selected = ordered.filter((id) => selectedIds.has(id))
    const byId = new Map(related.map((task) => [task.taskId, task]))

    this.emit({ type: 'run.started', message: `团队运行开始，共 ${selected.length} 个任务` }, runId)
    const completed: string[] = []
    const failed: string[] = []
    const cancelled: string[] = []
    const inFlight = new Set<Promise<void>>()

    const execute = async (id: string) => {
      const task = byId.get(id)!
      const ok = await this.executeTask({ ...task, cwd: task.cwd || runCwd }, team, runId)
      if (ok) {
        completed.push(id)
        for (const dependent of selected) {
          if (!(byId.get(dependent)?.dependsOn ?? []).includes(id)) continue
          const notice = buildDependencyNotice(byId.get(dependent)!, byId.get(id)!)
          notifyDependencyResolved(this.store, byId.get(dependent)!, byId.get(id)!)
          this.emit({ type: 'message.sent', agentId: byId.get(id)?.assigneeAgentId, message: notice }, runId, dependent)
        }
      }
      else if (this.cancelledRuns.has(runId)) cancelled.push(id)
      else failed.push(id)
    }

    const remaining = new Set(selected)
    while (remaining.size > 0) {
      if (this.cancelledRuns.has(runId)) {
        for (const id of remaining) {
          this.store.update('tasks', 'taskId', id, { status: 'cancelled', completedAt: nowIso() })
          cancelled.push(id)
        }
        break
      }
      const ready = [...remaining].filter((id) => {
        const deps = (byId.get(id)!.dependsOn ?? []).filter((dep) => selectedIds.has(dep))
        return deps.every((dep) => completed.includes(dep))
      })
      if (ready.length === 0) {
        for (const id of remaining) {
          this.store.update('tasks', 'taskId', id, { status: 'cancelled', errorMessage: '上游任务失败、取消或未就绪' })
          cancelled.push(id)
        }
        break
      }
      for (const id of ready.slice(0, team.maxConcurrency)) {
        remaining.delete(id)
        const job = execute(id)
        inFlight.add(job)
        void job.finally(() => inFlight.delete(job))
      }
      await Promise.allSettled([...inFlight])
    }
    await Promise.all([...inFlight])
    this.emit({ type: 'run.completed', message: `团队运行结束: 成功 ${completed.length}，失败 ${failed.length}，取消 ${cancelled.length}` }, runId)
    return { runId, completed, failed, cancelled }
    } finally {
      if (worktreeHandle) {
        try { await worktreeHandle.cleanup(); this.emit({ type: 'system', message: '已清理 Git worktree' }, runId) }
        catch (error) { this.emit({ type: 'system', message: `worktree 清理失败: ${error instanceof Error ? error.message : String(error)}` }, runId) }
      }
    }
  }

  async retryTask(taskId: string, teamId: string, cwd: string): Promise<RunResult> {
    this.store.update('tasks', 'taskId', taskId, { status: 'pending', errorMessage: null, outputSummary: '' })
    return this.run({ teamId, taskIds: [taskId], cwd })
  }
}
