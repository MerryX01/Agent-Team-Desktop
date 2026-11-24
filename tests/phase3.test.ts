import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStore } from '@storage/index'
import { defaultPermissionPolicy, nowIso } from '@shared/index'
import type { Task, Team, TeamMember } from '@shared/index'
import { applyTaskTemplate, applyTeamTemplate, saveTaskTemplate, saveTeamTemplate } from '@orchestrator/templates'
import { buildMemoryContext, pruneMemory, saveMemory } from '@orchestrator/memory'
import { OFFICIAL_QUOTA_NOTICE, formatUsage, recordUsage } from '@orchestrator/usage'
import { createWorktree, removeWorktree } from '@orchestrator/worktree'

function makeTeam(id: string): Team {
  return {
    id, name: `团队 ${id}`, description: '来自 fixtures', defaultWorkspace: '/work',
    maxConcurrency: 3, permissionMode: 'plan', isolation: 'worktree',
    policy: defaultPermissionPolicy()
  }
}

function makeMember(teamId: string, agentId: string): TeamMember {
  return { teamId, agentId, role: 'developer', priority: 1, canWrite: true }
}

function makeTask(taskId: string, teamId: string): Task {
  return {
    taskId, teamId, title: '原始任务', description: '模板描述', status: 'completed',
    priority: 2, dependsOn: ['dep-1'], inputContext: '原始上下文', outputSummary: '旧输出',
    approvalRequired: true, createdAt: nowIso(), startedAt: nowIso(), completedAt: nowIso()
  }
}

describe('Phase 3 - 模板', () => {
  it('保存并应用团队模板，生成新 id 且不覆盖原团队', () => {
    const store = new SqliteStore()
    try {
      const team = makeTeam('team-src')
      const members = [makeMember('team-src', 'agent-a'), makeMember('team-src', 'agent-b')]
      store.insert('teams', team)
      for (const member of members) store.insert('team_members', member)

      const template = saveTeamTemplate(store, team, members)
      expect(template.kind).toBe('team')
      expect(store.templates('team')).toHaveLength(1)
      expect(store.get<Team>('teams', 'id', 'team-src')?.name).toBe('团队 team-src')

      const applied = applyTeamTemplate(store, template.id)
      expect(applied.team.id).not.toBe('team-src')
      expect(applied.team.name).toBe('团队 team-src')
      expect(applied.team.isolation).toBe('worktree')
      expect(applied.members).toHaveLength(2)
      expect(applied.members.every((member) => member.teamId === applied.team.id)).toBe(true)
      expect(store.get<Team>('teams', 'id', applied.team.id)).toBeTruthy()
      expect(store.teamMembers(applied.team.id)).toHaveLength(2)
    } finally { store.close() }
  })

  it('应用任务模板时生成新 id、允许覆盖字段并重置运行态', () => {
    const store = new SqliteStore()
    try {
      const template = saveTaskTemplate(store, makeTask('task-src', 'team-src'), '任务模板')
      expect(template.kind).toBe('task')
      expect(template.name).toBe('任务模板')

      const applied = applyTaskTemplate(store, template.id, 'team-new', { title: '覆盖标题' })
      expect(applied.taskId).not.toBe('task-src')
      expect(applied.teamId).toBe('team-new')
      expect(applied.title).toBe('覆盖标题')
      expect(applied.description).toBe('模板描述')
      expect(applied.status).toBe('pending')
      expect(applied.outputSummary).toBe('')
      expect(applied.startedAt).toBeUndefined()
      expect(store.get<Task>('tasks', 'taskId', applied.taskId)).toBeTruthy()
      expect(store.get<Task>('tasks', 'taskId', 'task-src')).toBeUndefined()

      const second = applyTaskTemplate(store, template.id, 'team-new')
      expect(second.taskId).not.toBe(applied.taskId)
    } finally { store.close() }
  })

  it('模板类型不匹配时抛出明确错误', () => {
    const store = new SqliteStore()
    try {
      const teamTemplate = saveTeamTemplate(store, makeTeam('team-x'), [])
      expect(() => applyTaskTemplate(store, teamTemplate.id, 'team-new')).toThrow(/模板类型不匹配/)
      expect(() => applyTeamTemplate(store, 'not-exist')).toThrow(/模板不存在/)
    } finally { store.close() }
  })
})

