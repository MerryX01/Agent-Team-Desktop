import type { SqliteStore } from '@storage/index'
import type { AgentDefinition, AgentMessage, Task, Team } from '@shared/index'
import { RESERVED_LEAD_ROLES } from '@shared/index'
import type { RolePreset } from '@shared/index'
import { buildActionModeInstruction, resolveActionMode } from './actionMode'

const MAX_BRIEFING_CHARS = 4000
const ACTIONABLE_EXTRA_LIMIT = 4
const AWARENESS_LIMIT = 6
const DEPENDENCY_LIMIT = 8
const MEMORY_LIMIT = 3
const MESSAGE_LIMIT = 4

const ROLE_DUTIES: Partial<Record<RolePreset, string>> = {
  architect: '负责架构设计与技术决策，输出方案、边界与关键取舍。',
  reviewer: '负责审查结果与质量把关，指出问题与改进建议，不直接改动实现。',
  developer: '负责实现功能与修复问题，在工作区内改动并遵守权限策略。',
  qa: '负责验证与测试，给出可复现步骤、预期结果与结论。',
  researcher: '负责调研与资料整理，输出结论及其依据。',
  docs: '负责文档撰写与整理，保持表述清晰准确。',
  auditor: '负责合规与风险审查，列出发现、依据与整改建议。',
  optimizer: '负责性能与流程优化，给出可衡量的改进建议。'
}
const LEAD_DUTY = '负责统筹协调、分派任务、跟进阻塞并汇总结论。'
const GENERIC_DUTY = '请按任务描述完成职责范围内的工作，并及时汇报结果。'

interface RosterEntry {
  agentId: string
  name: string
  role: string
  workflow?: string
  isLead: boolean
}

function isReservedLeadRole(role?: string): boolean {
  const normalized = (role ?? '').trim().toLowerCase()
  return (RESERVED_LEAD_ROLES as readonly string[]).includes(normalized)
}

function isLeadEntry(team: Team, agentId: string, role: string, agent?: AgentDefinition): boolean {
  return agentId === team.leadAgentId
    || Boolean(agent?.isLead)
    || isReservedLeadRole(role)
    || isReservedLeadRole(agent?.role)
}

/** team_members 优先；没有成员记录时回退到 agents。姓名一律取自 storage 中的记录。 */
function collectRoster(store: SqliteStore, team: Team): RosterEntry[] {
  const agents = store.agents()
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const members = store.teamMembers(team.id)

  if (members.length > 0) {
    return members.map((member) => {
      const agent = byId.get(member.agentId)
      return {
        agentId: member.agentId,
        name: agent?.name || member.agentId,
        role: member.role || agent?.role || 'developer',
        workflow: member.workflow || agent?.workflow || undefined,
        isLead: isLeadEntry(team, member.agentId, member.role, agent)
      }
    })
  }

  return agents.map((agent) => ({
    agentId: agent.id,
    name: agent.name,
    role: agent.role || 'developer',
    workflow: agent.workflow || undefined,
    isLead: isLeadEntry(team, agent.id, agent.role, agent)
  }))
}

