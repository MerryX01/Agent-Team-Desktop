import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SqliteStore } from '@storage/index'
import {
  AdapterRegistry, ApiProviderAdapter, MemoryCredentialStore, requestText
} from '@adapters/index'
import { NativeProcessAdapter } from '@adapters/process'
import { RemoteAcpAdapter } from '@adapters/remote'
import type { AgentDefinition, ApiProvider } from '@shared/index'
import type { EventDraft } from '@adapters/index'

const fixture = join(process.cwd(), 'tests/fixtures/mock-headless-cli.mjs')

function baseDefinition(id: string, kind: AgentDefinition['kind']): AgentDefinition {
  return {
    id, name: id, kind, vendor: 'Test', args: [], env: {}, enabled: true,
    authMode: kind === 'api-provider' ? 'api-key' : kind === 'remote-acp' ? 'remote-token' : 'native-login',
    role: 'developer', installed: true, headlessArgs: [], headlessFallback: false, usageSupported: false
  }
}

function headlessDefinition(id: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    ...baseDefinition(id, 'native-process'),
    command: process.execPath,
    headlessCommand: process.execPath,
    headlessArgs: [fixture, '--json'],
    ...extra
  }
}

function provider(protocol: ApiProvider['protocol'] = 'openai-compatible'): ApiProvider {
  return {
    id: 'p-full', name: 'Stream Provider', protocol, baseUrl: 'https://example.com/v1',
    model: 'stream-model', credentialRef: 'cred-full', contextLength: 8192,
    maxOutput: 1024, timeoutMs: 5000, verified: false, models: []
  }
}

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('NativeProcessAdapter', () => {
  it('按行解析 JSON/纯文本，流式发出 delta 并拼接完整文本', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'atd-proc-'))
    const events: EventDraft[] = []
    // promptFlag 作为提示词前的最后一个开关，验证参数顺序。
    const adapter = new NativeProcessAdapter({ promptFlag: '--prompt' })
    const session = await adapter.connect(headlessDefinition('proc-stream'), cwd, {
      onEvent: (event) => events.push(event)
    })
    const text = await adapter.send(session, 'hello')

    expect(text).toContain('ARGS:--json|--prompt')
    expect(text).toContain('ECHO:hello')
    expect(text).toContain(':DONE')
    expect(text).toContain('plain-text-line')
    expect(text).toContain('STDERR-DELTA')
    expect(events.filter((event) => event.type === 'agent.message.delta').length).toBeGreaterThanOrEqual(5)
    await adapter.disconnect(session)
  })

  it('cancel 终止子进程，send 返回已收到的部分文本', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'atd-proc-cancel-'))
    const adapter = new NativeProcessAdapter()
    let seenFirstDelta = false
    const session = await adapter.connect(headlessDefinition('proc-cancel'), cwd, {
      onEvent: (event) => { if (event.type === 'agent.message.delta') seenFirstDelta = true }
    })
    const pending = adapter.send(session, 'SLOW task')
    for (let i = 0; i < 60 && !seenFirstDelta; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await adapter.cancel(session)
    const text = await pending
    expect(text).toContain('ECHO:SLOW task')
    expect(text).not.toContain('LATE')
    await adapter.disconnect(session)
  })

  it('工作目录不存在时明确失败', async () => {
    const cwd = join(tmpdir(), `atd-no-such-dir-${Date.now()}`)
    const adapter = new NativeProcessAdapter()
    await expect(
      adapter.connect(headlessDefinition('proc-cwd'), cwd, { onEvent: () => undefined })
    ).rejects.toThrow(/工作目录/)
  })
})

