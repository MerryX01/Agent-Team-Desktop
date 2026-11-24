import type { SqliteStore } from '@storage/index'
import type { AgentMessage, Task } from '@shared/index'
import { newId, nowIso } from '@shared/index'

/**
 * 消息输入：id/createdAt 由本模块生成，调用方也可显式指定（便于测试与回放）。
 */
export type MessageInput = Omit<AgentMessage, 'id' | 'createdAt' | 'sender' | 'summary' | 'kind'> &
  Partial<Pick<AgentMessage, 'id' | 'createdAt' | 'sender' | 'summary' | 'kind'>>

interface SchemaHandle {
  exec(sql: string): void
  prepare(sql: string): { all(): Array<{ name: string }> }
}

const schemaReady = new WeakSet<object>()

/**
 * 存储层的 messages 表当前只有 timestamp 列，缺少 AgentMessage 契约中的
 * createdAt / fromAgentId（store.messages() 甚至按 createdAt 排序）。
 * 这里在首次使用时补齐缺失列，避免修改存储层源码，同时保持对外 API 与类型一致。
 */
function ensureMessageSchema(store: SqliteStore): void {
  if (schemaReady.has(store)) return
  schemaReady.add(store)
  const db = (store as unknown as { db?: SchemaHandle }).db
  if (!db) return
  try {
    const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('messages')").all().map((row) => row.name))
    if (!columns.has('fromAgentId')) db.exec('ALTER TABLE messages ADD COLUMN fromAgentId TEXT')
    if (!columns.has('createdAt')) db.exec('ALTER TABLE messages ADD COLUMN createdAt TEXT')
  } catch {
    // 非 SqliteStore 实现无法探测 schema；此时仍按 AgentMessage 原样写入。
  }
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 写入一条 Agent 消息。事件不在此处发出（由调用方负责 emit）。
 */
export function sendMessage(store: SqliteStore, input: MessageInput): AgentMessage {
  if (typeof input.content !== 'string' || input.content.trim() === '') {
    throw new Error('消息内容不能为空')
  }
  ensureMessageSchema(store)

  const message: AgentMessage = {
    id: input.id ?? newId('msg'),
    teamId: input.teamId,
    runId: input.runId,
    taskId: input.taskId,
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    sender: input.sender ?? input.fromAgentId ?? 'system',
    content: input.content,
    summary: input.summary ?? '',
    kind: input.kind ?? 'coordination',
    createdAt: input.createdAt ?? nowIso(),
    readAt: input.readAt
  }
  // timestamp 是 messages 表的 NOT NULL 列，与 createdAt 同步写入以兼容旧表结构。
  store.insert('messages', { ...message, timestamp: message.createdAt })
  return message
}

/**
 * 构造发给指定 agent 的最近消息摘要，供其 prompt 使用。无消息时返回空串。
 */
export function buildMessageContext(store: SqliteStore, teamId: string, agentId: string, limit = 8): string {
  ensureMessageSchema(store)
  if (!limit || limit < 1) return ''

  const rows = store.all<AgentMessage>(
    'messages',
    'teamId = ? AND toAgentId = ? ORDER BY createdAt DESC LIMIT ?',
    [teamId, agentId, limit]
  )
  if (rows.length === 0) return ''

  const lines = rows.map((row) => {
    const from = row.fromAgentId ?? row.sender ?? 'system'
    const to = row.toAgentId ?? '-'
    const summary = truncate(row.summary ?? '', 60) || '-'
    const content = truncate(row.content ?? '', 160) || '-'
    return `- [${row.kind ?? 'coordination'}] ${from} -> ${to} | 摘要: ${summary} | 内容: ${content}`
  })
  return `近期消息（最近 ${lines.length} 条）:\n${lines.join('\n')}`
}

/** 请求审查时通知 reviewer。 */
export function notifyReviewRequest(
  store: SqliteStore,
  task: Task,
  reviewerAgentId: string | undefined,
  requesterAgentId: string | undefined,
  summary: string
): AgentMessage {
  const note = summary.trim()
  return sendMessage(store, {
    teamId: task.teamId,
    taskId: task.taskId,
    fromAgentId: requesterAgentId,
    toAgentId: reviewerAgentId,
    summary: note || `请求审查: ${task.title}`,
    content: `任务「${task.title}」请求审查。${note ? `\n${note}` : ''}`.trim(),
    kind: 'review_request'
  })
}

/** 依赖任务完成时通知下游任务的执行者。 */
export function notifyDependencyResolved(store: SqliteStore, task: Task, resolvedTask: Task): AgentMessage {
  const upstream = resolvedTask.outputSummary?.trim() ?? ''
  return sendMessage(store, {
    teamId: task.teamId,
    taskId: task.taskId,
    fromAgentId: resolvedTask.assigneeAgentId,
    toAgentId: task.assigneeAgentId,
    summary: `依赖已完成: ${resolvedTask.title}`,
    content: `依赖任务「${resolvedTask.title}」已完成，任务「${task.title}」可以开始。${upstream ? `\n上游摘要: ${upstream}` : ''}`.trim(),
    kind: 'dependency_notice'
  })
}
