import { describe, expect, it } from 'vitest'
import { SqliteStore } from '@storage/index'
import { defaultPermissionPolicy, nowIso } from '@shared/index'
import type { AgentDefinition, Task, Team } from '@shared/index'
import {
  buildActionModeInstruction, isDelegateMode, isReadOnlyMode, resolveActionMode
} from '@orchestrator/actionMode'
import {
  buildDependencyNotice, buildRosterBriefing, buildTaskBriefing
} from '@orchestrator/briefing'

function makeTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-brief', name: '简报测试团队', description: '', defaultWorkspace: '/work',
    maxConcurrency: 2, permissionMode: 'ask', isolation: 'none',
    policy: defaultPermissionPolicy(), ...overrides
  }
}

function makeAgent(id: string, name: string, role: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id, name, kind: 'native-acp', vendor: '测试来源', command: '', args: [], env: {},
    enabled: true, authMode: 'unknown', role, installed: false, headlessArgs: [],
    headlessFallback: false, usageSupported: false, ...overrides
  }
}

function makeTask(taskId: string, overrides: Partial<Task> = {}): Task {
  return {
    taskId, teamId: 'team-brief', title: `任务 ${taskId}`, description: '完成指定工作',
    status: 'pending', priority: 0, dependsOn: [], inputContext: '', outputSummary: '',
    approvalRequired: false, createdAt: nowIso(), ...overrides
  }
}

describe('动作模式解析与指令', () => {
  it('按任务 > 团队 > do 的优先级解析，且任务显式值不被覆盖', () => {
    const team = makeTeam({ defaultActionMode: 'ask' })
    const task = makeTask('t1')
    expect(resolveActionMode(task, team)).toBe('ask')
    expect(resolveActionMode({ ...task, actionMode: 'delegate' }, team)).toBe('delegate')
    expect(resolveActionMode({ ...task, actionMode: 'do' }, { ...team, defaultActionMode: 'delegate' })).toBe('do')
    expect(resolveActionMode(task, makeTeam())).toBe('do')
  })

  it('三种模式给出不同的中文约束，DELEGATE 只使用名册精确姓名', () => {
    const doText = buildActionModeInstruction('do', ['甲'])
    const askText = buildActionModeInstruction('ask', ['甲'])
    const delegateText = buildActionModeInstruction('delegate', ['张三', '李四'])

    expect(doText).toContain('DO')
    expect(doText).toContain('读写命令')
    expect(askText).toContain('ASK')
    expect(askText).toContain('严格只读')
    expect(askText).toContain('不得修改')
    expect(askText).toContain('副作用')
    expect(delegateText).toContain('DELEGATE')
    expect(delegateText).toContain('不得自己实现')
    expect(delegateText).toContain('转交')
    expect(delegateText).toContain('张三')
    expect(delegateText).toContain('李四')
    expect(delegateText).not.toContain('王五')
    expect(isDelegateMode('delegate')).toBe(true)
    expect(isDelegateMode('do')).toBe(false)
    expect(isReadOnlyMode('ask')).toBe(true)
    expect(isReadOnlyMode('delegate')).toBe(false)
  })
})

describe('名册简报', () => {
  it('team_members 优先，输出精确姓名、workflow 与 Lead / 你的标记', () => {
    const store = new SqliteStore()
    try {
      const team = makeTeam({ leadAgentId: 'a-lead' })
      store.insert('teams', team)
      store.insert('agents', makeAgent('a-lead', '林Lead', 'lead', { workflow: '先评审再分派' }))
      store.insert('agents', makeAgent('a-dev', '周开发', 'developer', { workflow: '实现并自测' }))
      store.insert('agents', makeAgent('a-qa', '吴测试', 'qa'))
      store.insert('team_members', { teamId: team.id, agentId: 'a-lead', role: 'lead', priority: 1, canWrite: false, workflow: '先评审再分派' })
      store.insert('team_members', { teamId: team.id, agentId: 'a-dev', role: 'developer', priority: 2, canWrite: true, workflow: '实现并自测' })

      const text = buildRosterBriefing(store, team)
      expect(text).toContain('林Lead (role: lead) [team lead] [你]')
      expect(text).toContain('周开发 (role: developer)')
      expect(text).not.toContain('吴测试')
      expect(text).toContain('先评审再分派')
      expect(text).toContain('实现并自测')
      expect(text).toContain('不得杜撰')
      expect(text).toContain('快照')

      const forDev = buildRosterBriefing(store, team, 'a-dev')
      expect(forDev).toContain('周开发 (role: developer) [你]')
      expect(forDev).not.toContain('林Lead (role: lead) [team lead] [你]')
    } finally { store.close() }
  })

  it('没有 team_members 时回退到 agents，并识别保留 Lead 角色', () => {
    const store = new SqliteStore()
    try {
      const team = makeTeam({ id: 'team-fallback', leadAgentId: 'agent-custom' })
      store.insert('teams', team)
      store.insert('agents', makeAgent('agent-custom', '赵架构', 'architect', { workflow: '定方案' }))

      const text = buildRosterBriefing(store, team)
      expect(text).toContain('赵架构 (role: architect)')
      expect(text).toContain('定方案')
      expect(text).toContain('[team lead]')
      expect(text).toContain('[你]')
    } finally { store.close() }
  })
})

