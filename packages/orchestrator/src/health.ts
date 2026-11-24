import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SqliteStore } from '@storage/index'
import type { AdapterRegistry } from '@adapters/index'
import { classifyAgentFailure } from '@adapters/index'
import type { AgentDefinition, AgentHealth, AgentProbeResult } from '@shared/index'
import { defaultPermissionPolicy, nowIso } from '@shared/index'

export const PROBE_PROMPT = '这是一次连通性自检。请只回复两个字：可用。不要调用任何工具，不要读写任何文件。'

export interface ProbeOptions {
  cwd?: string
  /** 连接阶段的超时，默认 45s。 */
  connectTimeoutMs?: number
  /** 等待首个完整回复的超时，默认 90s。 */
  sendTimeoutMs?: number
  /** 是否把结果写回 Agent 记录（默认写回）。 */
  persist?: boolean
}

function safeCwd(path?: string): string {
  const candidates = [path, process.env.USERPROFILE, process.cwd()].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch { /* try next */ }
  }
  const fallback = join(tmpdir(), 'agent-team-probe')
  mkdirSync(fallback, { recursive: true })
  return fallback
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}

function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(ms / 1000)}s）`)), ms)
    })
  ]).finally(() => { if (timer) clearTimeout(timer) }) as Promise<T>
}

const HEALTH_DETAIL_LIMIT = 600

/** 真实连一次、真发一句话：只有拿到文本回复才算 ready。 */
export async function probeAgent(
  store: SqliteStore,
  registry: AdapterRegistry,
  agentId: string,
  options: ProbeOptions = {}
): Promise<AgentProbeResult> {
  const definition = store.get<AgentDefinition>('agents', 'id', agentId)
  if (!definition) throw new Error(`Agent 不存在: ${agentId}`)
  const startedAt = Date.now()
  const checkedAt = nowIso()
  const base = {
    agentId: definition.id, agentName: definition.name, vendor: definition.vendor,
    role: definition.role, checkedAt
  }

  const finish = (state: AgentHealth, detail: string, reply = ''): AgentProbeResult => {
    const result: AgentProbeResult = { ...base, state, latencyMs: Date.now() - startedAt, reply, detail: detail.slice(0, HEALTH_DETAIL_LIMIT) }
    if (options.persist !== false) {
      store.update('agents', 'id', agentId, {
        health: state, healthDetail: result.detail, latencyMs: result.latencyMs, lastProbeAt: checkedAt
      })
    }
    const event = registry.emitEvent({
      type: 'probe.completed', agentId,
      message: `应答体检：${definition.name} · ${state}（${result.latencyMs}ms）`,
      data: { state, latencyMs: result.latencyMs, reply: reply.slice(0, 200), detail: result.detail }
    })
    void event
    return result
  }

  if (!definition.enabled) return finish('skipped', 'Agent 已禁用，未参与体检')
  if (definition.kind === 'api-provider') {
    return finish('error', 'API Provider 通道请在「API 模型」页用 Test 按钮验证；群聊体检只覆盖本机 Agent')
  }

  const cwd = safeCwd(options.cwd)
  let sessionId: string | undefined
  let installed = false
  try {
    const detect = await withDeadline(registry.detect(agentId), options.connectTimeoutMs ?? 45000, '安装检测')
    installed = detect.installed
    if (!detect.installed) return finish('not-installed', detect.detail || `未找到命令 ${definition.command ?? ''}`)
    // 检测会写回 commandPath，重新读取以保证 spawn 使用解析后的绝对路径。
    const latest = store.get<AgentDefinition>('agents', 'id', agentId) ?? definition
    const session = await withDeadline(
      registry.connect(agentId, cwd, {
        onEvent: () => undefined,
        permissionMode: 'auto-deny',
        policy: defaultPermissionPolicy(),
        workspacePaths: [cwd]
      }),
      options.connectTimeoutMs ?? 45000,
      `${latest.name} 连接`
    )
    sessionId = session.id
    const reply = await withDeadline(
      registry.send(session.id, PROBE_PROMPT, {}),
      options.sendTimeoutMs ?? 90000,
      `${latest.name} 应答`
    )
    const text = (reply || '').trim()
    if (!text) return finish('error', 'Agent 已连接但没有任何文本回复（可能只调用了工具）')
    // 某些 CLI 把内部错误打到 stdout 且退出码为 0，不能当成可用。
    if (/internal_error|无法启动|exec failed|ECONNREFUSED|EACCES|traceback|unexpected status/i.test(text)) {
      return finish('error', text)
    }
    return finish('ready', text.slice(0, HEALTH_DETAIL_LIMIT), text)
  } catch (error) {
    const message = errorText(error)
    const classified = classifyAgentFailure(message)
    // 已经检测到安装却起不来，不能谎报「未安装」，应显示为异常并保留启动错误。
    const state = classified === 'not-installed' && installed ? 'error' : classified
    return finish(state, message)
  } finally {
    if (sessionId) {
      try { await registry.disconnect(sessionId) } catch { /* ignore */ }
    }
  }
}

const inflight = new Map<string, Promise<AgentProbeResult>>()

/** 单飞：同一个 Agent 重复点击体检时复用进行中的请求，避免并发起多个 CLI。 */
export function probeAgentOnce(
  store: SqliteStore,
  registry: AdapterRegistry,
  agentId: string,
  options: ProbeOptions = {}
): Promise<AgentProbeResult> {
  const existing = inflight.get(agentId)
  if (existing) return existing
  const job = probeAgent(store, registry, agentId, options).finally(() => inflight.delete(agentId))
  inflight.set(agentId, job)
  return job
}

export interface ProbeAllOptions extends ProbeOptions {
  teamId?: string
  agentIds?: string[]
  concurrency?: number
  onResult?: (result: AgentProbeResult) => void
}

/** 团队内优先级：群成员优先；没有成员时体检全部已启用 Agent。 */
export function resolveTeamAgentIds(store: SqliteStore, teamId?: string): string[] {
  if (!teamId) return store.agents().filter((agent) => agent.enabled).map((agent) => agent.id)
  const members = store.teamMembers(teamId)
  if (members.length) {
    return [...members]
      .sort((a, b) => a.priority - b.priority)
      .map((member) => member.agentId)
      .filter((id, index, list) => list.indexOf(id) === index)
  }
  return store.agents().filter((agent) => agent.enabled).map((agent) => agent.id)
}

export async function probeAgents(
  store: SqliteStore,
  registry: AdapterRegistry,
  options: ProbeAllOptions = {}
): Promise<AgentProbeResult[]> {
  const ids = (options.agentIds?.length ? options.agentIds : resolveTeamAgentIds(store, options.teamId)).filter(Boolean)
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 6))
  const results: AgentProbeResult[] = []
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= ids.length) return
      const agentId = ids[index]
      try {
        const result = await probeAgentOnce(store, registry, agentId, options)
        results.push(result)
        options.onResult?.(result)
      } catch (error) {
        const fallback: AgentProbeResult = {
          agentId, agentName: store.get<AgentDefinition>('agents', 'id', agentId)?.name ?? agentId,
          vendor: '', role: '', state: 'error', latencyMs: 0, reply: '',
          detail: errorText(error).slice(0, HEALTH_DETAIL_LIMIT), checkedAt: nowIso()
        }
        results.push(fallback)
        options.onResult?.(fallback)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker))
  return results.sort((a, b) => ids.indexOf(a.agentId) - ids.indexOf(b.agentId))
}
