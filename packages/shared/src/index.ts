import { z } from 'zod'

export const ROLE_CATALOG = [
  { value: 'architect', label: 'architect', icon: '🧩', description: '方案设计、边界与关键取舍', duty: '负责架构设计与技术决策，输出方案、边界与关键取舍。' },
  { value: 'reviewer', label: 'reviewer', icon: '📖', description: '审查结果与质量把关', duty: '负责审查结果与质量把关，指出问题与改进建议，不直接改动实现。' },
  { value: 'developer', label: 'developer', icon: '💻', description: '实现功能与修复问题', duty: '负责实现功能与修复问题，在工作区内改动并遵守权限策略。' },
  { value: 'qa', label: 'qa', icon: '🐞', description: '验证、测试与复现步骤', duty: '负责验证与测试，给出可复现步骤、预期结果与结论。' },
  { value: 'researcher', label: 'researcher', icon: '🔬', description: '调研与资料整理', duty: '负责调研与资料整理，输出结论及其依据。' },
  { value: 'docs', label: 'docs', icon: '📄', description: '文档撰写与整理', duty: '负责文档撰写与整理，保持表述清晰准确。' },
  { value: 'auditor', label: 'auditor', icon: '🛡️', description: '合规与风险审查', duty: '负责合规与风险审查，列出发现、依据与整改建议。' },
  { value: 'optimizer', label: 'optimizer', icon: '⚡', description: '性能与流程优化', duty: '负责性能与流程优化，给出可衡量的改进建议。' }
] as const

export const ROLE_PRESETS = [
  'architect', 'reviewer', 'developer', 'qa', 'researcher', 'docs', 'auditor', 'optimizer'
] as const
export type RolePreset = typeof ROLE_PRESETS[number]

export const RESERVED_LEAD_ROLES = ['lead', 'team-lead', 'coordinator', 'orchestrator'] as const

export const ActionModeSchema = z.enum(['do', 'ask', 'delegate'])
export type ActionMode = z.infer<typeof ActionModeSchema>

export const ReviewFlowSchema = z.enum(['agent_approval', 'human_approval', 'lead_then_human'])
export type ReviewFlow = z.infer<typeof ReviewFlowSchema>

export const ReviewStateSchema = z.enum(['none', 'review', 'changes_requested', 'lead_signoff', 'approved'])
export type ReviewState = z.infer<typeof ReviewStateSchema>

export const BoardColumnSchema = z.enum(['todo', 'in_progress', 'review', 'approved', 'done', 'blocked'])
export type BoardColumn = z.infer<typeof BoardColumnSchema>

export const AgentKindSchema = z.enum(['native-acp', 'native-process', 'api-provider', 'remote-acp'])
export type AgentKind = z.infer<typeof AgentKindSchema>

export const AuthModeSchema = z.enum(['native-login', 'api-key', 'remote-token', 'unknown'])
export type AuthMode = z.infer<typeof AuthModeSchema>

export const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: AgentKindSchema,
  vendor: z.string().min(1),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  statusArgs: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  enabled: z.boolean().default(true),
  authMode: AuthModeSchema,
  role: z.string().default('developer'),
  workflow: z.string().optional(),
  isLead: z.boolean().optional(),
  version: z.string().optional(),
  commandPath: z.string().optional(),
  installed: z.boolean().default(false),
  lastCheck: z.string().optional(),
  note: z.string().optional(),
  providerRef: z.string().optional(),
  headlessCommand: z.string().optional(),
  headlessArgs: z.array(z.string()).default([]),
  headlessFallback: z.boolean().default(false),
  remoteUrl: z.string().optional(),
  remoteTokenRef: z.string().optional(),
  customAdapterRef: z.string().optional(),
  usageSupported: z.boolean().default(false)
})
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>

