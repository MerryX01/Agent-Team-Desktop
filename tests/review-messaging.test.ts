import { describe, expect, it } from 'vitest'
import { SqliteStore } from '@storage/index'
import { defaultPermissionPolicy, nowIso } from '@shared/index'
import type { AgentMessage, FileChange, ReviewCycle, ReviewFlow, Task, Team } from '@shared/index'
import {
  buildMessageContext,
  notifyDependencyResolved,
  notifyReviewRequest,
  sendMessage
} from '@orchestrator/messaging'
import {
  buildReviewPrompt,
  humanApprove,
  leadSignoff,
  requestReview,
  resolveReview,
  resolveReviewFlow,
  startReview
} from '@orchestrator/review'

function makeTeam(id: string, reviewFlow?: ReviewFlow, reviewFlowPrompt = ''): Team {
  return {
    id, name: `团队 ${id}`, description: '', defaultWorkspace: '/work',
    maxConcurrency: 2, permissionMode: 'ask', leadAgentId: 'agent-lead',
    reviewFlow, reviewFlowPrompt, isolation: 'none', policy: defaultPermissionPolicy()
  }
}

function makeTask(taskId: string, teamId: string, status: Task['status'] = 'completed'): Task {
  return {
    taskId, teamId, title: `任务 ${taskId}`, description: '实现某个功能',
    status, priority: 1, dependsOn: [], inputContext: '', outputSummary: '已完成核心实现',
    approvalRequired: false, createdAt: nowIso(), startedAt: nowIso(), completedAt: nowIso()
  }
}

function putTeam(store: SqliteStore, team: Team): Team {
  store.insert('teams', team)
  return team
}

function putTask(store: SqliteStore, task: Task): Task {
  store.insert('tasks', task)
  return task
}

function messagesFor(store: SqliteStore, taskId: string): AgentMessage[] {
  return store.all<AgentMessage>('messages', 'taskId = ? ORDER BY createdAt ASC', [taskId])
}

describe('消息中转', () => {
  it('sendMessage 校验内容非空并写入完整字段', () => {
    const store = new SqliteStore()
    try {
      expect(() => sendMessage(store, { teamId: 't1', content: '   ' })).toThrow(/消息内容不能为空/)

      const msg = sendMessage(store, {
        teamId: 't1', taskId: 'task-1', fromAgentId: 'agent-a', toAgentId: 'agent-b',
        summary: '进度同步', content: '上游已完成，请继续', kind: 'report'
      })
      expect(msg.id).toMatch(/^msg_/)
      expect(msg.createdAt).toBeTruthy()
      expect(msg.sender).toBe('agent-a')
      expect(msg.kind).toBe('report')

      const rows = store.all<AgentMessage>('messages', 'teamId = ?', ['t1'])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        id: msg.id, fromAgentId: 'agent-a', toAgentId: 'agent-b',
        summary: '进度同步', content: '上游已完成，请继续', kind: 'report'
      })
      expect(rows[0].createdAt).toBe(msg.createdAt)
    } finally { store.close() }
  })

  it('写入 review_request 与 dependency_notice 消息', () => {
    const store = new SqliteStore()
    try {
      const task = putTask(store, makeTask('task-r', 't1'))
      const upstream = putTask(store, makeTask('task-dep', 't1'))
      upstream.outputSummary = '接口已就绪'
      store.update('tasks', 'taskId', upstream.taskId, { outputSummary: upstream.outputSummary })

      const review = notifyReviewRequest(store, task, 'agent-reviewer', 'agent-dev', '请检查边界条件')
      expect(review.kind).toBe('review_request')
      expect(review.toAgentId).toBe('agent-reviewer')
      expect(review.fromAgentId).toBe('agent-dev')
      expect(review.summary).toBe('请检查边界条件')

      const dep = notifyDependencyResolved(store, task, upstream)
      expect(dep.kind).toBe('dependency_notice')
      expect(dep.content).toContain('接口已就绪')

      expect(messagesFor(store, 'task-r').map((m) => m.kind)).toEqual(['review_request', 'dependency_notice'])
    } finally { store.close() }
  })

  it('buildMessageContext 只汇总目标 agent 的最近消息，并截断内容', () => {
    const store = new SqliteStore()
    try {
      expect(buildMessageContext(store, 't1', 'agent-b')).toBe('')
      expect(buildMessageContext(store, 't1', 'agent-b', 0)).toBe('')

      sendMessage(store, {
        teamId: 't1', toAgentId: 'agent-a', fromAgentId: 'agent-x',
        summary: '不相关', content: '不应出现'
      })
      for (let i = 1; i <= 3; i += 1) {
        sendMessage(store, {
          teamId: 't1', toAgentId: 'agent-b', fromAgentId: 'agent-a',
          summary: `摘要${i}`, content: `内容${i} `.repeat(60), kind: 'report',
          createdAt: `2026-01-0${i}T00:00:00.000Z`
        })
      }
      sendMessage(store, {
        teamId: 't2', toAgentId: 'agent-b', fromAgentId: 'agent-a',
        summary: '别的团队', content: '不应出现'
      })

      const context = buildMessageContext(store, 't1', 'agent-b', 2)
      expect(context).toContain('agent-a -> agent-b')
      expect(context).toContain('摘要3')
      expect(context).toContain('摘要2')
      expect(context).not.toContain('摘要1')
      expect(context).not.toContain('不应出现')
      expect(context.split('\n')).toHaveLength(3)
      expect(context).toContain('…')
    } finally { store.close() }
  })
})

