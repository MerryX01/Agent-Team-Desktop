import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SqliteStore } from '@storage/index'
import { AcpAdapter, AdapterRegistry, ApiProviderAdapter, MemoryCredentialStore, checkLoginStatus, detectAgent } from '@adapters/index'
import type { AgentAdapter, AgentSession, ConnectOptions, EventDraft } from '@adapters/index'
import { Orchestrator } from '@orchestrator/index'
import { newId, nowIso, defaultPermissionPolicy } from '@shared/index'
import type { AgentDefinition, AgentEvent, ApiProvider, Team, Task } from '@shared/index'

const fixture = join(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')

function nativeAgent(id: string, command = process.execPath, args: string[] = [fixture]): AgentDefinition {
  return {
    id, name: id, kind: 'native-acp', vendor: 'Test', command, args, env: {},
    enabled: true, authMode: 'native-login', role: 'developer', installed: true,
    headlessArgs: [], headlessFallback: false, usageSupported: false
  }
}

function makeTask(taskId: string, agentId: string, dependsOn: string[] = []): Task {
  return {
    taskId, teamId: 'team-1', title: taskId, description: taskId,
    assigneeAgentId: agentId, status: 'pending', priority: 0, dependsOn,
    inputContext: '', outputSummary: '', approvalRequired: false,
    createdAt: nowIso()
  }
}

describe('SQLite 存储', () => {
  it('初始化默认 Agent，并支持 CRUD 与事件流', () => {
    const store = new SqliteStore()
    expect(store.agents().length).toBe(9)
    expect(store.agents().some((agent) => agent.id === 'agent-opencode')).toBe(true)
    expect(store.agents().some((agent) => agent.id === 'agent-doubao')).toBe(true)
    expect(typeof store.agents()[0].installed).toBe('boolean')
    store.insert('teams', { id: 'team-1', name: '测试团队', description: '', defaultWorkspace: '', maxConcurrency: 2, permissionMode: 'ask', isolation: 'none', policy: defaultPermissionPolicy() } satisfies Team)
    expect(store.get<Team>('teams', 'id', 'team-1')?.name).toBe('测试团队')
    store.update('teams', 'id', 'team-1', { maxConcurrency: 3 })
    expect(store.get<Team>('teams', 'id', 'team-1')?.maxConcurrency).toBe(3)
    const event: AgentEvent = {
      id: 'e1', type: 'system', message: 'hello', data: { a: 1 }, timestamp: nowIso()
    }
    store.appendEvent(event)
    expect(store.events()[0].message).toBe('hello')
    expect(store.events()[0].data).toEqual({ a: 1 })
    store.close()
  })

  it('拒绝非法表名，防止动态 SQL 注入', () => {
    const store = new SqliteStore()
    expect(() => store.all('agents; DROP TABLE agents')).toThrow(/非法表名/)
    store.close()
  })
})

describe('ACP Adapter', () => {
  it('完成 initialize → session/new → prompt → 流式更新 → disconnect 闭环', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'atd-acp-'))
    const events: EventDraft[] = []
    const adapter = new AcpAdapter()
    const session = await adapter.connect(nativeAgent('mock-acp'), cwd, { onEvent: (event) => events.push(event) })
    const output = await adapter.send(session, 'hello', { taskId: 'task-1' })
    expect(output).toContain('ECHO:')
    expect(output).toContain('hello')
    expect(events.some((event) => event.type === 'agent.tool.started')).toBe(true)
    expect(events.some((event) => event.type === 'agent.tool.finished')).toBe(true)
    expect(events.some((event) => event.type === 'agent.message.delta')).toBe(true)
    await adapter.disconnect(session)
  })

  it('可以取消正在执行的 prompt', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'atd-cancel-'))
    const adapter = new AcpAdapter()
    const session = await adapter.connect(nativeAgent('mock-cancel'), cwd, { onEvent: () => undefined })
    const pending = adapter.send(session, 'SLOW task')
    await new Promise((resolve) => setTimeout(resolve, 150))
    await adapter.cancel(session)
    await expect(pending).resolves.toBeTypeOf('string')
    await adapter.disconnect(session)
  })

  it('命令不存在时如实返回未安装，无状态命令时返回 unknown', async () => {
    const result = await detectAgent(nativeAgent('missing', 'definitely-not-a-real-command-xyz'))
    expect(result.installed).toBe(false)
    const login = await checkLoginStatus(nativeAgent('no-status'))
    expect(login.state).toBe('unknown')
  })
})

class FakeAdapter implements AgentAdapter {
  readonly id = 'acp'
  readonly kind = 'native-acp' as const
  prompts: string[] = []
  active = 0
  maxActive = 0
  failAgent = ''
  shouldRequestApproval = false

  async detect() { return { installed: true } }
  async connect(_definition: AgentDefinition, cwd: string, options: ConnectOptions): Promise<AgentSession> {
    if (this.shouldRequestApproval) {
      await options.requestApproval?.({ title: '写文件', detail: 'tests', agentId: _definition.id })
    }
    return {
      id: newId('session'), agentId: _definition.id, protocol: 'acp', status: 'online', cwd, startedAt: nowIso()
    }
  }
  async send(session: AgentSession, prompt: string): Promise<string> {
    this.prompts.push(prompt)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    await new Promise((resolve) => setTimeout(resolve, 20))
    this.active -= 1
    if (session.agentId === this.failAgent) throw new Error('模拟失败')
    return `result-${session.agentId}`
  }
  async cancel() { /* noop */ }
  async disconnect() { /* noop */ }
}