describe('任务简报', () => {
  it('区分 Actionable / Awareness，并包含依赖、记忆、消息与动作模式', () => {
    const store = new SqliteStore()
    try {
      const team = makeTeam({ defaultActionMode: 'ask' })
      store.insert('teams', team)
      store.insert('agents', makeAgent('a1', '甲', 'developer'))
      store.insert('agents', makeAgent('a2', '乙', 'reviewer'))
      store.insert('team_members', { teamId: team.id, agentId: 'a1', role: 'developer', priority: 1, canWrite: true })
      store.insert('team_members', { teamId: team.id, agentId: 'a2', role: 'reviewer', priority: 2, canWrite: false })

      store.insert('tasks', makeTask('dep-1', { title: '前置任务', status: 'completed', outputSummary: '前置已完成' }))
      const current = makeTask('cur', {
        title: '当前任务', description: '实现核心逻辑', assigneeAgentId: 'a1',
        dependsOn: ['dep-1'], actionMode: 'delegate', inputContext: '重要背景',
        outputSummary: '已有初稿', priority: 5
      })
      store.insert('tasks', current)
      store.insert('tasks', makeTask('run-1', {
        title: '进行中任务', assigneeAgentId: 'a1', status: 'running',
        boardColumn: 'in_progress', priority: 4
      }))
      store.insert('tasks', makeTask('fix-1', {
        title: '待修复任务', assigneeAgentId: 'a1', status: 'failed',
        reviewState: 'changes_requested', priority: 3
      }))
      store.insert('tasks', makeTask('aware-1', {
        title: '审查任务', description: '检查一下', assigneeAgentId: 'a2',
        status: 'pending', priority: 2
      }))
      store.insert('memory_entries', {
        id: 'mem-1', scope: 'team', scopeId: team.id, key: '约定',
        value: '使用中文沟通', source: '人工记录', createdAt: nowIso()
      })
      store.insert('messages', {
        id: 'msg-1', teamId: team.id, sender: '甲', content: '已同步方案',
        summary: '同步方案', kind: 'coordination', timestamp: nowIso()
      })

      const text = buildTaskBriefing(store, team, current)
      const actionable = text.slice(text.indexOf('【Actionable'), text.indexOf('【Awareness'))
      const awareness = text.slice(text.indexOf('【Awareness'), text.indexOf('【依赖与阻塞'))

      expect(text).toContain('【动作模式：DELEGATE（转交）】')
      expect(text).toContain('角色职责（developer）')
      expect(actionable).toContain('当前任务')
      expect(actionable).toContain('重要背景')
      expect(actionable).toContain('进行中任务')
      expect(actionable).toContain('待修复任务')
      expect(awareness).toContain('审查任务')
      expect(awareness).not.toContain('进行中任务')
      expect(text).toContain('已就绪：前置任务')
      expect(text).toContain('使用中文沟通')
      expect(text).toContain('同步方案')
    } finally { store.close() }
  })

  it('条目过多或内容过长时限制长度，并标注省略 / 截断', () => {
    const store = new SqliteStore()
    try {
      const team = makeTeam({ id: 'team-truncate' })
      store.insert('teams', team)
      const current = makeTask('cur', {
        teamId: team.id, title: '当前任务', description: '甲'.repeat(1000),
        inputContext: '乙'.repeat(1000), outputSummary: '丙'.repeat(1000)
      })
      store.insert('tasks', current)
      for (let i = 0; i < 30; i += 1) {
        store.insert('tasks', makeTask(`other-${i}`, {
          teamId: team.id, title: `其他任务 ${i}`, description: '丁'.repeat(300)
        }))
      }
      const text = buildTaskBriefing(store, team, current)
      expect(text.length).toBeLessThanOrEqual(4000)
      expect(text).toContain('【Actionable｜需要你处理】')
      expect(text).toContain('已省略')
    } finally { store.close() }

    const longStore = new SqliteStore()
    try {
      const team = makeTeam({ id: 'team-long' })
      longStore.insert('teams', team)
      for (let i = 0; i < 40; i += 1) {
        longStore.insert('agents', makeAgent(`long-${i}`, `成员${i}${'长'.repeat(150)}`, 'developer'))
      }
      const task = makeTask('cur', { teamId: team.id, actionMode: 'delegate' })
      longStore.insert('tasks', task)
      const text = buildTaskBriefing(longStore, team, task)
      expect(text.length).toBeLessThanOrEqual(4000)
      expect(text).toContain('截断')
    } finally { longStore.close() }
  })
})

describe('依赖解除通知', () => {
  it('通知负责人前置任务已完成并可继续', () => {
    const resolved = makeTask('dep', { title: '前置任务', status: 'completed' })
    const task = makeTask('next', { title: '后续任务', description: '继续实现功能' })
    const text = buildDependencyNotice(task, resolved)
    expect(text).toContain('前置任务')
    expect(text).toContain('已完成')
    expect(text).toContain('后续任务')
    expect(text).toContain('继续实现功能')
  })
})
