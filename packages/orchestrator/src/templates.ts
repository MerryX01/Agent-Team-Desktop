import type { SqliteStore } from '@storage/index'
import type { Task, Team, TeamMember, Template } from '@shared/index'
import { newId, nowIso } from '@shared/index'

function parsePayload(template: Template): Record<string, unknown> {
  const raw: unknown = template.payload
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch { /* 下方统一抛出明确错误 */ }
    throw new Error(`模板 payload 不是合法 JSON: ${template.id}`)
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  return {}
}

function decode<T>(value: unknown, label: string): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      throw new Error(`${label} 不是合法 JSON`)
    }
  }
  return value as T
}

function requireTemplate(store: SqliteStore, templateId: string, kind: Template['kind']): Template {
  const template = store.get<Template>('templates', 'id', templateId)
  if (!template) throw new Error(`模板不存在: ${templateId}`)
  if (template.kind !== kind) throw new Error(`模板类型不匹配: ${templateId} 不是 ${kind} 模板`)
  return template
}

/** 把团队及其成员保存为可复用模板。 */
export function saveTeamTemplate(store: SqliteStore, team: Team, members: TeamMember[]): Template {
  const template: Template = {
    id: newId('tpl'),
    kind: 'team',
    name: team.name,
    description: team.description || '',
    payload: { team, members },
    createdAt: nowIso()
  }
  store.insert('templates', template)
  return template
}

/** 把任务保存为可复用模板。 */
export function saveTaskTemplate(store: SqliteStore, task: Task, name: string): Template {
  const template: Template = {
    id: newId('tpl'),
    kind: 'task',
    name,
    description: task.description || '',
    payload: { task },
    createdAt: nowIso()
  }
  store.insert('templates', template)
  return template
}

/** 应用团队模板：生成全新的团队与成员记录，不复用模板中的 id。 */
export function applyTeamTemplate(store: SqliteStore, templateId: string): { team: Team; members: TeamMember[] } {
  const template = requireTemplate(store, templateId, 'team')
  const payload = parsePayload(template)
  const source = decode<Team>(payload.team, `团队模板 ${templateId} 的 team`)
  if (!source || typeof source !== 'object' || !source.name) {
    throw new Error(`团队模板缺少有效的 team 数据: ${templateId}`)
  }

  const rawMembers = decode<unknown>(payload.members ?? [], `团队模板 ${templateId} 的 members`)
  const sourceMembers: TeamMember[] = Array.isArray(rawMembers) ? rawMembers as TeamMember[] : []

  const team: Team = { ...source, id: newId('team') }
  store.insert('teams', team)

  const members = sourceMembers
    .filter((member): member is TeamMember => Boolean(member) && typeof member === 'object')
    .map((member) => ({ ...member, teamId: team.id }))
  for (const member of members) store.insert('team_members', member)

  return { team, members }
}

/** 应用任务模板：生成全新的任务 id/时间戳，并可传入字段覆盖。 */
export function applyTaskTemplate(store: SqliteStore, templateId: string, teamId: string, overrides: Partial<Task> = {}): Task {
  const template = requireTemplate(store, templateId, 'task')
  const payload = parsePayload(template)
  const source = decode<Task>(payload.task, `任务模板 ${templateId} 的 task`)
  if (!source || typeof source !== 'object' || !source.title) {
    throw new Error(`任务模板缺少有效的 task 数据: ${templateId}`)
  }

  const taskId = newId('task')
  const task: Task = {
    ...source,
    ...overrides,
    taskId,
    teamId,
    status: overrides.status ?? 'pending',
    dependsOn: overrides.dependsOn ?? source.dependsOn ?? [],
    inputContext: overrides.inputContext ?? source.inputContext ?? '',
    outputSummary: '',
    createdAt: nowIso(),
    startedAt: undefined,
    completedAt: undefined,
    errorMessage: undefined
  }
  store.insert('tasks', task)
  return task
}
