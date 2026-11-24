import type { SqliteStore } from '@storage/index'
import type { MemoryEntry } from '@shared/index'
import { newId, nowIso } from '@shared/index'

export type MemoryInput = Omit<MemoryEntry, 'id' | 'createdAt'> & Partial<Pick<MemoryEntry, 'id' | 'createdAt'>>

/** 只保存调用方明确提供的摘要内容，不生成或推断任何事实。 */
export function saveMemory(store: SqliteStore, entry: MemoryInput): MemoryEntry {
  if (!entry.value || !entry.value.trim()) throw new Error('记忆内容不能为空')
  const saved: MemoryEntry = {
    ...entry,
    id: entry.id || newId('mem'),
    createdAt: entry.createdAt || nowIso()
  }
  store.insert('memory_entries', saved)
  return saved
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** 构造可注入 prompt 的简短记忆上下文；无匹配内容时返回空字符串。 */
export function buildMemoryContext(
  store: SqliteStore,
  scope: MemoryEntry['scope'],
  scopeId: string,
  limit = 5,
  query?: string
): string {
  const needle = query?.trim().toLowerCase() ?? ''
  const matched = store.memory(scope, scopeId).filter((entry) =>
    !needle || `${entry.key} ${entry.value}`.toLowerCase().includes(needle)
  )
  const selected = matched.slice(0, Math.max(0, limit))
  if (selected.length === 0) return ''

  const lines = selected.map((entry) => `- ${entry.key}: ${truncate(entry.value, 500)}`)
  return `[记忆 | ${scope}:${scopeId}]\n${lines.join('\n')}`
}

/** 按 scope 保留最新若干条记忆，返回被裁剪掉的数量。 */
export function pruneMemory(store: SqliteStore, maxPerScope = 100): number {
  const groups = new Map<string, MemoryEntry[]>()
  for (const entry of store.all<MemoryEntry>('memory_entries')) {
    const key = `${entry.scope}\u0000${entry.scopeId}`
    const list = groups.get(key) ?? []
    list.push(entry)
    groups.set(key, list)
  }

  const keep = Math.max(0, maxPerScope)
  let removed = 0
  for (const list of groups.values()) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    for (const entry of list.slice(keep)) {
      store.remove('memory_entries', 'id', entry.id)
      removed += 1
    }
  }
  return removed
}
