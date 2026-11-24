import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteStore } from '@storage/index'
import type { AgentAdapter, AgentSession } from '@adapters/index'
import { AdapterRegistry } from '@adapters/index'
import { Orchestrator } from '@orchestrator/index'
import { defaultPermissionPolicy, nowIso } from '@shared/index'
import type { AgentDefinition, Task, Team } from '@shared/index'

class WritingAdapter implements AgentAdapter {
  readonly id = 'acp'
  readonly kind = 'native-acp' as const
  file: string

  constructor(file: string) { this.file = file }

  async detect() { return { installed: true } }
  async connect(definition: AgentDefinition, cwd: string): Promise<AgentSession> {
    return { id: 'session-writer', agentId: definition.id, protocol: 'acp', status: 'online', cwd, startedAt: nowIso() }
  }
  async send(_session: AgentSession, _prompt: string): Promise<string> {
    writeFileSync(this.file, 'hello from agent\n')
    return 'wrote file'
  }
  async cancel() { /* noop */ }
  async disconnect() { /* noop */ }
}

function setup(file: string, isolation: Team['isolation'] = 'none') {
  const cwd = mkdtempSync(join(tmpdir(), 'atd-full-'))
  const store = new SqliteStore()
  const target = join(cwd, 'agent-output.txt')
  const team: Team = {
    id: 'team-full', name: '完整流程团队', description: '', defaultWorkspace: cwd,
    maxConcurrency: 1, permissionMode: 'ask', isolation,
    policy: defaultPermissionPolicy()
  }
  store.insert('teams', team)
  const agent: AgentDefinition = {
    id: 'agent-writer', name: 'Writer', kind: 'native-acp', vendor: 'Test',
    command: 'node', args: [], env: {}, headlessArgs: [], headlessFallback: false, usageSupported: false,
    enabled: true, authMode: 'native-login', role: 'developer', installed: true
  }
  store.insert('agents', agent)
  const task: Task = {
    taskId: 'task-write', teamId: team.id, title: '写文件', description: '生成一个文件',
    assigneeAgentId: agent.id, status: 'pending', priority: 0, dependsOn: [],
    inputContext: '', outputSummary: '', approvalRequired: false, createdAt: nowIso()
  }
  store.insert('tasks', task)
  const registry = new AdapterRegistry(store)
  registry.register(new WritingAdapter(target))
  const orchestrator = new Orchestrator(store, registry)
  const events: string[] = []
  orchestrator.onEvent((event) => events.push(event.type))
  return { store, orchestrator, cwd, target, events }
}

describe('完整任务流程', () => {
  it('任务执行后自动记录文件 Diff 与长期记忆', async () => {
    const { store, orchestrator, cwd, target } = setup('ignored')
    const result = await orchestrator.run({ teamId: 'team-full', taskIds: ['task-write'], cwd })
    expect(result.completed).toEqual(['task-write'])
    const changes = store.fileChanges(undefined, 'task-write')
    expect(changes.some((change) => change.path === target && change.diff.includes('hello from agent'))).toBe(true)
    expect(store.memory('team', 'team-full').some((entry) => entry.key === 'task:task-write:summary')).toBe(true)
  })

  it('worktree 不可用时回退原目录且不阻断任务', async () => {
    const { orchestrator, cwd, events } = setup('ignored', 'worktree')
    const result = await orchestrator.run({ teamId: 'team-full', taskIds: ['task-write'], cwd })
    expect(result.completed).toEqual(['task-write'])
    expect(events).toContain('system')
  })
})
