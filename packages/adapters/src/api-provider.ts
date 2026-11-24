import type { AgentDefinition, ApiProvider } from '@shared/index'
import { newId, nowIso } from '@shared/index'
import type { AgentAdapter, AgentSession, ConnectOptions, DetectResult, EventSink } from './types'
import { AdapterError } from './types'

export interface CredentialStore {
  get(ref: string): string | undefined
  set(ref: string, secret: string): void
  delete(ref: string): void
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>()
  get(ref: string) { return this.values.get(ref) }
  set(ref: string, secret: string) { this.values.set(ref, secret) }
  delete(ref: string) { this.values.delete(ref) }
}

const aborts = new Map<string, AbortController>()

function endpoint(provider: ApiProvider): string {
  const base = provider.baseUrl.replace(/\/$/, '')
  if (provider.protocol === 'anthropic-messages') {
    return /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`
  }
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
}

function modelsEndpoint(provider: ApiProvider): string {
  const base = provider.baseUrl.replace(/\/$/, '')
  if (provider.protocol === 'anthropic-messages') {
    return /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`
  }
  return /\/chat\/completions$/.test(base)
    ? base.replace(/\/chat\/completions$/, '/models')
    : `${base}/models`
}

function authHeaders(provider: ApiProvider, key: string): Record<string, string> {
  return provider.protocol === 'anthropic-messages'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    : { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }
}

function body(provider: ApiProvider, prompt: string, stream: boolean): Record<string, unknown> {
  return provider.protocol === 'anthropic-messages'
    ? {
      model: provider.model, max_tokens: provider.maxOutput, stream,
      messages: [{ role: 'user', content: prompt }]
    }
    : {
      model: provider.model, max_tokens: provider.maxOutput, stream,
      messages: [{ role: 'user', content: prompt }]
    }
}

/** 解析 SSE 流；OpenAI 取 choices[0].delta.content，Anthropic 取 content_block_delta 的 text。 */
async function readSse(
  response: Response,
  provider: ApiProvider,
  onDelta: (text: string) => void
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'
  let dataLines: string[] = []
  let output = ''

  const flushEvent = () => {
    const raw = dataLines.join('\n')
    dataLines = []
    const currentEvent = eventName
    eventName = 'message'
    if (!raw || raw === '[DONE]') return
    let data: {
      type?: string
      error?: { message?: string } | string
      delta?: { content?: string; text?: string; type?: string }
      choices?: Array<{ delta?: { content?: string }; text?: string }>
    }
    try { data = JSON.parse(raw) } catch { return }
    if (data.error) {
      const detail = typeof data.error === 'string' ? data.error : data.error.message ?? 'unknown'
      throw new AdapterError(`Provider ${provider.name} 流式错误: ${detail}`, 'send')
    }
    let text = ''
    if (provider.protocol === 'anthropic-messages') {
      if (currentEvent === 'content_block_delta' || data.type === 'content_block_delta') {
        text = data.delta?.text ?? ''
      }
    } else {
      text = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.text ?? ''
    }
    if (text) {
      output += text
      onDelta(text)
    }
  }

  const handleLine = (rawLine: string) => {
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith('event:')) { eventName = line.slice(6).trim(); return }
    if (line.startsWith('data:')) { dataLines.push(line.slice(5).trimStart()); return }
    if (!line && dataLines.length) flushEvent()
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        handleLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer) handleLine(buffer)
    if (dataLines.length) flushEvent()
  } finally {
    reader.releaseLock()
  }
  return output
}