function clip(value: string | undefined, max: number): string {
  const text = (value ?? '').trim()
  if (!text) return '（无）'
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function isActionableTask(task: Task): boolean {
  return task.status === 'running'
    || task.status === 'failed'
    || task.status === 'waiting_approval'
    || task.boardColumn === 'in_progress'
    || task.boardColumn === 'blocked'
    || task.reviewState === 'changes_requested'
}

function byImportance(a: Task, b: Task): number {
  return b.priority - a.priority || a.createdAt.localeCompare(b.createdAt)
}

/** 按最新顺序返回团队消息；兼容当前存储实现中排序字段与列名不一致的情况。 */
function teamMessages(store: SqliteStore, teamId: string): AgentMessage[] {
  try {
    return store.messages(teamId).slice().reverse()
  } catch {
    return store.all<AgentMessage>('messages', 'teamId = ? ORDER BY timestamp DESC', [teamId])
  }
}

/** 名册简报：强调精确姓名与快照性质，保留 Lead 识别。 */
export function buildRosterBriefing(store: SqliteStore, team: Team, actorAgentId?: string): string {
  const entries = collectRoster(store, team)
  const leadIds = entries.filter((entry) => entry.isLead).map((entry) => entry.agentId)
  const youId = actorAgentId ?? team.leadAgentId ?? leadIds[0]
  const lines = [
    `【团队名册快照 | ${team.name}】`,
    '以下姓名为精确姓名，提及、转交或分派时必须原样使用，不得杜撰、猜测或改写接收人。',
    '本名册只是当前快照，不代表成员在线或可用；请以实际通信结果为准。',
    '成员：'
  ]

  if (entries.length === 0) lines.push('- （暂无成员）')

  for (const entry of entries) {
    const tags: string[] = []
    if (entry.isLead) tags.push('[team lead]')
    if (entry.agentId === youId) tags.push('[你]')
    lines.push(`- ${entry.name} (role: ${entry.role})${tags.length ? ` ${tags.join(' ')}` : ''}`)
    if (entry.workflow?.trim()) {
      for (const line of entry.workflow.trim().split(/\r?\n/)) {
        lines.push(`  工作流：${line.trim()}`)
      }
    }
  }
  return lines.join('\n')
}

/**
 * 任务简报：角色职责 + 动作模式 + Actionable / Awareness 议程 + 依赖、记忆与消息摘要。
 * 总长度约 4000 字符，超限时按优先级裁剪并在末尾标注省略数量。
 */
export function buildTaskBriefing(store: SqliteStore, team: Team, task: Task, actorAgentId?: string): string {
  const roster = collectRoster(store, team)
  const ownerId = actorAgentId ?? task.assigneeAgentId
  const ownerAgent = ownerId ? store.get<AgentDefinition>('agents', 'id', ownerId) : undefined
  const ownerEntry = roster.find((entry) => entry.agentId === ownerId)
  const role = ownerEntry?.role ?? ownerAgent?.role ?? 'developer'
  const workflow = ownerEntry?.workflow ?? ownerAgent?.workflow
  const duty = ROLE_DUTIES[role as RolePreset] ?? (isReservedLeadRole(role) ? LEAD_DUTY : GENERIC_DUTY)
  const modeInstruction = buildActionModeInstruction(resolveActionMode(task, team), roster.map((entry) => entry.name))

  const allTasks = store.tasks(team.id)
  const actionableOthers = allTasks
    .filter((item) => item.taskId !== task.taskId && item.assigneeAgentId === ownerId && isActionableTask(item))
    .sort(byImportance)
  const actionableIds = new Set([task.taskId, ...actionableOthers.map((item) => item.taskId)])
  const awarenessTasks = allTasks.filter((item) => !actionableIds.has(item.taskId)).sort(byImportance)
  const dependencies = (task.dependsOn ?? [])
    .map((id) => store.get<Task>('tasks', 'taskId', id))
    .filter((item): item is Task => Boolean(item))
  const memory = store.memory('team', team.id)
  const messages = teamMessages(store, team.id)

  const baseOmitted = Math.max(0, actionableOthers.length - ACTIONABLE_EXTRA_LIMIT)
    + Math.max(0, awarenessTasks.length - AWARENESS_LIMIT)
    + Math.max(0, dependencies.length - DEPENDENCY_LIMIT)
    + Math.max(0, memory.length - MEMORY_LIMIT)
    + Math.max(0, messages.length - MESSAGE_LIMIT)
  let omitted = baseOmitted
  let awarenessCount = Math.min(awarenessTasks.length, AWARENESS_LIMIT)
  let memoryCount = Math.min(memory.length, MEMORY_LIMIT)
  let messageCount = Math.min(messages.length, MESSAGE_LIMIT)

  const render = (): string => {
    const lines: string[] = [
      `【任务简报 | ${team.name}】`,
      `角色职责（${role}）：${duty}${workflow?.trim() ? ` 工作流：${workflow.trim().replace(/\s+/g, ' ')}` : ''}`,
      modeInstruction,
      '',
      '【Actionable｜需要你处理】',
      `- 当前任务「${clip(task.title, 80)}」[${task.status}] ${clip(task.description, 250)}`
    ]
    if (task.inputContext.trim()) lines.push(`  背景：${clip(task.inputContext, 200)}`)
    if (task.outputSummary.trim()) lines.push(`  已有输出：${clip(task.outputSummary, 200)}`)
    if (actionableOthers.length === 0) {
      lines.push('- 除当前任务外，暂无同一负责人需要处理的相关任务。')
    } else {
      for (const item of actionableOthers.slice(0, ACTIONABLE_EXTRA_LIMIT)) {
        lines.push(`- 相关任务「${clip(item.title, 80)}」[${item.status}] ${clip(item.description, 120)}${item.errorMessage ? ` 异常：${clip(item.errorMessage, 100)}` : ''}`)
      }
    }

    lines.push('', '【Awareness｜供你了解】')
    if (awarenessCount === 0) {
      lines.push('- 暂无其他任务。')
    } else {
      for (const item of awarenessTasks.slice(0, awarenessCount)) {
        lines.push(`- ${clip(item.title, 80)} [${item.status}] 负责人：${item.assigneeAgentId ?? '未分配'} ${clip(item.description, 100)}`)
      }
    }

    lines.push('', '【依赖与阻塞】')
    if (dependencies.length === 0) {
      lines.push('- 无显式依赖。')
    } else {
      for (const dep of dependencies.slice(0, DEPENDENCY_LIMIT)) {
        const ready = dep.status === 'completed'
        lines.push(`- ${ready ? '已就绪' : '未完成'}：${clip(dep.title, 80)} [${dep.status}]${ready && dep.outputSummary.trim() ? ` 输出：${clip(dep.outputSummary, 120)}` : ''}`)
      }
    }

    lines.push('', '【最近团队记忆】')
    if (memoryCount === 0) {
      lines.push('- 暂无团队记忆。')
    } else {
      for (const entry of memory.slice(0, memoryCount)) lines.push(`- ${clip(entry.key, 60)}：${clip(entry.value, 140)}`)
    }

    lines.push('', '【最近消息】')
    if (messageCount === 0) {
      lines.push('- 暂无团队消息。')
    } else {
      for (const message of messages.slice(0, messageCount)) {
        lines.push(`- ${clip(message.sender, 30)}：${clip(message.summary || message.content, 140)}`)
      }
    }
    return lines.join('\n')
  }

  // 先裁剪低优先级分区，再按需硬截断，确保简报不超长。
  let text = render()
  while (text.length > MAX_BRIEFING_CHARS - 80) {
    if (awarenessCount > 0) { awarenessCount -= 1; omitted += 1 }
    else if (memoryCount > 0) { memoryCount -= 1; omitted += 1 }
    else if (messageCount > 0) { messageCount -= 1; omitted += 1 }
    else break
    text = render()
  }
  const note = omitted > 0 ? `\n\n[已省略 ${omitted} 项内容以控制简报长度]` : ''
  if (text.length + note.length > MAX_BRIEFING_CHARS) {
    const hardNote = omitted > 0
      ? `\n\n[已省略 ${omitted} 项内容，并截断以控制长度]`
      : '\n\n[内容过长，已截断以控制简报长度]'
    return `${text.slice(0, MAX_BRIEFING_CHARS - hardNote.length)}${hardNote}`
  }
  return text + note
}

/** 依赖解除后发给任务负责人的通知。 */
export function buildDependencyNotice(task: Task, resolvedTask: Task): string {
  const stateLabel: Record<string, string> = {
    completed: '已完成', cancelled: '已取消', failed: '已终止', waiting_approval: '已通过审批'
  }
  const resolvedState = stateLabel[resolvedTask.status] ?? '状态已更新'
  return [
    '【依赖解除通知】',
    `前置任务「${resolvedTask.title}」${resolvedState}，你负责的任务「${task.title}」已不再被它阻塞。`,
    `任务要求：${task.description.trim() || '（无描述）'}`,
    '如仍存在其他未完成依赖，请先确认再继续执行。'
  ].join('\n')
}
