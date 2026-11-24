import type { SqliteStore } from '@storage/index'
import type { FileChange, ReviewCycle, ReviewFlow, Task, Team } from '@shared/index'
import { ReviewFlowSchema, newId, nowIso } from '@shared/index'
import { notifyReviewRequest } from './messaging'

export interface RequestReviewOptions {
  reviewerAgentId?: string
  requesterAgentId?: string
  runId?: string
  actorName?: string
  team?: Team
}

export interface ResolveReviewOptions {
  summary?: string
  findings?: string
  actorId?: string
  team?: Team
}

export interface LeadSignoffOptions {
  summary?: string
  actorId?: string
}

export interface HumanApproveOptions {
  summary?: string
  actorId?: string
}

export type ReviewNextStage = 'done' | 'lead_signoff' | 'human_approval' | 'rework'

export interface ReviewResolution {
  cycle: ReviewCycle
  task: Task
  nextStage: ReviewNextStage
}

export type ReviewDiff = FileChange[] | string

function loadTask(store: SqliteStore, taskId: string): Task {
  const task = store.get<Task>('tasks', 'taskId', taskId)
  if (!task) throw new Error(`任务不存在: ${taskId}`)
  return task
}

function loadCycle(store: SqliteStore, cycleId: string): ReviewCycle {
  const cycle = store.get<ReviewCycle>('review_cycles', 'id', cycleId)
  if (!cycle) throw new Error(`审查周期不存在: ${cycleId}`)
  return cycle
}

/** 解析团队的审查流程，未配置或配置非法时回退到 agent_approval。 */
export function resolveReviewFlow(team: Team): ReviewFlow {
  const parsed = ReviewFlowSchema.safeParse(team.reviewFlow)
  return parsed.success ? parsed.data : 'agent_approval'
}

function flowForTask(store: SqliteStore, task: Task, explicit?: Team): ReviewFlow {
  if (explicit) return resolveReviewFlow(explicit)
  const team = store.get<Team>('teams', 'id', task.teamId)
  return team ? resolveReviewFlow(team) : 'agent_approval'
}

/**
 * 发起一轮审查：仅 completed / running 任务可用，创建 requested 周期并把任务推入 review 列。
 */
export function requestReview(store: SqliteStore, taskId: string, options: RequestReviewOptions = {}): ReviewCycle {
  const task = loadTask(store, taskId)
  if (task.status !== 'completed' && task.status !== 'running') {
    throw new Error(`只有 completed 或 running 的任务可以请求审查，当前: ${task.status}`)
  }

  const round = store.reviews(taskId).reduce((max, cycle) => Math.max(max, cycle.round), 0) + 1
  const reviewerAgentId = options.reviewerAgentId ?? task.reviewerAgentId
  const summary = options.actorName ? `${options.actorName} 请求审查` : `第 ${round} 轮审查请求`
  const cycle: ReviewCycle = {
    id: newId('review'),
    taskId,
    runId: options.runId,
    reviewerAgentId,
    requesterAgentId: options.requesterAgentId,
    round,
    status: 'requested',
    summary,
    findings: '',
    createdAt: nowIso()
  }
  store.insert('review_cycles', cycle)
  store.update('tasks', 'taskId', taskId, {
    reviewState: 'review',
    boardColumn: 'review',
    ...(reviewerAgentId ? { reviewerAgentId } : {})
  })
  notifyReviewRequest(store, task, reviewerAgentId, options.requesterAgentId, summary)
  return cycle
}

/** reviewer 开始审查：requested -> in_review。 */
export function startReview(store: SqliteStore, cycleId: string, actorId?: string): ReviewCycle {
  const cycle = loadCycle(store, cycleId)
  if (cycle.status !== 'requested') {
    throw new Error(`审查周期不是 requested 状态，无法开始: ${cycle.status}`)
  }
  const patch: Partial<ReviewCycle> = {
    status: 'in_review',
    ...(actorId && !cycle.reviewerAgentId ? { reviewerAgentId: actorId } : {})
  }
  store.update('review_cycles', 'id', cycleId, patch)
  store.update('tasks', 'taskId', cycle.taskId, { boardColumn: 'review' })
  return { ...cycle, ...patch } as ReviewCycle
}

/**
 * reviewer 给出结论。根据团队流程决定下一阶段：
 * - agent_approval：直接 approved / done
 * - lead_then_human：进入 lead_signoff，等待 Lead 确认
 * - human_approval：保持 review 等待人工；cycle 复用 lead_signoff 状态表示「等待人工」
 * - changes_requested：回到 todo/pending 等待重做
 */
export function resolveReview(
  store: SqliteStore,
  cycleId: string,
  decision: 'approve' | 'changes_requested',
  options: ResolveReviewOptions = {}
): ReviewResolution {
  const cycle = loadCycle(store, cycleId)
  const task = loadTask(store, cycle.taskId)
  const flow = flowForTask(store, task, options.team)
  const summary = options.summary?.trim() ?? ''
  const findings = options.findings?.trim() ?? ''

  const cyclePatch: Partial<ReviewCycle> = {
    summary: summary || cycle.summary,
    findings: findings || cycle.findings,
    completedAt: nowIso()
  }
  const taskPatch: Partial<Task> = {}
  let nextStage: ReviewNextStage

  if (decision === 'changes_requested') {
    cyclePatch.status = 'changes_requested'
    taskPatch.reviewState = 'changes_requested'
    taskPatch.boardColumn = 'todo'
    taskPatch.status = 'pending'
    nextStage = 'rework'
  } else if (flow === 'lead_then_human') {
    cyclePatch.status = 'lead_signoff'
    cyclePatch.summary = `${cyclePatch.summary}；Agent 审查通过，等待 Lead 确认`
    taskPatch.reviewState = 'lead_signoff'
    taskPatch.boardColumn = 'review'
    nextStage = 'lead_signoff'
  } else if (flow === 'human_approval') {
    cyclePatch.status = 'lead_signoff'
    cyclePatch.summary = `${cyclePatch.summary}；等待人工审批`
    taskPatch.reviewState = 'review'
    taskPatch.boardColumn = 'review'
    nextStage = 'human_approval'
  } else {
    cyclePatch.status = 'approved'
    taskPatch.reviewState = 'approved'
    taskPatch.boardColumn = 'approved'
    nextStage = 'done'
  }

  store.update('review_cycles', 'id', cycleId, cyclePatch)
  store.update('tasks', 'taskId', task.taskId, taskPatch)
  return {
    cycle: { ...cycle, ...cyclePatch } as ReviewCycle,
    task: { ...task, ...taskPatch } as Task,
    nextStage
  }
}