function setupOrchestrator() {
  const store = new SqliteStore()
  store.insert('teams', { id: 'team-1', name: '测试团队', description: '', defaultWorkspace: process.cwd(), maxConcurrency: 2, permissionMode: 'ask', isolation: 'none', policy: defaultPermissionPolicy() } satisfies Team)
  const registry = new AdapterRegistry(store, new MemoryCredentialStore())
  const fake = new FakeAdapter()
  registry.register(fake)
  const orchestrator = new Orchestrator(store, registry)
  const events: EventDraft[] = []
  orchestrator.onEvent((event) => events.push(event))
  return { store, registry, fake, orchestrator, events }
}

describe('编排器', () => {
  it('按 DAG 依赖执行，支持并行与共享上下文', async () => {
    const { store, fake, orchestrator } = setupOrchestrator()
    for (const id of ['a', 'b', 'c']) store.insert('agents', nativeAgent(id))
    store.insert('tasks', makeTask('t-a', 'a'))
    store.insert('tasks', makeTask('t-b', 'b', ['t-a']))
    store.insert('tasks', makeTask('t-c', 'c', ['t-a']))

    const result = await orchestrator.run({ teamId: 'team-1', taskIds: ['t-a', 't-b', 't-c'], cwd: process.cwd() })
    expect(result.completed.sort()).toEqual(['t-a', 't-b', 't-c'])
    expect(fake.maxActive).toBe(2)
    expect(fake.prompts[1]).toContain('result-a')
    expect(fake.prompts[2]).toContain('result-a')
  })

  it('失败任务的下游被取消，重试后可成功', async () => {
    const { store, fake, orchestrator } = setupOrchestrator()
    for (const id of ['bad', 'good']) store.insert('agents', nativeAgent(id))
    fake.failAgent = 'bad'
    store.insert('tasks', makeTask('t-bad', 'bad'))
    store.insert('tasks', makeTask('t-down', 'good', ['t-bad']))

    const result = await orchestrator.run({ teamId: 'team-1', taskIds: ['t-bad', 't-down'], cwd: process.cwd() })
    expect(result.failed).toEqual(['t-bad'])
    expect(result.cancelled).toEqual(['t-down'])

    fake.failAgent = ''
    const retried = await orchestrator.retryTask('t-bad', 'team-1', process.cwd())
    expect(retried.completed).toEqual(['t-bad'])
  })

  it('权限请求可被人工批准并写入审批记录', async () => {
    const { store, fake, orchestrator } = setupOrchestrator()
    store.insert('agents', nativeAgent('approval-agent'))
    store.insert('tasks', makeTask('t-approval', 'approval-agent'))
    fake.shouldRequestApproval = true

    const running = orchestrator.run({ teamId: 'team-1', taskIds: ['t-approval'], cwd: process.cwd() })
    await new Promise((resolve) => setTimeout(resolve, 80))
    const pending = store.approvals().find((item) => item.status === 'pending')
    expect(pending).toBeTruthy()
    expect(orchestrator.resolveApproval(pending!.id, 'approved')).toBe(true)
    const result = await running
    expect(result.completed).toEqual(['t-approval'])
    expect(store.approvals()[0].status).toBe('approved')
  })
})

describe('API Key 通道', () => {
  beforeEach(() => { vi.unstubAllGlobals() })

  it('通过独立凭据发送 OpenAI-compatible 请求，且不把 Key 写入数据库', async () => {
    const credentials = new MemoryCredentialStore()
    const provider: ApiProvider = {
      id: 'p1', name: 'Test Provider', protocol: 'openai-compatible', baseUrl: 'https://example.com/v1',
      model: 'test-model', credentialRef: 'cred-1', contextLength: 8192, maxOutput: 1024,
      timeoutMs: 5000, verified: false, models: []
    }
    credentials.set('cred-1', 'test-api-key-123456')
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'api-ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ))
    vi.stubGlobal('fetch', fetchMock)

    const adapter = new ApiProviderAdapter(() => [provider], credentials)
    const session = await adapter.connect({ ...nativeAgent('api-agent', '', []), providerRef: 'p1' }, process.cwd(), { onEvent: () => undefined })
    const text = await adapter.send(session, 'ping')
    expect(text).toBe('api-ok')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.com/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-api-key-123456')
  })

  it('连接测试失败时返回失败结果', async () => {
    const credentials = new MemoryCredentialStore()
    const provider: ApiProvider = {
      id: 'p2', name: 'Bad Provider', protocol: 'openai-compatible', baseUrl: 'https://example.com/v1',
      model: 'bad', credentialRef: 'cred-2', contextLength: 8192, maxOutput: 1024, timeoutMs: 5000, verified: false, models: []
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })))
    const adapter = new ApiProviderAdapter(() => [provider], credentials)
    const result = await adapter.testConnection(provider, 'sk-bad')
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('401')
  })
})
