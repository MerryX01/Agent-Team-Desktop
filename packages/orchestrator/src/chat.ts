import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SqliteStore } from '@storage/index'
import type { AdapterRegistry, EventDraft } from '@adapters/index'
import { classifyAgentFailure } from '@adapters/index'
import { ROLE_CATALOG } from '@shared/index'
import type {
  AgentDefinition, AgentHealth, AgentMessage, ChatGateCheck, ChatParticipant, ChatRun,
  Task, Team, TeamMember
} from '@shared/index'
import { defaultPermissionPolicy, newId, nowIso } from '@shared/index'
import { sendMessage } from './messaging'

export interface ChatDispatchOptions {
  teamId: string
  content: string
  targetAgentId?: string
  cwd?: string
  /** 最多同时应答的成员数，默认 4。 */
  maxParticipants?: number
  /** 单次发言超时（含连接），默认 240s。 */
  timeoutMs?: number
}

export interface ChatDispatchResult {
  runId: string
  chatRunId: string
  taskId: string
  status: ChatRun['status']
  participants: ChatParticipant[]
  deliverable: string
  deliverableAgentId?: string
  gate: ChatRun['gate']
  durationMs: number
}

export interface ChatEmitter {
  emit(draft: EventDraft, runId?: string, taskId?: string): void
}

const CHAT_HISTORY_LIMIT = 8
const PROMPT_REPLY_SOFT_LIMIT = 1200
const SYNTHESIS_LIMIT = 6000
const BAD_HEALTH: AgentHealth[] = ['no-quota', 'login-required', 'not-installed', 'timeout', 'error', 'skipped']

const HEALTH_TEXT: Record<AgentHealth, string> = {
  unknown: '未体检', ready: '可用', 'no-quota': '无额度（已跳过）',
  'login-required': '未登录（已跳过）', 'not-installed': '未安装（已跳过）',
  timeout: '应答超时（已跳过）', error: '异常（已跳过）', skipped: '已禁用（已跳过）'
}

function clip(text: string, max: number): string {
  const value = (text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function resolveCwd(path?: string): string {
  const candidates = [path, process.env.USERPROFILE, process.cwd()].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isDirectory()) return candidate } catch { /* next */ }
  }
  const fallback = join(tmpdir(), 'agent-team-chat')
  mkdirSync(fallback, { recursive: true })
  return fallback
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function roleDuty(role: string): string {
  const entry = ROLE_CATALOG.find((item) => item.value === role)
  return entry?.duty ?? '按群主指令完成职责范围内的工作，并明确说明你的依据与产出。'
}

function mentionedNames(text: string): string[] {
  const names: string[] = []
  const regex = /@([^\s@,，。:：;；、()（）\[\]【】]+)/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) names.push(match[1].trim())
  return [...new Set(names)]
}

interface MemberView {
  agent: AgentDefinition
  role: string
  isLead: boolean
}

function rosterForTeam(store: SqliteStore, team: Team): MemberView[] {
  const agents = store.agents()
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const members = store.teamMembers(team.id)
  if (members.length === 0) {
    return agents.map((agent) => ({ agent, role: agent.role || 'developer', isLead: Boolean(agent.isLead) }))
  }
  return [...members]
    .sort((a, b) => a.priority - b.priority)
    .flatMap((member: TeamMember) => {
      const agent = byId.get(member.agentId)
      if (!agent) return []
      return [{ agent, role: member.role || agent.role || 'developer', isLead: member.agentId === team.leadAgentId || Boolean(agent.isLead) }]
    })
}

function historyContext(store: SqliteStore, teamId: string): string {
  const messages = store.messages(teamId).slice(-CHAT_HISTORY_LIMIT)
  if (messages.length === 0) return '（暂无历史消息）'
  return messages.map((message: AgentMessage) => {
    const who = message.fromAgentId === 'user' ? '群主' : (message.fromAgentId ?? message.sender ?? '成员')
    return `${who}：${clip(message.content.replace(/\s+/g, ' '), 220)}`
  }).join('\n')
}

