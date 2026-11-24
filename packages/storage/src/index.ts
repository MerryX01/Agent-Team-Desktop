import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentDefinition, AgentEvent, AgentMessage, ApiProvider, Approval, CustomAdapter, FileChange, MemoryEntry, ReviewCycle, Task, Team, TeamMember, Template, UsageRecord } from '@shared/index'
import { DEFAULT_AGENTS, defaultPermissionPolicy } from '@shared/index'

type Storable = Record<string, unknown>
type TableName = 'agents' | 'api_providers' | 'teams' | 'team_members' | 'tasks' | 'task_dependencies' |
  'agent_sessions' | 'run_events' | 'messages' | 'approvals' | 'workspaces' |
  'file_changes' | 'templates' | 'memory_entries' | 'usage_records' | 'custom_adapters' |
  'review_cycles'

const TABLES: TableName[] = [
  'agents', 'api_providers', 'teams', 'team_members', 'tasks', 'task_dependencies',
  'agent_sessions', 'run_events', 'messages', 'approvals', 'workspaces',
  'file_changes', 'templates', 'memory_entries', 'usage_records', 'custom_adapters',
  'review_cycles'
]

function assertTable(table: string): asserts table is TableName {
  if (!TABLES.includes(table as TableName)) throw new Error(`非法表名: ${table}`)
}

function toSql(value: unknown): string | number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' || typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  return JSON.stringify(value)
}

function fromRow<T>(row: Record<string, unknown> | undefined): T | undefined {
  if (!row) return undefined
  const result: Storable = {}
  for (const [key, value] of Object.entries(row)) {
    if (key === 'args' || key === 'dependsOn' || key === 'models' || key === 'statusArgs' ||
        key === 'headlessArgs' || key === 'payload' || key === 'raw') {
      try { result[key] = JSON.parse(String(value ?? '[]')) } catch { result[key] = [] }
    } else if (key === 'env') {
      try { result[key] = JSON.parse(String(value ?? '{}')) } catch { result[key] = {} }
    } else if (key === 'data' || key === 'metadata' || key === 'policy') {
      try { result[key] = JSON.parse(String(value ?? '{}')) } catch { result[key] = {} }
    } else if (key === 'enabled' || key === 'verified' || key === 'canWrite' || key === 'approvalRequired' ||
               key === 'headlessFallback' || key === 'usageSupported' || key === 'binary' || key === 'isLead' ||
               key === 'pinned' || key === 'installed') {
      result[key] = value === 1 || value === true
    } else {
      result[key] = value
    }
  }
  return result as T
}

export class SqliteStore {
  private readonly db: DatabaseSync