export const AgentEventTypeSchema = z.enum([
  'agent.started', 'agent.message.delta', 'agent.tool.started', 'agent.tool.finished',
  'agent.permission.required', 'agent.completed', 'agent.failed', 'agent.cancelled',
  'task.started', 'task.completed', 'task.failed', 'run.started', 'run.completed',
  'file.changed', 'policy.denied', 'memory.saved', 'usage.updated',
  'review.requested', 'review.started', 'review.approved', 'review.changes_requested',
  'review.lead_signoff', 'review.human_approved', 'message.sent', 'plan.generated', 'system'
])
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>

export const AgentEventSchema = z.object({
  id: z.string(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  agentId: z.string().optional(),
  type: AgentEventTypeSchema,
  message: z.string(),
  data: z.record(z.string(), z.unknown()).default({}),
  timestamp: z.string()
})
export type AgentEvent = z.infer<typeof AgentEventSchema>

export const TaskStatusSchema = z.enum([
  'pending', 'ready', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const TaskSchema = z.object({
  taskId: z.string(),
  teamId: z.string(),
  parentTaskId: z.string().optional(),
  title: z.string(),
  description: z.string(),
  assigneeAgentId: z.string().optional(),
  reviewerAgentId: z.string().optional(),
  actionMode: ActionModeSchema.optional(),
  boardColumn: BoardColumnSchema.optional(),
  reviewState: ReviewStateSchema.optional(),
  status: TaskStatusSchema.default('pending'),
  priority: z.number().int().default(0),
  dependsOn: z.array(z.string()).default([]),
  inputContext: z.string().default(''),
  outputSummary: z.string().default(''),
  workspaceId: z.string().optional(),
  cwd: z.string().optional(),
  approvalRequired: z.boolean().default(false),
  errorMessage: z.string().optional(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional()
})
export type Task = z.infer<typeof TaskSchema>

export const ApiProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.enum(['openai-compatible', 'anthropic-messages']),
  baseUrl: z.string(),
  model: z.string(),
  credentialRef: z.string(),
  contextLength: z.number().int().positive().default(8192),
  maxOutput: z.number().int().positive().default(2048),
  timeoutMs: z.number().int().positive().default(60000),
  verified: z.boolean().default(false),
  models: z.array(z.string()).default([]),
  note: z.string().optional()
})
export type ApiProvider = z.infer<typeof ApiProviderSchema>

export function defaultPermissionPolicy(): PermissionPolicy {
  return {
    fileWrite: 'ask', shellCommand: 'ask', network: 'ask', installPackage: 'deny',
    denyPatterns: ['rm -rf', 'del /s', 'format ', 'shutdown', 'mkfs', ':(){'],
    allowPatterns: [], approvalTimeoutMs: 300000, restrictToWorkspace: true
  }
}

export const PermissionPolicySchema = z.object({
  fileWrite: z.enum(['ask', 'allow', 'deny']).default('ask'),
  shellCommand: z.enum(['ask', 'allow', 'deny']).default('ask'),
  network: z.enum(['ask', 'allow', 'deny']).default('ask'),
  installPackage: z.enum(['ask', 'allow', 'deny']).default('deny'),
  denyPatterns: z.array(z.string()).default(['rm -rf', 'del /s', 'format ', 'shutdown', 'mkfs', ':(){']),
  allowPatterns: z.array(z.string()).default([]),
  approvalTimeoutMs: z.number().int().positive().default(300000),
  restrictToWorkspace: z.boolean().default(true)
})
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>

export const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(''),
  defaultWorkspace: z.string().default(''),
  maxConcurrency: z.number().int().min(1).max(10).default(2),
  permissionMode: z.enum(['ask', 'auto-deny', 'plan']).default('ask'),
  leadAgentId: z.string().optional(),
  reviewFlow: ReviewFlowSchema.optional(),
  reviewFlowPrompt: z.string().optional(),
  defaultActionMode: ActionModeSchema.optional(),
  isolation: z.enum(['none', 'worktree']).default('none'),
  policy: PermissionPolicySchema.default(defaultPermissionPolicy())
})
export type Team = z.infer<typeof TeamSchema>