describe('审查流程解析', () => {
  it('默认 agent_approval，非法值回退默认', () => {
    const store = new SqliteStore()
    try {
      expect(resolveReviewFlow(makeTeam('t1'))).toBe('agent_approval')
      expect(resolveReviewFlow(makeTeam('t2', 'human_approval'))).toBe('human_approval')
      expect(resolveReviewFlow({ ...makeTeam('t3'), reviewFlow: 'unknown' as never })).toBe('agent_approval')
    } finally { store.close() }
  })
})

describe('审查状态机', () => {
  it('agent_approval：请求 -> 开始 -> 批准，直接完成', () => {
    const store = new SqliteStore()
    try {
      putTeam(store, makeTeam('t1', 'agent_approval'))
      const task = putTask(store, makeTask('task-a', 't1'))

      const cycle = requestReview(store, 'task-a', {
        reviewerAgentId: 'agent-reviewer', requesterAgentId: 'agent-dev',
        runId: 'run-1', actorName: '开发Agent'
      })
      expect(cycle.status).toBe('requested')
      expect(cycle.round).toBe(1)
      expect(store.get<Task>('tasks', 'taskId', 'task-a')).toMatchObject({
        reviewState: 'review', boardColumn: 'review', reviewerAgentId: 'agent-reviewer'
      })
      expect(messagesFor(store, 'task-a')[0].kind).toBe('review_request')

      expect(startReview(store, cycle.id, 'agent-reviewer').status).toBe('in_review')
      const result = resolveReview(store, cycle.id, 'approve', { summary: '无阻塞问题' })
      expect(result.nextStage).toBe('done')
      expect(result.cycle.status).toBe('approved')
      expect(result.task).toMatchObject({ reviewState: 'approved', boardColumn: 'approved' })
      expect(store.get<ReviewCycle>('review_cycles', 'id', cycle.id)).toMatchObject({ status: 'approved' })
    } finally { store.close() }
  })

  it('仅 completed/running 任务可请求审查，且轮次递增', () => {
    const store = new SqliteStore()
    try {
      putTask(store, makeTask('task-pending', 't1', 'pending'))
      expect(() => requestReview(store, 'task-pending')).toThrow(/completed 或 running/)
      expect(() => requestReview(store, 'missing')).toThrow(/任务不存在/)

      putTask(store, makeTask('task-run', 't1', 'running'))
      const first = requestReview(store, 'task-run')
      const second = requestReview(store, 'task-run')
      expect(first.round).toBe(1)
      expect(second.round).toBe(2)
      expect(store.get<ReviewCycle>('review_cycles', 'id', first.id)?.status).toBe('requested')
    } finally { store.close() }
  })

  it('changes_requested 让任务回到待重做', () => {
    const store = new SqliteStore()
    try {
      putTeam(store, makeTeam('t1', 'agent_approval'))
      putTask(store, makeTask('task-c', 't1'))
      const cycle = requestReview(store, 'task-c', { reviewerAgentId: 'agent-reviewer' })
      startReview(store, cycle.id)

      const result = resolveReview(store, cycle.id, 'changes_requested', {
        summary: '需要修改', findings: '1. 缺少边界校验'
      })
      expect(result.nextStage).toBe('rework')
      expect(result.cycle).toMatchObject({
        status: 'changes_requested', summary: '需要修改', findings: '1. 缺少边界校验'
      })
      expect(result.task).toMatchObject({
        reviewState: 'changes_requested', boardColumn: 'todo', status: 'pending'
      })
    } finally { store.close() }
  })

  it('human_approval：Agent 通过后保持等待人工，humanApprove 最终批准', () => {
    const store = new SqliteStore()
    try {
      putTeam(store, makeTeam('t1', 'human_approval'))
      putTask(store, makeTask('task-h', 't1'))

      const cycle = requestReview(store, 'task-h')
      const result = resolveReview(store, cycle.id, 'approve', { summary: 'Agent 侧通过' })
      expect(result.nextStage).toBe('human_approval')
      expect(result.task).toMatchObject({ reviewState: 'review', boardColumn: 'review' })
      expect(result.cycle.status).toBe('lead_signoff')
      expect(result.cycle.summary).toContain('等待人工审批')

      const approved = humanApprove(store, 'task-h', { summary: '人工确认通过' })
      expect(approved.task).toMatchObject({ reviewState: 'approved', boardColumn: 'approved' })
      expect(approved.cycles[0]).toMatchObject({ status: 'approved' })
      expect(approved.cycles[0].summary).toContain('人工确认通过')
      expect(store.get<ReviewCycle>('review_cycles', 'id', cycle.id)?.status).toBe('approved')
    } finally { store.close() }
  })

  it('lead_then_human：Lead 确认后仍等待人工，最终人工批准', () => {
    const store = new SqliteStore()
    try {
      putTeam(store, makeTeam('t1', 'lead_then_human'))
      putTask(store, makeTask('task-l', 't1'))

      const cycle = requestReview(store, 'task-l')
      const reviewed = resolveReview(store, cycle.id, 'approve')
      expect(reviewed.nextStage).toBe('lead_signoff')
      expect(reviewed.task.reviewState).toBe('lead_signoff')

      const signed = leadSignoff(store, cycle.id, 'approve', { summary: '架构符合要求' })
      expect(signed.nextStage).toBe('human_approval')
      expect(signed.cycle.status).toBe('lead_signoff')
      expect(signed.cycle.summary).toContain('等待人工审批')
      expect(signed.task.reviewState).toBe('lead_signoff')

      const approved = humanApprove(store, 'task-l')
      expect(approved.task.reviewState).toBe('approved')
      expect(approved.cycles.every((c) => c.status === 'approved')).toBe(true)
    } finally { store.close() }
  })

  it('lead_then_human：Lead 驳回回到重做', () => {
    const store = new SqliteStore()
    try {
      putTeam(store, makeTeam('t1', 'lead_then_human'))
      putTask(store, makeTask('task-lr', 't1'))
      const cycle = requestReview(store, 'task-lr')
      resolveReview(store, cycle.id, 'approve')

      const result = leadSignoff(store, cycle.id, 'reject', { summary: '不符合规范' })
      expect(result.nextStage).toBe('rework')
      expect(result.cycle.status).toBe('changes_requested')
      expect(result.task).toMatchObject({
        reviewState: 'changes_requested', boardColumn: 'todo', status: 'pending'
      })
    } finally { store.close() }
  })

  it('leadSignoff 在非 lead_then_human 流程下被拒绝', () => {
    const store = new SqliteStore()
    try {
      putTeam(store, makeTeam('t1', 'agent_approval'))
      putTask(store, makeTask('task-x', 't1'))
      const cycle = requestReview(store, 'task-x')
      resolveReview(store, cycle.id, 'approve')
      expect(() => leadSignoff(store, cycle.id, 'approve')).toThrow(/lead_then_human/)
    } finally { store.close() }
  })
})