  constructor(file = ':memory:') {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, vendor TEXT NOT NULL,
        command TEXT, args TEXT NOT NULL, statusArgs TEXT, cwd TEXT, env TEXT NOT NULL, enabled INTEGER NOT NULL,
        authMode TEXT NOT NULL, role TEXT NOT NULL, version TEXT, commandPath TEXT,
        installed INTEGER NOT NULL, lastCheck TEXT, note TEXT, providerRef TEXT
      );
      CREATE TABLE IF NOT EXISTS api_providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL, baseUrl TEXT NOT NULL,
        model TEXT NOT NULL, credentialRef TEXT NOT NULL, contextLength INTEGER NOT NULL,
        maxOutput INTEGER NOT NULL, timeoutMs INTEGER NOT NULL, verified INTEGER NOT NULL, note TEXT
      );
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        defaultWorkspace TEXT NOT NULL, maxConcurrency INTEGER NOT NULL, permissionMode TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_members (
        teamId TEXT NOT NULL, agentId TEXT NOT NULL, role TEXT NOT NULL, workflow TEXT,
        isolation TEXT, pinned INTEGER, priority INTEGER NOT NULL, canWrite INTEGER NOT NULL,
        PRIMARY KEY (teamId, agentId)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        taskId TEXT PRIMARY KEY, teamId TEXT NOT NULL, parentTaskId TEXT, title TEXT NOT NULL,
        description TEXT NOT NULL, assigneeAgentId TEXT, status TEXT NOT NULL, priority INTEGER NOT NULL,
        dependsOn TEXT NOT NULL, inputContext TEXT NOT NULL, outputSummary TEXT NOT NULL,
        workspaceId TEXT, cwd TEXT, approvalRequired INTEGER NOT NULL, errorMessage TEXT,
        createdAt TEXT NOT NULL, startedAt TEXT, completedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS task_dependencies (
        taskId TEXT NOT NULL, dependsOn TEXT NOT NULL, PRIMARY KEY (taskId, dependsOn)
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY, agentId TEXT NOT NULL, sessionId TEXT, pid INTEGER,
        protocol TEXT NOT NULL, status TEXT NOT NULL, cwd TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id TEXT PRIMARY KEY, runId TEXT, taskId TEXT, agentId TEXT, type TEXT NOT NULL,
        message TEXT NOT NULL, data TEXT NOT NULL, timestamp TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, runId TEXT, taskId TEXT, teamId TEXT,
        sender TEXT NOT NULL, fromAgentId TEXT, toAgentId TEXT,
        content TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'coordination', timestamp TEXT NOT NULL,
        createdAt TEXT, readAt TEXT
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, runId TEXT, taskId TEXT, agentId TEXT, title TEXT NOT NULL,
        detail TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, resolvedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, path TEXT NOT NULL, gitInfo TEXT, isolation TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS file_changes (
        id TEXT PRIMARY KEY, runId TEXT, taskId TEXT, agentId TEXT, path TEXT NOT NULL,
        before TEXT NOT NULL, after TEXT NOT NULL, diff TEXT NOT NULL,
        binary INTEGER NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
        payload TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, scopeId TEXT NOT NULL, key TEXT NOT NULL,
        value TEXT NOT NULL, source TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_records (
        id TEXT PRIMARY KEY, agentId TEXT NOT NULL, runId TEXT, taskId TEXT,
        inputTokens INTEGER, outputTokens INTEGER, cost REAL, raw TEXT NOT NULL,
        source TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS custom_adapters (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, command TEXT NOT NULL, args TEXT NOT NULL,
        protocol TEXT NOT NULL, env TEXT NOT NULL, promptFlag TEXT NOT NULL,
        enabled INTEGER NOT NULL, note TEXT
      );
      CREATE TABLE IF NOT EXISTS review_cycles (
        id TEXT PRIMARY KEY, taskId TEXT NOT NULL, runId TEXT, reviewerAgentId TEXT,
        requesterAgentId TEXT, round INTEGER NOT NULL, status TEXT NOT NULL,
        summary TEXT NOT NULL, findings TEXT NOT NULL, createdAt TEXT NOT NULL, completedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reviews_task ON review_cycles(taskId);
      CREATE INDEX IF NOT EXISTS idx_changes_run ON file_changes(runId);
      CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(runId);
      CREATE INDEX IF NOT EXISTS idx_tasks_team ON tasks(teamId);
    `)

    this.ensureColumn('api_providers', 'models', "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn('agents', 'headlessCommand', 'TEXT')
    this.ensureColumn('agents', 'headlessArgs', "TEXT NOT NULL DEFAULT '[]'")
    this.ensureColumn('agents', 'headlessFallback', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('agents', 'remoteUrl', 'TEXT')
    this.ensureColumn('agents', 'remoteTokenRef', 'TEXT')
    this.ensureColumn('agents', 'customAdapterRef', 'TEXT')
    this.ensureColumn('agents', 'usageSupported', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('teams', 'isolation', "TEXT NOT NULL DEFAULT 'none'")
    this.ensureColumn('teams', 'policy', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('approvals', 'kind', "TEXT NOT NULL DEFAULT 'other'")
    this.ensureColumn('approvals', 'risk', "TEXT NOT NULL DEFAULT 'medium'")
    this.ensureColumn('approvals', 'path', 'TEXT')
    this.ensureColumn('approvals', 'command', 'TEXT')
    this.ensureColumn('approvals', 'reason', 'TEXT')
    this.ensureColumn('approvals', 'expiresAt', 'TEXT')
    this.ensureColumn('agents', 'workflow', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('agents', 'isLead', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('team_members', 'workflow', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('team_members', 'isolation', "TEXT NOT NULL DEFAULT 'none'")
    this.ensureColumn('team_members', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('teams', 'leadAgentId', 'TEXT')
    this.ensureColumn('teams', 'reviewFlow', "TEXT NOT NULL DEFAULT 'agent_approval'")
    this.ensureColumn('teams', 'reviewFlowPrompt', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('teams', 'defaultActionMode', "TEXT NOT NULL DEFAULT 'do'")
    this.ensureColumn('tasks', 'reviewerAgentId', 'TEXT')
    this.ensureColumn('tasks', 'actionMode', "TEXT NOT NULL DEFAULT 'do'")
    this.ensureColumn('tasks', 'boardColumn', "TEXT NOT NULL DEFAULT 'todo'")
    this.ensureColumn('tasks', 'reviewState', "TEXT NOT NULL DEFAULT 'none'")
    this.ensureColumn('messages', 'teamId', 'TEXT')
    this.ensureColumn('messages', 'toAgentId', 'TEXT')
    this.ensureColumn('messages', 'summary', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('messages', 'kind', "TEXT NOT NULL DEFAULT 'coordination'")
    this.ensureColumn('messages', 'readAt', 'TEXT')
    this.ensureColumn('messages', 'fromAgentId', 'TEXT')
    this.ensureColumn('messages', 'createdAt', 'TEXT')
    this.db.prepare('UPDATE messages SET createdAt = timestamp WHERE createdAt IS NULL').run()

    this.db.prepare("UPDATE teams SET policy = ? WHERE policy IS NULL OR policy = '{}'")
      .run(JSON.stringify(defaultPermissionPolicy()))

    if (this.count('teams') === 0) {
      this.insert('teams', {
        id: 'team-default', name: '默认团队', description: '可按需修改成员与权限',
        defaultWorkspace: '', maxConcurrency: 2, permissionMode: 'ask',
        isolation: 'none', policy: defaultPermissionPolicy(),
        leadAgentId: 'agent-trae', reviewFlow: 'agent_approval',
        reviewFlowPrompt: '', defaultActionMode: 'do'
      })
    }
    if (this.count('agents') === 0) {
      for (const agent of DEFAULT_AGENTS) this.insert('agents', agent)
    } else {
      const opencode = DEFAULT_AGENTS.find((agent) => agent.id === 'agent-opencode')
      if (opencode && !this.get('agents', 'id', opencode.id)) this.insert('agents', opencode)
    }
    const allAgents = this.all<AgentDefinition>('agents')
    let leadId = allAgents.find((agent) => agent.isLead)?.id
    if (!leadId) {
      const candidate = allAgents.find((agent) => agent.id === 'agent-trae' || agent.name === 'Trae CLI')
      if (candidate) {
        this.db.prepare("UPDATE agents SET isLead = 1, role = 'architect' WHERE id = ?").run(candidate.id)
        leadId = candidate.id
      }
    }
    this.db.prepare("UPDATE agents SET role = 'reviewer' WHERE id = 'agent-minimax' AND role = 'developer'").run()
    this.db.prepare("UPDATE agents SET role = 'qa' WHERE id = 'agent-qwen' AND role = 'developer'").run()
    this.db.prepare("UPDATE agents SET role = 'researcher' WHERE id = 'agent-workbuddy' AND role = 'general'").run()
    if (leadId) {
      this.db.prepare('UPDATE teams SET leadAgentId = ? WHERE leadAgentId IS NULL').run(leadId)
    }
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    assertTable(table)
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  count(table: string): number {
    assertTable(table)
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    return Number(row.n)
  }

  insert(table: string, value: Storable): void {
    assertTable(table)
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    const columns = entries.map(([k]) => k)
    const values = entries.map(([, v]) => toSql(v))
    this.db.prepare(
      `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    ).run(...values)
  }

  update(table: string, keyField: string, key: string, patch: Storable): void {
    assertTable(table)
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return
    const assignments = entries.map(([k]) => `${k} = ?`).join(', ')
    this.db.prepare(`UPDATE ${table} SET ${assignments} WHERE ${keyField} = ?`)
      .run(...entries.map(([, v]) => toSql(v)), key)
  }

  get<T>(table: string, keyField: string, key: string): T | undefined {
    assertTable(table)
    return fromRow<T>(this.db.prepare(`SELECT * FROM ${table} WHERE ${keyField} = ?`).get(key))
  }

  all<T>(table: string, where = '', params: Array<string | number | null> = []): T[] {
    assertTable(table)
    const suffix = where ? ` WHERE ${where}` : ''
    return this.db.prepare(`SELECT * FROM ${table}${suffix}`).all(...params)
      .map((row) => fromRow<T>(row) as T)
  }

  remove(table: string, keyField: string, key: string): void {
    assertTable(table)
    this.db.prepare(`DELETE FROM ${table} WHERE ${keyField} = ?`).run(key)
  }

  appendEvent(event: AgentEvent): void {
    this.insert('run_events', event)
  }

  events(limit = 300, runId?: string): AgentEvent[] {
    const rows = runId
      ? this.all<AgentEvent>('run_events', 'runId = ? ORDER BY timestamp DESC LIMIT ?', [runId, limit])
      : this.all<AgentEvent>('run_events', '1 = 1 ORDER BY timestamp DESC LIMIT ?', [limit])
    return rows.reverse()
  }

  clearEvents(): void {
    this.db.exec('DELETE FROM run_events')
  }

  agents(): AgentDefinition[] { return this.all<AgentDefinition>('agents') }
  providers(): ApiProvider[] { return this.all<ApiProvider>('api_providers') }
  teams(): Team[] { return this.all<Team>('teams') }
  tasks(teamId?: string): Task[] {
    return teamId ? this.all<Task>('tasks', 'teamId = ?', [teamId]) : this.all<Task>('tasks')
  }
  approvals(): Approval[] { return this.all<Approval>('approvals') }
  teamMembers(teamId: string): TeamMember[] { return this.all<TeamMember>('team_members', 'teamId = ?', [teamId]) }
  removeTeamMember(teamId: string, agentId: string): void {
    this.db.prepare('DELETE FROM team_members WHERE teamId = ? AND agentId = ?').run(teamId, agentId)
  }
  hasTeamMember(teamId: string, agentId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM team_members WHERE teamId = ? AND agentId = ?').get(teamId, agentId))
  }
  fileChanges(runId?: string, taskId?: string): FileChange[] {
    if (taskId) return this.all<FileChange>('file_changes', 'taskId = ? ORDER BY createdAt DESC', [taskId])
    if (runId) return this.all<FileChange>('file_changes', 'runId = ? ORDER BY createdAt DESC', [runId])
    return this.all<FileChange>('file_changes', '1 = 1 ORDER BY createdAt DESC LIMIT 300')
  }
  templates(kind?: Template['kind']): Template[] {
    return kind ? this.all<Template>('templates', 'kind = ?', [kind]) : this.all<Template>('templates')
  }
  memory(scope?: MemoryEntry['scope'], scopeId?: string): MemoryEntry[] {
    if (scope && scopeId) return this.all<MemoryEntry>('memory_entries', 'scope = ? AND scopeId = ? ORDER BY createdAt DESC', [scope, scopeId])
    return this.all<MemoryEntry>('memory_entries', '1 = 1 ORDER BY createdAt DESC LIMIT 200')
  }
  usage(agentId?: string): UsageRecord[] {
    return agentId
      ? this.all<UsageRecord>('usage_records', 'agentId = ? ORDER BY createdAt DESC LIMIT 200', [agentId])
      : this.all<UsageRecord>('usage_records', '1 = 1 ORDER BY createdAt DESC LIMIT 200')
  }
  customAdapters(): CustomAdapter[] { return this.all<CustomAdapter>('custom_adapters') }
  messages(teamId?: string, taskId?: string): AgentMessage[] {
    if (taskId) return this.all<AgentMessage>('messages', 'taskId = ? ORDER BY createdAt ASC', [taskId])
    if (teamId) return this.all<AgentMessage>('messages', 'teamId = ? ORDER BY createdAt ASC', [teamId])
    return this.all<AgentMessage>('messages', '1 = 1 ORDER BY createdAt DESC LIMIT 300')
  }
  reviews(taskId?: string): ReviewCycle[] {
    return taskId
      ? this.all<ReviewCycle>('review_cycles', 'taskId = ? ORDER BY createdAt ASC', [taskId])
      : this.all<ReviewCycle>('review_cycles', '1 = 1 ORDER BY createdAt DESC LIMIT 300')
  }

  close(): void { this.db.close() }
}