/** Lead 确认（仅 lead_then_human）：approve 后仍等待人工，reject 则打回重做。 */
export function leadSignoff(
  store: SqliteStore,
  cycleId: string,
  decision: 'approve' | 'reject',
  options: LeadSignoffOptions = {}
): ReviewResolution {
  const cycle = loadCycle(store, cycleId)
  const task = loadTask(store, cycle.taskId)
  const team = store.get<Team>('teams', 'id', task.teamId)
  if (team && resolveReviewFlow(team) !== 'lead_then_human') {
    throw new Error('leadSignoff 仅适用于 lead_then_human 流程')
  }
  if (cycle.status !== 'lead_signoff') {
    throw new Error(`审查周期尚未进入 lead_signoff: ${cycle.status}`)
  }

  const note = options.summary?.trim() ?? ''
  const cyclePatch: Partial<ReviewCycle> = {}
  const taskPatch: Partial<Task> = {}
  let nextStage: ReviewNextStage

  if (decision === 'approve') {
    cyclePatch.status = 'lead_signoff'
    cyclePatch.summary = `${cycle.summary || '审查通过'}；Lead 已确认${note ? `: ${note}` : ''}，等待人工审批`
    taskPatch.reviewState = 'lead_signoff'
    taskPatch.boardColumn = 'review'
    nextStage = 'human_approval'
  } else {
    cyclePatch.status = 'changes_requested'
    cyclePatch.summary = `${cycle.summary || '审查'}；Lead 驳回${note ? `: ${note}` : ''}`
    cyclePatch.findings = note || cycle.findings
    cyclePatch.completedAt = nowIso()
    taskPatch.reviewState = 'changes_requested'
    taskPatch.boardColumn = 'todo'
    taskPatch.status = 'pending'
    nextStage = 'rework'
  }

  store.update('review_cycles', 'id', cycleId, cyclePatch)
  store.update('tasks', 'taskId', task.taskId, taskPatch)
  return {
    cycle: { ...cycle, ...cyclePatch } as ReviewCycle,
    task: { ...task, ...taskPatch } as Task,
    nextStage
  }
}

/** 人工最终批准：任务进入 approved，所有未完成周期一并置为 approved。 */
export function humanApprove(
  store: SqliteStore,
  taskId: string,
  options: HumanApproveOptions = {}
): { task: Task; cycles: ReviewCycle[] } {
  const task = loadTask(store, taskId)
  const cycles = store.reviews(taskId).map((cycle) => {
    if (cycle.status !== 'requested' && cycle.status !== 'in_review' && cycle.status !== 'lead_signoff') return cycle
    const updated: ReviewCycle = {
      ...cycle,
      status: 'approved',
      summary: options.summary ? `${cycle.summary}；人工批准: ${options.summary}` : cycle.summary,
      completedAt: cycle.completedAt ?? nowIso()
    }
    store.update('review_cycles', 'id', cycle.id, updated)
    return updated
  })

  const taskPatch: Partial<Task> = { reviewState: 'approved', boardColumn: 'approved' }
  store.update('tasks', 'taskId', taskId, taskPatch)
  return { task: { ...task, ...taskPatch } as Task, cycles }
}

function formatDiffs(diffs: ReviewDiff): string {
  if (typeof diffs === 'string') return diffs.trim() || '（无 diff）'
  if (!Array.isArray(diffs) || diffs.length === 0) return '（无 diff）'
  return diffs.map((change) => {
    const body = change.diff?.trim() ||
      (change.before || change.after ? `- ${change.before}\n+ ${change.after}` : '（内容为空）')
    return `### ${change.path}\n${body}`
  }).join('\n\n')
}

/** 给 reviewer 的提示词：只读审查，仅输出结论与问题列表。 */
export function buildReviewPrompt(
  task: Task,
  diffs: ReviewDiff,
  messageContext: string,
  reviewFlowPrompt: string
): string {
  const sections: string[] = [
    '你是代码审查者。只输出「结论」与「问题列表」，不要修改任何文件，也不要执行写操作。',
    '',
    `任务：${task.title}`,
    `描述：${task.description}`,
    `上游输出摘要：${task.outputSummary?.trim() || '（无）'}`,
    '',
    '变更 Diff：',
    formatDiffs(diffs),
    ''
  ]
  if (messageContext?.trim()) sections.push('团队消息摘要：', messageContext.trim(), '')
  if (reviewFlowPrompt?.trim()) sections.push('审查要求：', reviewFlowPrompt.trim(), '')
  sections.push(
    '请严格按如下格式输出：',
    '结论：通过 / 需要修改',
    '问题列表：',
    '1. ...（若没有问题请写「无」）'
  )
  return sections.join('\n')
}