/** onDelta 存在时以 stream:true 请求并逐块回调；否则保持原有非流式 JSON 解析。 */
export async function requestText(
  provider: ApiProvider,
  key: string,
  prompt: string,
  signal?: AbortSignal,
  onDelta?: (text: string) => void
): Promise<string> {
  const streaming = typeof onDelta === 'function'
  const response = await fetch(endpoint(provider), {
    method: 'POST',
    headers: authHeaders(provider, key),
    body: JSON.stringify(body(provider, prompt, streaming)),
    signal
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new AdapterError(`Provider ${provider.name} 返回 ${response.status}: ${detail}`, 'send')
  }
  const contentType = response.headers?.get?.('content-type') ?? ''
  if (streaming && contentType.includes('text/event-stream')) {
    return readSse(response, provider, onDelta!)
  }
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>
    content?: Array<{ type?: string; text?: string }>
  }
  let text = ''
  if (provider.protocol === 'anthropic-messages') {
    text = (data.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('')
  } else {
    text = data.choices?.[0]?.message?.content ?? ''
  }
  if (text && onDelta) onDelta(text)
  return text
}

export class ApiProviderAdapter implements AgentAdapter {
  readonly id = 'api-provider'
  readonly kind = 'api-provider' as const
  private readonly eventSinks = new Map<string, EventSink>()

  constructor(private readonly providers: () => ApiProvider[], private readonly credentials: CredentialStore) {}

  async detect(_definition: AgentDefinition): Promise<DetectResult> {
    return { installed: true, detail: 'API Key 通道由用户配置的 Provider 提供，费用自行承担' }
  }

  async connect(definition: AgentDefinition, cwd: string, options: ConnectOptions): Promise<AgentSession> {
    if (!definition.providerRef) throw new AdapterError('缺少 providerRef', 'connect')
    const provider = this.providers().find((item) => item.id === definition.providerRef)
    if (!provider) throw new AdapterError('未找到对应 API Provider', 'connect')
    if (!this.credentials.get(provider.credentialRef)) throw new AdapterError('未找到 API Key 凭据引用', 'connect')
    options.onEvent({ type: 'system', agentId: definition.id, message: `API Key 通道已就绪: ${provider.name} / ${provider.model}` })
    const session: AgentSession = {
      id: newId('session'), agentId: definition.id, protocol: 'http', status: 'online', cwd,
      startedAt: nowIso(), providerRef: provider.id
    }
    this.eventSinks.set(session.id, options.onEvent)
    return session
  }

  async send(session: AgentSession, prompt: string): Promise<string> {
    const provider = this.providers().find((item) => item.id === session.providerRef)
    const key = this.credentials.get(provider?.credentialRef ?? '')
    if (!provider || !key) throw new AdapterError('API Provider 或凭据不存在', 'send')
    const controller = new AbortController()
    aborts.set(session.id, controller)
    const timer = setTimeout(() => controller.abort(), provider.timeoutMs)
    const onDelta = (text: string) => this.eventSinks.get(session.id)?.({
      type: 'agent.message.delta', agentId: session.agentId, message: text
    })
    try {
      return await requestText(provider, key, prompt, controller.signal, onDelta)
    } catch (error) {
      if (controller.signal.aborted) throw new AdapterError(`API 请求超时或取消 (${provider.timeoutMs}ms)`, 'send')
      throw error
    } finally {
      clearTimeout(timer)
      aborts.delete(session.id)
    }
  }

  async cancel(session: AgentSession): Promise<void> {
    aborts.get(session.id)?.abort()
  }

  async disconnect(session: AgentSession): Promise<void> {
    aborts.get(session.id)?.abort()
    aborts.delete(session.id)
    this.eventSinks.delete(session.id)
    session.status = 'closed'
  }

  async testConnection(provider: ApiProvider, key: string): Promise<{ ok: boolean; detail: string }> {
    try {
      const text = await requestText(provider, key, '请只回复 ok 两个字母。')
      return { ok: true, detail: text.slice(0, 120) || '连接成功（空响应）' }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 返回可用模型 ID；接口错误抛出可读错误，空列表返回空数组。 */
  async listModels(provider: ApiProvider, key: string): Promise<string[]> {
    const response = await fetch(modelsEndpoint(provider), {
      method: 'GET',
      headers: authHeaders(provider, key)
    })
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300)
      throw new AdapterError(`获取模型列表失败: Provider ${provider.name} 返回 ${response.status}: ${detail}`, 'test')
    }
    const data = await response.json() as {
      data?: Array<{ id?: string }>
      models?: Array<{ id?: string }>
    }
    const items = data.data ?? data.models ?? []
    return items.map((item) => item.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
  }
}
