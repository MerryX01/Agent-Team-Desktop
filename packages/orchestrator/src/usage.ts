import type { SqliteStore } from '@storage/index'
import type { UsageRecord } from '@shared/index'
import { newId, nowIso } from '@shared/index'

export const OFFICIAL_QUOTA_NOTICE = '额度由官方客户端管理，未获取到官方返回的用量数据，不在此处猜测额度。'

export type UsageInput = Omit<UsageRecord, 'id' | 'createdAt'> & Partial<Pick<UsageRecord, 'id' | 'createdAt'>>

function hasNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 仅记录 Agent 明确上报且带有 token/费用数据的用量；
 * 其他来源或无数据时返回说明文案，绝不猜测额度。
 */
export function recordUsage(store: SqliteStore, record: UsageInput): UsageRecord | string {
  const hasMetric = hasNumber(record.inputTokens) || hasNumber(record.outputTokens) || hasNumber(record.cost)
  if (record.source !== 'agent-reported' || !hasMetric) return OFFICIAL_QUOTA_NOTICE

  const saved: UsageRecord = {
    ...record,
    id: record.id || newId('usage'),
    createdAt: record.createdAt || nowIso(),
    source: 'agent-reported'
  }
  store.insert('usage_records', saved)
  return saved
}

/** 展示官方返回并已上报的用量数据；无数据时返回统一说明。 */
export function formatUsage(store: SqliteStore, agentId: string): string {
  const records = store.usage(agentId)
  if (records.length === 0) return OFFICIAL_QUOTA_NOTICE

  let inputTokens = 0
  let outputTokens = 0
  let cost = 0
  for (const record of records) {
    if (hasNumber(record.inputTokens)) inputTokens += record.inputTokens
    if (hasNumber(record.outputTokens)) outputTokens += record.outputTokens
    if (hasNumber(record.cost)) cost += record.cost
  }

  const lines = [`用量数据（${agentId}，来自官方响应上报，共 ${records.length} 条）`]
  if (records.some((record) => hasNumber(record.inputTokens))) lines.push(`- 输入 token: ${inputTokens}`)
  if (records.some((record) => hasNumber(record.outputTokens))) lines.push(`- 输出 token: ${outputTokens}`)
  if (records.some((record) => hasNumber(record.cost))) lines.push(`- 费用: ${cost}`)
  return lines.join('\n')
}