describe('Phase 3 - 记忆', () => {
  it('只保存提供的摘要，并构造可注入 prompt 的上下文', () => {
    const store = new SqliteStore()
    try {
      expect(() => saveMemory(store, { scope: 'team', scopeId: 't1', key: 'empty', value: '  ', source: 'test' })).toThrow(/记忆内容不能为空/)

      saveMemory(store, { scope: 'team', scopeId: 't1', key: '约定', value: '使用中文沟通', source: '人工记录' })
      saveMemory(store, { scope: 'team', scopeId: 't1', key: '技术栈', value: 'Vue 与 TypeScript', source: '人工记录' })
      saveMemory(store, { scope: 'team', scopeId: 'other', key: '无关', value: '不应出现', source: '人工记录' })

      const context = buildMemoryContext(store, 'team', 't1')
      expect(context).toContain('约定: 使用中文沟通')
      expect(context).toContain('技术栈: Vue 与 TypeScript')
      expect(context).not.toContain('不应出现')

      expect(buildMemoryContext(store, 'team', 't1', 5, 'vue')).toContain('技术栈')
      expect(buildMemoryContext(store, 'team', 't1', 5, 'vue')).not.toContain('约定')
      expect(buildMemoryContext(store, 'team', 't1', 5, '不存在')).toBe('')
      expect(buildMemoryContext(store, 'agent', 't1')).toBe('')

      const limited = buildMemoryContext(store, 'team', 't1', 1)
      expect(limited.split('\n')).toHaveLength(2)
    } finally { store.close() }
  })

  it('按 scope 裁剪记忆，保留最新条目', () => {
    const store = new SqliteStore()
    try {
      for (let i = 1; i <= 4; i += 1) {
        saveMemory(store, {
          scope: 'project', scopeId: 'p1', key: `k${i}`, value: `v${i}`, source: 'test',
          createdAt: `2026-01-0${i}T00:00:00.000Z`
        })
      }
      saveMemory(store, { scope: 'project', scopeId: 'p2', key: 'keep', value: '另一范围', source: 'test' })

      expect(pruneMemory(store, 2)).toBe(2)
      expect(store.memory('project', 'p1')).toHaveLength(2)
      expect(store.memory('project', 'p1').map((entry) => entry.key).sort()).toEqual(['k3', 'k4'])
      expect(store.memory('project', 'p2')).toHaveLength(1)
      expect(pruneMemory(store, 2)).toBe(0)
    } finally { store.close() }
  })
})

describe('Phase 3 - 用量', () => {
  it('只写入 agent-reported 且带指标的用量', () => {
    const store = new SqliteStore()
    try {
      const badSource = recordUsage(store, { agentId: 'a1', source: 'estimated', raw: {}, inputTokens: 10 })
      expect(badSource).toBe(OFFICIAL_QUOTA_NOTICE)
      expect(store.count('usage_records')).toBe(0)

      const noMetric = recordUsage(store, { agentId: 'a1', source: 'agent-reported', raw: {} })
      expect(noMetric).toBe(OFFICIAL_QUOTA_NOTICE)
      expect(store.count('usage_records')).toBe(0)

      const saved = recordUsage(store, { agentId: 'a1', source: 'agent-reported', raw: { official: true }, inputTokens: 10, outputTokens: 5, cost: 0.02 })
      expect(typeof saved).toBe('object')
      expect(store.count('usage_records')).toBe(1)
    } finally { store.close() }
  })

  it('格式化展示官方上报数据，无数据时给出统一说明', () => {
    const store = new SqliteStore()
    try {
      expect(formatUsage(store, 'a1')).toContain('额度由官方客户端管理')

      recordUsage(store, { agentId: 'a1', source: 'agent-reported', raw: {}, inputTokens: 10, outputTokens: 5 })
      recordUsage(store, { agentId: 'a1', source: 'agent-reported', raw: {}, inputTokens: 20, outputTokens: 7, cost: 0.03 })

      const text = formatUsage(store, 'a1')
      expect(text).toContain('输入 token: 30')
      expect(text).toContain('输出 token: 12')
      expect(text).toContain('费用: 0.03')
      expect(formatUsage(store, 'a2')).toBe(OFFICIAL_QUOTA_NOTICE)
    } finally { store.close() }
  })
})

describe('Phase 3 - 工作树', () => {
  it('在非 Git 目录上创建或移除工作树时抛出明确错误', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'atd-nogit-'))
    await expect(createWorktree(notRepo, 'run-1')).rejects.toThrow(/不是有效的 Git 仓库/)
    await expect(removeWorktree(notRepo, join(tmpdir(), 'atd-any-worktree'))).rejects.toThrow(/不是有效的 Git 仓库/)
  })
})