export const TeamMemberSchema = z.object({
  teamId: z.string(),
  agentId: z.string(),
  role: z.string().default('developer'),
  workflow: z.string().optional(),
  isolation: z.enum(['none', 'worktree']).optional(),
  pinned: z.boolean().optional(),
  priority: z.number().int().default(0),
  canWrite: z.boolean().default(false)
})
export type TeamMember = z.infer<typeof TeamMemberSchema>

export const ApprovalSchema = z.object({
  id: z.string(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  agentId: z.string().optional(),
  title: z.string(),
  detail: z.string().default(''),
  kind: z.enum(['file-write', 'shell', 'network', 'install', 'other']).default('other'),
  risk: z.enum(['low', 'medium', 'high']).default('medium'),
  path: z.string().optional(),
  command: z.string().optional(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']).default('pending'),
  reason: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  resolvedAt: z.string().optional()
})
export type Approval = z.infer<typeof ApprovalSchema>

export const ReviewCycleSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string().optional(),
  reviewerAgentId: z.string().optional(),
  requesterAgentId: z.string().optional(),
  round: z.number().int().min(1).default(1),
  status: z.enum(['requested', 'in_review', 'approved', 'changes_requested', 'lead_signoff', 'human_approved']).default('requested'),
  summary: z.string().default(''),
  findings: z.string().default(''),
  createdAt: z.string(),
  completedAt: z.string().optional()
})
export type ReviewCycle = z.infer<typeof ReviewCycleSchema>

export const AgentMessageSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  fromAgentId: z.string().optional(),
  toAgentId: z.string().optional(),
  sender: z.string().default('system'),
  content: z.string(),
  summary: z.string().default(''),
  kind: z.enum(['task_assignment', 'review_request', 'coordination', 'report', 'dependency_notice', 'user']).default('coordination'),
  createdAt: z.string(),
  readAt: z.string().optional()
})
export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const FileChangeSchema = z.object({
  id: z.string(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  agentId: z.string().optional(),
  path: z.string(),
  before: z.string().default(''),
  after: z.string().default(''),
  diff: z.string().default(''),
  binary: z.boolean().default(false),
  createdAt: z.string()
})
export type FileChange = z.infer<typeof FileChangeSchema>

export const TemplateSchema = z.object({
  id: z.string(),
  kind: z.enum(['team', 'task']),
  name: z.string(),
  description: z.string().default(''),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string()
})
export type Template = z.infer<typeof TemplateSchema>

export const MemoryEntrySchema = z.object({
  id: z.string(),
  scope: z.enum(['agent', 'team', 'project']),
  scopeId: z.string(),
  key: z.string(),
  value: z.string(),
  source: z.string().default(''),
  createdAt: z.string()
})
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>

export const UsageRecordSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  runId: z.string().optional(),
  taskId: z.string().optional(),
  inputTokens: z.number().int().optional(),
  outputTokens: z.number().int().optional(),
  cost: z.number().optional(),
  raw: z.record(z.string(), z.unknown()).default({}),
  source: z.string().default('agent-reported'),
  createdAt: z.string()
})
export type UsageRecord = z.infer<typeof UsageRecordSchema>

export const CustomAdapterSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  protocol: z.enum(['jsonl', 'plain', 'acp']).default('jsonl'),
  env: z.record(z.string(), z.string()).default({}),
  promptFlag: z.string().default(''),
  enabled: z.boolean().default(true),
  note: z.string().optional()
})
export type CustomAdapter = z.infer<typeof CustomAdapterSchema>