describe('审查提示词', () => {
  it('包含任务、上游摘要、Diff、消息摘要与审查要求，且强调只读', () => {
    const store = new SqliteStore()
    try {
      const task = makeTask('task-p', 't1')
      task.outputSummary = '实现了登录接口'
      const diffs: FileChange[] = [{
        id: 'fc-1', taskId: 'task-p', path: 'src/auth.ts',
        before: 'return false', after: 'return true', diff: '+ return true', binary: false, createdAt: nowIso()
      }]
      const prompt = buildReviewPrompt(
        task, diffs, '近期消息（最近 1 条）: - agent-a -> agent-b | 上游已完成',
        '重点关注安全性'
      )
      expect(prompt).toContain('任务 task-p')
      expect(prompt).toContain('实现了登录接口')
      expect(prompt).toContain('src/auth.ts')
      expect(prompt).toContain('+ return true')
      expect(prompt).toContain('上游已完成')
      expect(prompt).toContain('重点关注安全性')
      expect(prompt).toContain('不要修改任何文件')
      expect(prompt).toContain('问题列表')

      const empty = buildReviewPrompt(task, [], '', '')
      expect(empty).toContain('（无 diff）')
      expect(empty).not.toContain('团队消息摘要')
      expect(empty).not.toContain('审查要求')
    } finally { store.close() }
  })
})