describe('RemoteAcpAdapter', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'atd-remote-'))

  it('缺少 remoteUrl 或 remoteTokenRef 时给出明确配置错误', async () => {
    const adapter = new RemoteAcpAdapter(new MemoryCredentialStore())
    const missingUrl = baseDefinition('remote-no-url', 'remote-acp')
    const detail = await adapter.detect(missingUrl)
    expect(detail.installed).toBe(false)
    expect(detail.detail).toContain('remoteUrl')
    await expect(adapter.connect(missingUrl, cwd, { onEvent: () => undefined })).rejects.toThrow(/remoteUrl/)

    const missingRef = { ...baseDefinition('remote-no-ref', 'remote-acp'), remoteUrl: 'https://acp.example.com/v1' }
    await expect(adapter.connect(missingRef, cwd, { onEvent: () => undefined })).rejects.toThrow(/remoteTokenRef/)
  })

  it('凭据引用无可用 token 时拒绝连接，且不伪装为本机登录态', async () => {
    const adapter = new RemoteAcpAdapter(new MemoryCredentialStore())
    const definition = {
      ...baseDefinition('remote-no-token', 'remote-acp'),
      remoteUrl: 'wss://acp.example.com/v1', remoteTokenRef: 'remote-cred'
    }
    const detect = await adapter.detect(definition)
    expect(detect.installed).toBe(false)
    expect(detect.detail).toContain('remote-cred')
    await expect(adapter.connect(definition, cwd, { onEvent: () => undefined })).rejects.toThrow(/凭据为空/)
  })
})

describe('AdapterRegistry 映射与回退', () => {
  it('按 kind 分别映射到 acp / process / remote / api-provider', () => {
    const store = new SqliteStore()
    const registry = new AdapterRegistry(store, new MemoryCredentialStore())
    expect(registry.adapterFor(baseDefinition('a', 'native-acp')).id).toBe('acp')
    expect(registry.adapterFor(baseDefinition('b', 'native-process')).id).toBe('process')
    expect(registry.adapterFor(baseDefinition('c', 'remote-acp')).id).toBe('remote')
    expect(registry.adapterFor(baseDefinition('d', 'api-provider')).id).toBe('api-provider')
    store.close()
  })

  it('ACP 连接失败且 headlessFallback 开启时回退到无头进程', async () => {
    const store = new SqliteStore()
    const registry = new AdapterRegistry(store, new MemoryCredentialStore())
    const cwd = mkdtempSync(join(tmpdir(), 'atd-fallback-'))
    const definition: AgentDefinition = {
      ...baseDefinition('fallback-agent', 'native-acp'),
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      headlessCommand: process.execPath,
      headlessArgs: [fixture],
      headlessFallback: true
    }
    store.insert('agents', definition)
    const events: EventDraft[] = []
    const session = await registry.connect('fallback-agent', cwd, { onEvent: (event) => events.push(event) })
    expect(session.protocol).toBe('stdio')
    const text = await registry.send(session.id, 'fallback-hello')
    expect(text).toContain('ECHO:fallback-hello')
    expect(events.some((event) => event.type === 'system' && event.message.includes('回退'))).toBe(true)
    await registry.disconnect(session.id)
    store.close()
  })
})

describe('API Provider 流式与模型列表', () => {
  beforeEach(() => { vi.unstubAllGlobals() })

  it('OpenAI-compatible 以 stream:true 解析 SSE data 行', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n'
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const deltas: string[] = []
    const text = await requestText(provider(), 'sk-key', 'hi', undefined, (delta) => deltas.push(delta))
    expect(text).toBe('Hello')
    expect(deltas).toEqual(['Hel', 'lo'])
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body)).stream).toBe(true)
  })

  it('Anthropic Messages 解析 content_block_delta 事件', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Anth"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ropic"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ])))
    const deltas: string[] = []
    const text = await requestText(provider('anthropic-messages'), 'sk-ant', 'hi', undefined, (delta) => deltas.push(delta))
    expect(text).toBe('Anthropic')
    expect(deltas).toEqual(['Anth', 'ropic'])
  })

  it('listModels 返回模型 ID，HTTP 失败时抛出可读错误', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: 'gpt-x' }, { id: 'gpt-y' }, {}] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ))
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new ApiProviderAdapter(() => [provider()], new MemoryCredentialStore())
    expect(await adapter.listModels(provider(), 'sk-key')).toEqual(['gpt-x', 'gpt-y'])
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://example.com/v1/models')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })))
    await expect(adapter.listModels(provider(), 'bad')).rejects.toThrow(/401|unauthorized/)
  })
})
