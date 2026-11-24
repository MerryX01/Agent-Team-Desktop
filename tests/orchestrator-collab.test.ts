import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStore } from '@storage/index'
import type { AgentAdapter, AgentSession, ConnectOptions, EventDraft } from '@adapters/index'
import { AdapterRegistry } from '@adapters/index'
import { Orchestrator } from '@orchestrator/index'
import { humanApprove } from '@orchestrator/review'
import { defaultPermissionPolicy, nowIso } from '@shared/index'
import type { AgentDefinition, Task, Team } from '@shared/index'

class ScriptedAdapter implements AgentAdapter {
  readonly id = 'acp'
  readonly kind = 'native-acp' as const
  responses = new Map<string, string>()
  connectOptions: ConnectOptions[] = []

  async detect() { return { installed: true } }
  async connect(_definition: AgentDefinition, cwd: string, options: ConnectOptions): Promise<AgentSession> {
    this.connectOptions.push(options)
    return { id: `session-${_definition.id}`, agentId: _definition.id, protocol: 'acp', status: 'online', cwd, startedAt: nowIso() }
  }
  async send(session: AgentSession): Promise<string> {
    return this.responses.get(session.agentId) ?? `done-${session.agentId}`
  }
  async cancel() { /* noop */ }
  async disconnect() { /* noop */ }
}

function setup(overrides: Partial<Team> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'atd-collab-'))
  const store = new SqliteStore()
  const team: Team = {
    id: 'team-collab', name: '协作团队', description: '', defaultWorkspace: cwd,
    maxConcurrency: 1, permissionMode: 'ask', isolation: 'none',
    policy: defaultPermissionPolicy(), reviewFlow: 'human_approval',
    reviewFlowPrompt: '', defaultActionMode: 'do', ...overrides
  }
  store.insert('teams', team)
  for (const id of ['worker', 'reviewer']) {
    const agent: AgentDefinition = {
      id, name: id, kind: 'native-acp', vendor: 'Test', command: 'node', args: [],
      env: {}, headlessArgs: [], headlessFallback: false, usageSupported: false,
      enabled: true, authMode: 'native-login', role: id === 'reviewer' ? 'reviewer' : 'developer',
      installed: true
    }
    store.insert('agents', agent)
  }
  const registry = new AdapterRegistry(store)
  store.insert('team_members', { teamId: team.id, agentId: 'worker', role: 'developer', workflow: '', priority: 0, canWrite: true })
  store.insert('team_members', { teamId: team.id, agentId: 'reviewer', role: 'reviewer', workflow: '', priority: 1, canWrite: false })
  const adapter = new ScriptedAdapter()
  registry.register(adapter)
  const orchestrator = new Orchestrator(store, registry)
  const events: EventDraft[] = []
  orchestrator.onEvent((event) => events.push(event))
  const makeTask = (taskId: string, patch: Partial<Task> = {}): Task => ({
    taskId, teamId: team.id, title: taskId, description: taskId,
    assigneeAgentId: 'worker', status: 'pending', priority: 0, dependsOn: [],
    inputContext: '', outputSummary: '', approvalRequired: false, createdAt: nowIso(), ...patch
  })
  return { store, orchestrator, adapter, events, team, cwd, makeTask }
}

describe('协作机制集成', () => {
  it('ASK 模式把 Agent 会话切换为自动拒绝副作用', async () => {
    const { store, orchestrator, adapter, makeTask } = setup()
    store.insert('tasks', makeTask('ask-task', { actionMode: 'ask' }))
    await orchestrator.run({ teamId: 'team-collab', taskIds: ['ask-task'], cwd: process.cwd() })
    expect(adapter.connectOptions[0].permissionMode).toBe('auto-deny')
  })

  it('DELEGATE 模式创建子任务、转交消息并结束原任务', async () => {
    const { store, orchestrator, events, makeTask } = setup()
    store.insert('tasks', makeTask('delegate-task', { actionMode: 'delegate' }))
    const result = await orchestrator.run({ teamId: 'team-collab', taskIds: ['delegate-task'], cwd: process.cwd() })
    expect(result.completed).toEqual(['delegate-task'])
    const delegated = store.tasks('team-collab').find((task) => task.parentTaskId === 'delegate-task')
    expect(delegated?.assigneeAgentId).toBe('reviewer')
    expect(store.messages('team-collab').some((message) => message.kind === 'task_assignment')).toBe(true)
    expect(events.some((event) => event.type === 'message.sent')).toBe(true)
  })

  it('任务完成后自动发起审查，并可人工最终批准', async () => {
    const { store, orchestrator, adapter, events, makeTask } = setup()
    adapter.responses.set('reviewer', '结论：通过\n问题列表：无')
    store.insert('tasks', makeTask('review-task', { reviewerAgentId: 'reviewer' }))
    const result = await orchestrator.run({ teamId: 'team-collab', taskIds: ['review-task'], cwd: process.cwd() })
    expect(result.completed).toEqual(['review-task'])
    const cycles = store.reviews('review-task')
    expect(cycles.length).toBe(1)
    expect(['lead_signoff', 'approved']).toContain(cycles[0].status)
    expect(events.some((event) => event.type === 'review.requested')).toBe(true)
    expect(events.some((event) => event.type === 'review.started')).toBe(true)
    humanApprove(store, 'review-task', { actorId: 'user' })
    expect(store.get<Task>('tasks', 'taskId', 'review-task')?.reviewState).toBe('approved')
  })
})