/** 第一轮发言的提示词：明确身份、群成员、最近群聊与协作方式。 */
function buildRoundPrompt(input: {
  team: Team
  member: MemberView
  roster: MemberView[]
  content: string
  history: string
  handoffFrom?: { agentId: string; name: string; content: string }
}): string {
  const { team, member, roster, content, history, handoffFrom } = input
  const peers = roster
    .filter((item) => item.agent.id !== member.agent.id)
    .map((item) => `- ${item.agent.name}（${item.role}）${item.isLead ? ' · Lead' : ''}：${HEALTH_TEXT[item.agent.health ?? 'unknown']}`)
    .join('\n') || '（本轮只有你）'
  const handoff = handoffFrom
    ? `\n【成员转交】${handoffFrom.name} 把以下内容转交给你：\n${clip(handoffFrom.content, 1200)}\n`
    : ''
  return [
    `【群聊】${team.name}`,
    `你是「${member.agent.name}」，角色 ${member.role}，职责：${roleDuty(member.role)}。`,
    '',
    '【群成员】',
    peers,
    '',
    '【最近群聊】',
    history,
    '',
    '【群主指令】',
    content,
    handoff,
    '【本轮要求】',
    '1. 用中文直接回复群主，不要复述本提示。',
    `2. 先给 1-3 行结论/产出，再补充关键依据；一般不超过 ${PROMPT_REPLY_SOFT_LIMIT} 字。`,
    '3. 群聊阶段只讨论与产出文本，不要修改文件、不要执行破坏性命令。',
    '4. 如果需要其他成员接手，在最后单独一行写：@成员名 需要他做什么。'
  ].join('\n')
}

function buildSynthesisPrompt(input: {
  team: Team
  content: string
  replies: Array<{ name: string; role: string; content: string }>
  members: MemberView[]
}): string {
  const { team, content, replies, members } = input
  const roster = members.map((item) => `- ${item.agent.name}（${item.role}）`).join('\n')
  const body = replies
    .map((reply) => `### ${reply.name}（${reply.role}）\n${clip(reply.content, 3000)}`)
    .join('\n\n')
  return [
    `【群聊收口】${team.name}`,
    '你是本轮协同的汇总人（Lead）。请把群成员的回复整合成一份可直接交付给群主的最终成果。',
    '',
    '【群主原始指令】',
    content,
    '',
    '【群成员】',
    roster || '（无）',
    '',
    '【成员回复】',
    body,
    '',
    '【交付要求】',
    '1. 用中文 Markdown 输出，结构固定为：## 结论 / ## 分工与依据 / ## 风险与未完成项 / ## 下一步。',
    '2. 只整合成员真实给出的信息；不要把没做的说成做了，缺失就写进「风险与未完成项」。',
    '3. 若成员结论冲突，明确列出分歧并给出你的判断依据。',
    '4. 不要输出与本任务无关的客套话。'
  ].join('\n')
}

export class ChatDispatcher {
  private readonly active = new Map<string, Set<string>>()
  private readonly cancelled = new Set<string>()

  constructor(
    private readonly store: SqliteStore,
    private readonly registry: AdapterRegistry,
    private readonly emitter: ChatEmitter
  ) {}

  cancel(runId: string): boolean {
    this.cancelled.add(runId)
    for (const sessionId of this.active.get(runId) ?? []) void this.registry.cancel(sessionId)
    return true
  }

  private emitOf(runId: string, taskId: string) {
    return (draft: EventDraft) => this.emitter.emit(draft, runId, taskId)
  }