export const DEFAULT_AGENTS: AgentDefinition[] = [
  {
    id: 'agent-trae', name: 'Trae CLI', kind: 'native-acp', vendor: 'Trae',
    command: 'traecli', args: ['acp serve'], statusArgs: ['login', 'status'], env: {}, headlessArgs: [], headlessFallback: false, usageSupported: false, workflow: '', enabled: true, authMode: 'native-login', role: 'architect', isLead: true,
    installed: false, note: '通过官方 CLI 登录态启动 ACP；额度由官方账号决定'
  },
  {
    id: 'agent-qoder', name: 'Qoder CLI', kind: 'native-acp', vendor: 'Qoder',
    command: 'qoder', args: ['--acp'], statusArgs: undefined, env: {}, headlessArgs: [], headlessFallback: false, usageSupported: false, workflow: '', isLead: false, enabled: true, authMode: 'native-login', role: 'developer',
    installed: false, note: '官方文档为 qoder --acp（规格中的 qodercli 需实机确认）；ACP 复用 Qoder CLI 登录态'
  },
  {
    id: 'agent-minimax', name: 'MiniMax Code', kind: 'native-acp', vendor: 'MiniMax',
    command: 'mcode', args: ['acp'], env: {}, headlessCommand: 'mcode', headlessArgs: ['exec'], headlessFallback: true, usageSupported: false, workflow: '', isLead: false, enabled: true, authMode: 'native-login', role: 'reviewer',
    installed: false, note: 'mcode login 管理登录；Token Plan 需账号有可用额度'
  },
  {
    id: 'agent-qwen', name: 'Qwen Code', kind: 'native-acp', vendor: 'Alibaba Cloud',
    command: 'qwen', args: ['--acp'], statusArgs: undefined, env: {}, headlessCommand: 'qwen', headlessArgs: ['-p'], headlessFallback: true, usageSupported: false, workflow: '', isLead: false, enabled: true, authMode: 'native-login', role: 'qa',
    installed: false, note: '规格写 --acp；主分支文档写 qwen serve (ACP daemon)，需按本机版本调整。订阅账号需 Plus/Pro'
  },
  {
    id: 'agent-workbuddy', name: 'WorkBuddy', kind: 'remote-acp', vendor: 'Tencent',
    command: '', args: [], env: {}, headlessArgs: [], headlessFallback: false, usageSupported: false, workflow: '', isLead: false, enabled: false, authMode: 'unknown', role: 'researcher',
    installed: false, note: '待验证：桌面版本地 ACP 未确认；企业远程 ACP 不等于本机额度'
  },
  {
    id: 'agent-opencode', name: 'OpenCode', kind: 'native-acp', vendor: 'OpenCode',
    command: 'opencode', args: ['acp'], env: {}, headlessArgs: [], headlessFallback: false,
    usageSupported: false, workflow: '', isLead: false, enabled: true,
    authMode: 'native-login', role: 'developer', installed: false,
    note: '官方 ACP 命令为 opencode acp；复用 OpenCode 已配置的 Provider 凭据，需 opencode auth login'
  },
  {
    id: 'agent-claude', name: 'Claude Code', kind: 'native-process', vendor: 'Anthropic',
    command: 'claude', args: [], env: {}, headlessCommand: 'claude', headlessArgs: ['-p'],
    headlessFallback: true, usageSupported: false, workflow: '', isLead: false,
    enabled: true, authMode: 'native-login', role: 'developer', installed: false,
    note: '使用官方 headless 命令 claude -p，复用 Claude Code 本机登录态；不声明 ACP'
  },
  {
    id: 'agent-codex', name: 'Codex CLI', kind: 'native-process', vendor: 'OpenAI',
    command: 'codex', args: [], env: {}, headlessCommand: 'codex', headlessArgs: ['exec'],
    headlessFallback: true, usageSupported: false, workflow: '', isLead: false,
    enabled: true, authMode: 'native-login', role: 'developer', installed: false,
    note: '使用官方 headless 命令 codex exec，复用 Codex 本机登录态；不声明 ACP'
  }
]

export function newId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}