  async dispatch(options: ChatDispatchOptions): Promise<ChatDispatchResult> {
    const startedAt = Date.now()
    const team = this.store.get<Team>('teams', 'id', options.teamId)
    if (!team) throw new Error(`团队不存在: ${options.teamId}`)
    const content = options.content.trim()
    if (!content) throw new Error('群主指令不能为空')

    const runId = newId('run')
    const chatRunId = newId('chatrun')
    const taskId = newId('task')
    const cwd = resolveCwd(options.cwd || team.defaultWorkspace)
    const roster = rosterForTeam(this.store, team)
    if (roster.length === 0) throw new Error('群里还没有 Agent，请先在「建群与成员」拉成员入群')

    const targeted = options.targetAgentId ? roster.filter((item) => item.agent.id === options.targetAgentId) : []
    if (options.targetAgentId && targeted.length === 0) throw new Error('指定的 Agent 不在本群')

    const pool = targeted.length ? targeted : roster
    const maxParticipants = Math.max(1, options.maxParticipants ?? 4)
    const selected: MemberView[] = []
    const skipped: Array<{ member: MemberView; reason: string }> = []
    for (const member of pool) {
      const health = member.agent.health ?? 'unknown'
      const unavailable = BAD_HEALTH.includes(health) || !member.agent.enabled
      if (unavailable) {
        skipped.push({ member, reason: HEALTH_TEXT[health] })
        continue
      }
      if (!targeted.length && selected.length >= maxParticipants) {
        skipped.push({ member, reason: '本轮未入选（并发上限）' })
        continue
      }
      selected.push(member)
    }

    const participants: ChatParticipant[] = pool.map((member) => {
      const skip = skipped.find((item) => item.member.agent.id === member.agent.id)
      return {
        agentId: member.agent.id,
        name: member.agent.name,
        role: member.role,
        status: skip ? 'skipped' : 'pending',
        reply: '', error: '', skipReason: skip?.reason ?? '', latencyMs: 0
      }
    })

    const chatRun: ChatRun = {
      id: chatRunId, runId, teamId: team.id, content, status: 'running',
      participants, deliverable: '', gate: { passed: false, reasons: [], checks: [] },
      durationMs: 0, createdAt: nowIso()
    }
    this.store.insert('chat_runs', chatRun)
    sendMessage(this.store, {
      teamId: team.id, runId, taskId, fromAgentId: 'user', sender: '群主',
      content, summary: clip(content, 60), kind: 'user'
    })

    this.emitter.emit({
      type: 'chat.dispatch.started',
      message: `群聊协同开始：${selected.length} 位成员应答${skipped.length ? `，${skipped.length} 位跳过` : ''}`,
      data: {
        chatRunId, runId, taskId, content,
        participants: participants.map((item) => ({ ...item })),
        skipped: skipped.map((item) => ({ agentId: item.member.agent.id, name: item.member.agent.name, reason: item.reason }))
      }
    }, runId, taskId)
    for (const item of skipped) {
      this.emitter.emit({
        type: 'chat.agent.skipped', agentId: item.member.agent.id,
        message: `${item.member.agent.name} 已跳过：${item.reason}`,
        data: { agentId: item.member.agent.id, name: item.member.agent.name, reason: item.reason }
      }, runId, taskId)
    }

    const replies: Array<{ agentId: string; name: string; role: string; content: string }> = []
    const history = historyContext(this.store, team.id)
    const emit = this.emitOf(runId, taskId)
    const timeoutMs = options.timeoutMs ?? 240000

    const speak = async (member: MemberView, handoffFrom?: { agentId: string; name: string; content: string }): Promise<ChatParticipant> => {
      const messageId = newId('msg')
      const participant: ChatParticipant = participants.find((item) => item.agentId === member.agent.id) ?? {
        agentId: member.agent.id, name: member.agent.name, role: member.role,
        status: 'pending', reply: '', error: '', skipReason: '', latencyMs: 0
      }
      participant.status = 'replying'
      participant.messageId = messageId
      const started = Date.now()
      emit({
        type: 'chat.agent.started', agentId: member.agent.id,
        message: `${member.agent.name} 开始思考`,
        data: { messageId, agentId: member.agent.id, name: member.agent.name, role: member.role, phase: 'connecting' }
      })

      let sessionId: string | undefined
      let output = ''
      try {
        if (this.cancelled.has(runId)) throw new Error('本轮已被群主取消')
        const session = await this.registry.connect(member.agent.id, cwd, {
          onEvent: (draft) => {
            if (draft.type === 'agent.message.delta') {
              output += draft.message
              emit({
                type: 'chat.agent.delta', agentId: member.agent.id,
                message: draft.message,
                data: { messageId, agentId: member.agent.id, delta: draft.message }
              })
              return
            }
            if (draft.type === 'agent.thought.delta') {
              emit({
                type: 'chat.agent.thought', agentId: member.agent.id,
                message: draft.message,
                data: { messageId, agentId: member.agent.id, delta: draft.message }
              })
              return
            }
            if (draft.type === 'agent.tool.started' || draft.type === 'agent.tool.finished') {
              emit({
                type: 'chat.agent.tool', agentId: member.agent.id,
                message: draft.message,
                data: {
                  messageId, agentId: member.agent.id, tool: draft.message,
                  status: draft.type === 'agent.tool.started' ? 'running' : 'done'
                }
              })
              return
            }
            if (draft.type === 'file.changed') {
              emit({
                type: 'chat.agent.tool', agentId: member.agent.id,
                message: `文件变更：${String(draft.data?.path ?? '')}`,
                data: { messageId, agentId: member.agent.id, tool: `文件变更 ${String(draft.data?.path ?? '')}`, status: 'done' }
              })
              return
            }
            if (draft.type === 'policy.denied') {
              emit({
                type: 'chat.agent.tool', agentId: member.agent.id,
                message: `策略拦截：${draft.message}`,
                data: { messageId, agentId: member.agent.id, tool: `策略拦截 ${clip(draft.message, 60)}`, status: 'denied' }
              })
            }
          },
          permissionMode: 'auto-deny',
          policy: defaultPermissionPolicy(),
          workspacePaths: [cwd],
        })
        sessionId = session.id
        if (!this.active.has(runId)) this.active.set(runId, new Set())
        this.active.get(runId)!.add(sessionId)

        const prompt = buildRoundPrompt({ team, member, roster, content, history, handoffFrom })
        const reply = (await this.registry.send(session.id, prompt, { taskId, runId })).trim()
        if (!reply) throw new Error('Agent 没有返回任何文本（可能只调用了工具）')
        participant.status = 'replied'
        participant.reply = reply
        participant.latencyMs = Date.now() - started
        replies.push({ agentId: member.agent.id, name: member.agent.name, role: member.role, content: reply })
        sendMessage(this.store, {
          teamId: team.id, runId, taskId, fromAgentId: member.agent.id,
          content: reply, summary: `${member.role} · ${member.agent.name}`,
          kind: 'coordination', createdAt: nowIso()
        })
        this.emitter.emit({
          type: 'chat.agent.completed', agentId: member.agent.id,
          message: `${member.agent.name} 已回复（${participant.latencyMs}ms）`,
          data: { messageId, agentId: member.agent.id, name: member.agent.name, reply, latencyMs: participant.latencyMs }
        }, runId, taskId)
        return participant
      } catch (error) {
        const message = errorText(error)
        const state = classifyAgentFailure(message)
        participant.status = 'failed'
        participant.error = message.slice(0, 800)
        participant.latencyMs = Date.now() - started
        this.store.update('agents', 'id', member.agent.id, {
          health: state, healthDetail: message.slice(0, 600), latencyMs: participant.latencyMs, lastProbeAt: nowIso()
        })
        this.emitter.emit({
          type: 'chat.agent.failed', agentId: member.agent.id,
          message: `${member.agent.name} 应答失败：${clip(message, 120)}`,
          data: { messageId, agentId: member.agent.id, name: member.agent.name, error: participant.error, state }
        }, runId, taskId)
        return participant
      } finally {
        if (sessionId) {
          try { await this.registry.disconnect(sessionId) } catch { /* ignore */ }
          this.active.get(runId)?.delete(sessionId)
        }
      }
    }

    // 第一轮：健康成员并行发言，思考/工具/正文全部实时外发。
    const queue = [...selected]
    const concurrency = Math.max(1, Math.min(queue.length, 4))
    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        const member = queue.shift()
        if (!member) return
        await speak(member)
      }
    })
    await Promise.all(workers)

    // 第二轮：只处理明确的 @转交，最多 2 次，避免无限对话。
    let handoffs = 0
    for (const reply of [...replies]) {
      if (handoffs >= 2) break
      const names = mentionedNames(reply.content)
      for (const name of names) {
        if (handoffs >= 2) break
        const target = selected.find((item) => item.agent.name === name || item.agent.name.startsWith(name))
        if (!target || target.agent.id === reply.agentId) continue
        const already = participants.find((item) => item.agentId === target.agent.id && item.status === 'replied')
        if (already) continue
        handoffs += 1
        this.emitter.emit({
          type: 'chat.agent.handoff', agentId: reply.agentId,
          message: `${reply.name} 将话题转交给 ${target.agent.name}`,
          data: { fromAgentId: reply.agentId, fromName: reply.name, toAgentId: target.agent.id, toName: target.agent.name }
        }, runId, taskId)
        await speak(target, { agentId: reply.agentId, name: reply.name, content: reply.content })
      }
    }

    // 收口：Lead 优先，否则由架构/规划角色收口；全部失败则明确不交付。
    const replied = participants.filter((item) => item.status === 'replied')
    const repliedIds = new Set(replied.map((item) => item.agentId))
    const leadMember = selected.find((item) => item.isLead && repliedIds.has(item.agent.id))
      ?? selected.find((item) => /architect|planner/i.test(item.role) && repliedIds.has(item.agent.id))
      ?? selected.find((item) => repliedIds.has(item.agent.id))

    let deliverable = ''
    let deliverableAgentId: string | undefined
    let deliverableMessageId: string | undefined
    let synthesisState: 'ok' | 'failed' | 'skipped' = 'skipped'
    let synthesisError = ''

    if (leadMember && replies.length) {
      const messageId = newId('msg')
      deliverableMessageId = messageId
      deliverableAgentId = leadMember.agent.id
      this.emitter.emit({
        type: 'chat.agent.started', agentId: leadMember.agent.id,
        message: `${leadMember.agent.name} 正在汇总交付`,
        data: { messageId, agentId: leadMember.agent.id, name: leadMember.agent.name, role: leadMember.role, phase: 'synthesis' }
      }, runId, taskId)
      let sessionId: string | undefined
      try {
        const session = await this.registry.connect(leadMember.agent.id, cwd, {
          onEvent: (draft) => {
            if (draft.type === 'agent.message.delta') {
              deliverable += draft.message
              emit({
                type: 'chat.agent.delta', agentId: leadMember.agent.id, message: draft.message,
                data: { messageId, agentId: leadMember.agent.id, delta: draft.message, synthesis: true }
              })
              return
            }
            if (draft.type === 'agent.thought.delta') {
              emit({
                type: 'chat.agent.thought', agentId: leadMember.agent.id, message: draft.message,
                data: { messageId, agentId: leadMember.agent.id, delta: draft.message, synthesis: true }
              })
              return
            }
            if (draft.type === 'agent.tool.started' || draft.type === 'agent.tool.finished') {
              emit({
                type: 'chat.agent.tool', agentId: leadMember.agent.id, message: draft.message,
                data: { messageId, agentId: leadMember.agent.id, tool: draft.message, status: draft.type === 'agent.tool.started' ? 'running' : 'done' }
              })
            }
          },
          permissionMode: 'auto-deny',
          policy: defaultPermissionPolicy(),
          workspacePaths: [cwd],
        })
        sessionId = session.id
        const prompt = buildSynthesisPrompt({ team, content, replies, members: selected })
        deliverable = (await this.registry.send(session.id, prompt, { taskId, runId })).trim()
        if (!deliverable) throw new Error('汇总人没有返回交付内容')
        synthesisState = 'ok'
        sendMessage(this.store, {
          teamId: team.id, runId, taskId, fromAgentId: leadMember.agent.id,
          content: deliverable, summary: '最终交付', kind: 'deliverable', createdAt: nowIso()
        })
        this.emitter.emit({
          type: 'chat.agent.completed', agentId: leadMember.agent.id,
          message: `${leadMember.agent.name} 已产出交付物`,
          data: { messageId, agentId: leadMember.agent.id, name: leadMember.agent.name, reply: deliverable, synthesis: true }
        }, runId, taskId)
      } catch (error) {
        synthesisState = 'failed'
        synthesisError = errorText(error).slice(0, 800)
        this.emitter.emit({
          type: 'chat.agent.failed', agentId: leadMember.agent.id,
          message: `汇总失败：${clip(synthesisError, 120)}`,
          data: { messageId, agentId: leadMember.agent.id, name: leadMember.agent.name, error: synthesisError, synthesis: true }
        }, runId, taskId)
      } finally {
        if (sessionId) {
          try { await this.registry.disconnect(sessionId) } catch { /* ignore */ }
        }
      }
    } else if (replies.length) {
      synthesisError = '没有可用的汇总人（Lead 未应答）'
    }

    // ---------------- 交付门禁 ----------------
    const checks: ChatGateCheck[] = []
    const failedParticipants = participants.filter((item) => item.status === 'failed')
    const repliedParticipants = participants.filter((item) => item.status === 'replied')
    checks.push({
      key: 'agents-replied', label: '至少 1 个 Agent 完成应答', ok: repliedParticipants.length > 0,
      detail: `${repliedParticipants.length}/${participants.filter((item) => item.status !== 'skipped').length} 位应答`
    })
    checks.push({
      key: 'no-failed', label: '应到成员无失败', ok: failedParticipants.length === 0,
      detail: failedParticipants.length ? `${failedParticipants.map((item) => item.name).join('、')} 失败` : '无失败'
    })
    checks.push({
      key: 'synthesis', label: 'Lead 已产出综合交付物', ok: synthesisState === 'ok' && deliverable.length >= 20,
      detail: synthesisState === 'ok' ? `${deliverable.length} 字` : (synthesisError || '未生成交付物')
    })
    if (options.targetAgentId) {
      const target = participants.find((item) => item.agentId === options.targetAgentId)
      checks.push({
        key: 'target-replied', label: '指定对象已亲自应答', ok: target?.status === 'replied',
        detail: target ? `${target.name}：${target.status === 'replied' ? '已应答' : (target.skipReason || target.error || '未应答')}` : '指定对象缺失'
      })
    }
    checks.push({
      key: 'not-cancelled', label: '本轮未被取消', ok: !this.cancelled.has(runId), detail: this.cancelled.has(runId) ? '已取消' : '正常完成'
    })

    const reasons = checks.filter((check) => !check.ok).map((check) => `${check.label}：${check.detail}`)
    const passed = reasons.length === 0
    const status: ChatRun['status'] = passed ? 'completed' : (repliedParticipants.length ? 'partial' : 'failed')

    const durationMs = Date.now() - startedAt
    const finalRun: ChatRun = {
      ...chatRun,
      status,
      participants,
      deliverable,
      deliverableAgentId,
      deliverableMessageId,
      gate: { passed, reasons, checks },
      durationMs,
      completedAt: nowIso()
    }
    this.store.insert('chat_runs', finalRun)

    // 任务执行页保留一条可追溯记录；未通过门禁的任务明确 blocked。
    const task: Task = {
      taskId, teamId: team.id, title: `群聊协同：${clip(content, 40)}`,
      description: content, assigneeAgentId: deliverableAgentId ?? selected[0]?.agent.id,
      status: passed ? 'completed' : 'failed',
      boardColumn: passed ? 'done' : 'blocked',
      reviewState: passed ? 'approved' : 'none',
      approvalRequired: false,
      actionMode: 'do', priority: 0, dependsOn: [],
      inputContext: `chat-run:${chatRunId}`,
      outputSummary: passed ? deliverable : '',
      errorMessage: passed ? undefined : reasons.join('；'),
      createdAt: nowIso(),
      startedAt: new Date(startedAt).toISOString(),
      completedAt: nowIso()
    }
    this.store.insert('tasks', task)

    const result: ChatDispatchResult = {
      runId, chatRunId, taskId, status,
      participants, deliverable, deliverableAgentId,
      gate: finalRun.gate, durationMs
    }
    this.emitter.emit({
      type: 'chat.dispatch.completed',
      message: passed
        ? `本轮协同完成，已生成交付物（${durationMs}ms）`
        : `本轮未完成，禁止交付：${reasons.join('；')}`,
      data: { result }
    }, runId, taskId)

    return result
  }
}
