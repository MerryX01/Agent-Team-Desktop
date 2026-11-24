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
  desktopPath: z.string().optional(),
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
  usageSupported: z.boolean().default(false),
  /** 引用的模型目录条目 ID（MODEL_CATALOG[].id）。仅作配置记录，不冒充 CLI 运行时能力。 */
  modelRef: z.string().optional()
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

/**
 * 模型映射目录（数据来源：各工具官方文档，采集于 2026-11-24）
 *
 * 重要口径说明：
 * - 这里的「倍率」是各工具官方的「用量消耗倍率」，不是第三方中转站的加价倍率。
 * - OpenCode Console：按官方刊例价（USD / 1M token）计费，免费模型标 free=true；无「倍率」概念，倍率记为 1（刊例价）或 0（免费）。
 * - Trae：按官方刊例价（USD / 1M token）+ 套餐 Dollar Usage 额度计费；无「倍率」概念。
 * - Qoder：官方文档明确「各模型消耗 Credits 的速度不同，以模型选择器中的显示为准」，并给出 Qwen3.8-Flash 限时 0.1x → 0.0x；其余模型官方未公开精确倍率，保持 null 并在 note 注明，严禁臆造。
 * - Claude Code / Codex CLI：使用本机订阅登录态，模型消耗官方订阅/API 计费，工具本身不公开倍率。
 * 因此本目录用 priceInput/priceOutput 承载官方刊例价，用 creditRate 承载官方明确给出的倍率，
 * 用 free 标识官方限时/长期免费；未公开的一律留空，不猜测。
 */
export const ModelToolSchema = z.enum(['opencode', 'trae', 'qoder', 'claude-code', 'codex'])
export type ModelTool = z.infer<typeof ModelToolSchema>

export const MODEL_TOOL_LABEL: Record<ModelTool, string> = {
  opencode: 'OpenCode',
  trae: 'Trae',
  qoder: 'Qoder',
  'claude-code': 'Claude Code',
  codex: 'Codex CLI'
}

/** 哪些内置 Agent ID 允许使用某工具的模型（用于 UI 过滤，不做运行时保证）。 */
export const MODEL_TOOL_AGENTS: Record<ModelTool, string[]> = {
  opencode: ['agent-opencode'],
  trae: ['agent-trae'],
  qoder: ['agent-qoder'],
  'claude-code': ['agent-claude'],
  codex: ['agent-codex']
}

export const ModelEntrySchema = z.object({
  /** 目录内唯一 ID，如 opencode/qwen3.8-flash */
  id: z.string(),
  tool: ModelToolSchema,
  /** 官方模型 ID（用于配置/展示，格式随工具而异） */
  modelId: z.string(),
  /** 展示名称 */
  label: z.string(),
  /** 模型家族/厂商，便于筛选 */
  family: z.string().default(''),
  /** 官方声明免费（限时免费也属于此列，note 会标注） */
  free: z.boolean().default(false),
  /** 官方刊例价：输入 USD / 1M token */
  priceInput: z.number().min(0).optional(),
  /** 官方刊例价：输出 USD / 1M token */
  priceOutput: z.number().min(0).optional(),
  /** 官方明确公布的 Credits 消耗倍率；未公开则为 undefined */
  creditRate: z.number().min(0).optional(),
  /** 倍率口径说明/风险提示 */
  note: z.string().default(''),
  /** 官方文档来源 URL */
  source: z.string().default('')
})
export type ModelEntry = z.infer<typeof ModelEntrySchema>

const SOURCE = {
  opencode: 'https://opencode.ai/docs/console/models',
  trae: 'https://docs.trae.ai/ide/models',
  traeBilling: 'https://docs.trae.ai/ide/new-plans-and-billing',
  qoder: 'https://qoder.com/zh/blog/qoder-lite',
  qoderActivity: 'https://qoder.com/activities',
  qoderPricing: 'https://qoder.com/pricing'
} as const

/** 官方限时/长期免费模型，以及常用的官方刊例价模型。仅收录官方文档明确列出的条目。 */
export const MODEL_CATALOG: ModelEntry[] = [
  // ---------------- OpenCode Console ----------------
  { id: 'opencode/deepseek-v4.1-flash-free', tool: 'opencode', modelId: 'opencode/deepseek-v4.1-flash-free', label: 'DeepSeek V4.1 Flash Free', family: 'DeepSeek', free: true, note: '官方限时免费；零留存，不用于训练', source: SOURCE.opencode },
  { id: 'opencode/mimo-v2.6-flash-free', tool: 'opencode', modelId: 'opencode/mimo-v2.6-flash-free', label: 'MiMo-V2.6-Flash Free', family: 'Xiaomi', free: true, note: '官方限时免费', source: SOURCE.opencode },
  { id: 'opencode/nemotron-3.5-lightning-free', tool: 'opencode', modelId: 'opencode/nemotron-3.5-lightning-free', label: 'Nemotron 3.5 Lightning Free', family: 'NVIDIA', free: true, note: '官方限时免费；NVIDIA 免费端点仅供试用，勿提交敏感数据', source: SOURCE.opencode },
  { id: 'opencode/nemotron-3.5-super-vl-free', tool: 'opencode', modelId: 'opencode/nemotron-3.5-super-vl-free', label: 'Nemotron 3.5 Super VL Free', family: 'NVIDIA', free: true, note: '官方限时免费；NVIDIA 免费端点仅供试用', source: SOURCE.opencode },
  { id: 'opencode/big-pickle', tool: 'opencode', modelId: 'opencode/big-pickle', label: 'Big Pickle', family: 'Stealth', free: true, note: '官方限时免费；免费期数据可能用于改进模型', source: SOURCE.opencode },
  { id: 'opencode/iceman-free', tool: 'opencode', modelId: 'opencode/iceman-free', label: 'Iceman Free', family: 'Stealth', free: true, note: '官方限时免费；免费期数据可能被留存并用于训练', source: SOURCE.opencode },
  { id: 'opencode/beam-free', tool: 'opencode', modelId: 'opencode/beam-free', label: 'Beam Free', family: 'Stealth', free: true, note: '官方限时免费；部分国家/地区不可用（含中国大陆、港澳）', source: SOURCE.opencode },
  { id: 'opencode/flint-40b-free', tool: 'opencode', modelId: 'opencode/flint-40b-free', label: 'Flint 40B Free', family: 'Stealth', free: true, note: '官方限时免费；数据留存 30 天', source: SOURCE.opencode },
  { id: 'opencode/hy4-flash-free', tool: 'opencode', modelId: 'opencode/hy4-flash-free', label: 'Hy4 flash Free', family: 'Stealth', free: true, note: '官方限时免费；零留存', source: SOURCE.opencode },
  { id: 'opencode/jev-1.13-free', tool: 'opencode', modelId: 'opencode/jev-1.13-free', label: 'Jev 1.13 Free', family: 'TypeSafe AI', free: true, note: '官方限时免费；System One 决策模型', source: SOURCE.opencode },
  { id: 'opencode/qwen3.8-flash', tool: 'opencode', modelId: 'opencode/qwen3.8-flash', label: 'Qwen3.8 Flash', family: 'Alibaba', free: false, priceInput: 0.15, priceOutput: 0.47, note: '按官方刊例价 USD/1M；非免费', source: SOURCE.opencode },
  { id: 'opencode/glm-5.3-flash', tool: 'opencode', modelId: 'opencode/glm-5.3-flash', label: 'GLM 5.3 Flash', family: 'Zhipu', free: false, priceInput: 0.15, priceOutput: 0.5, note: '按官方刊例价 USD/1M；非免费', source: SOURCE.opencode },
  { id: 'opencode/minimax-m3', tool: 'opencode', modelId: 'opencode/minimax-m3', label: 'MiniMax M3', family: 'MiniMax', free: false, priceInput: 0.3, priceOutput: 1.2, note: '按官方刊例价 USD/1M', source: SOURCE.opencode },
  { id: 'opencode/claude-sonnet-5-5', tool: 'opencode', modelId: 'opencode/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', family: 'Anthropic', free: false, priceInput: 2, priceOutput: 10, note: '按官方刊例价 USD/1M', source: SOURCE.opencode },
  { id: 'opencode/claude-opus-5-5', tool: 'opencode', modelId: 'opencode/claude-opus-5-5', label: 'Claude Opus 5.5', family: 'Anthropic', free: false, priceInput: 4, priceOutput: 20, note: '按官方刊例价 USD/1M', source: SOURCE.opencode },
  { id: 'opencode/gpt-6-luna', tool: 'opencode', modelId: 'opencode/gpt-6-luna', label: 'GPT 6 Luna', family: 'OpenAI', free: false, priceInput: 0.1, priceOutput: 0.5, note: '按官方刊例价 USD/1M（≤272K）', source: SOURCE.opencode },
  { id: 'opencode/gpt-6.2-sol', tool: 'opencode', modelId: 'opencode/gpt-6.2-sol', label: 'GPT 6.2 Sol', family: 'OpenAI', free: false, priceInput: 2, priceOutput: 10, note: '按官方刊例价 USD/1M（≤272K）', source: SOURCE.opencode },

  // ---------------- Trae（内置模型，非美国地区刊例价） ----------------
  { id: 'trae/seed-2.1-turbo', tool: 'trae', modelId: 'Seed-2.1-Turbo', label: 'Seed-2.1-Turbo', family: 'ByteDance', free: false, priceInput: 0.5, priceOutput: 2.5, note: '非美国地区刊例价 USD/1M；套餐按 Token 用量计费', source: SOURCE.trae },
  { id: 'trae/gpt-6-luna', tool: 'trae', modelId: 'GPT-6-Luna', label: 'GPT-6-Luna', family: 'OpenAI', free: false, priceInput: 0.1, priceOutput: 0.5, note: '≤272K 刊例价 USD/1M', source: SOURCE.trae },
  { id: 'trae/gpt-6.2-sol', tool: 'trae', modelId: 'GPT-6.2-Sol', label: 'GPT-6.2-Sol', family: 'OpenAI', free: false, priceInput: 2, priceOutput: 10, note: '≤272K 刊例价 USD/1M', source: SOURCE.trae },
  { id: 'trae/gpt-5.2', tool: 'trae', modelId: 'gpt-5.2', label: 'GPT-5.2', family: 'OpenAI', free: false, priceInput: 1.75, priceOutput: 14, note: '刊例价 USD/1M；也是官方 Subagent 可用模型 ID', source: SOURCE.trae },
  { id: 'trae/gpt-5.4', tool: 'trae', modelId: 'gpt-5.4', label: 'GPT-5.4', family: 'OpenAI', free: false, priceInput: 2.5, priceOutput: 15, note: '≤272K 刊例价 USD/1M；Subagent 可用模型 ID', source: SOURCE.trae },
  { id: 'trae/gemini-3.1-pro', tool: 'trae', modelId: 'gemini-3.1-pro', label: 'Gemini-3.1-Pro-Preview', family: 'Google', free: false, priceInput: 2, priceOutput: 12, note: '≤200K 刊例价 USD/1M；Subagent 可用模型 ID', source: SOURCE.trae },
  { id: 'trae/gemini-3-flash-solo', tool: 'trae', modelId: 'gemini-3-flash-solo', label: 'Gemini-3-Flash-Preview', family: 'Google', free: false, priceInput: 0.5, priceOutput: 3, note: '刊例价 USD/1M；Subagent 可用模型 ID', source: SOURCE.trae },
  { id: 'trae/deepseek-v4.1-flash', tool: 'trae', modelId: 'DeepSeek-V4.1-Flash', label: 'DeepSeek-V4.1-Flash', family: 'DeepSeek', free: false, priceInput: 0.3, priceOutput: 1.2, note: '非高峰刊例价 USD/1M；高峰价翻倍', source: SOURCE.trae },
  { id: 'trae/kimi-k2.5', tool: 'trae', modelId: 'kimi-k2.5', label: 'Kimi-K2.5', family: 'Moonshot', free: false, priceInput: 0.6, priceOutput: 3, note: '刊例价 USD/1M；Subagent 可用模型 ID', source: SOURCE.trae },
  { id: 'trae/minimax-m3', tool: 'trae', modelId: 'minimax-m3', label: 'MiniMax-M3', family: 'MiniMax', free: false, priceInput: 0.6, priceOutput: 2.4, note: '≤200K 刊例价 USD/1M；Subagent 可用模型 ID', source: SOURCE.trae },
  { id: 'trae/claude-sonnet-4.5', tool: 'trae', modelId: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5', family: 'Anthropic', free: false, note: '官方模型列表收录；价格以 Trae 产品内模型选择器为准', source: SOURCE.trae },

  // ---------------- Qoder（Credits 倍率口径） ----------------
  { id: 'qoder/qwen3.8-flash', tool: 'qoder', modelId: 'Qwen3.8-Flash', label: 'Qwen3.8-Flash', family: 'Alibaba', free: true, creditRate: 0, note: '官方限时免费：Credits 倍率由 0.1x 降为 0.0x（2026-09-18 起），以产品显示为准', source: SOURCE.qoderActivity },
  { id: 'qoder/deepseek-v4.1-flash-1017', tool: 'qoder', modelId: 'DeepSeek-V4.1-Flash-1017', label: 'DeepSeek-V4.1-Flash-1017', family: 'DeepSeek', free: true, note: '官方标注「目前限时免费」；精确 Credits 倍率未公开，以模型选择器为准', source: SOURCE.qoder },
  { id: 'qoder/efficient', tool: 'qoder', modelId: 'Efficient', label: 'Efficient（智能档位）', family: 'Qoder', free: true, note: '付费用户限时免费畅用；Free 套餐是否可用以产品显示为准', source: SOURCE.qoder },
  { id: 'qoder/auto', tool: 'qoder', modelId: 'Auto', label: 'Auto（智能档位）', family: 'Qoder', free: false, note: '自动选择模型；Credits 倍率未公开，以模型选择器为准', source: SOURCE.qoder },
  { id: 'qoder/glm-5.3-flash', tool: 'qoder', modelId: 'GLM-5.3-Flash', label: 'GLM-5.3-Flash', family: 'Zhipu', free: false, note: '官方未公开精确 Credits 倍率；以模型选择器显示为准', source: SOURCE.qoder },
  { id: 'qoder/qwen3.8-max', tool: 'qoder', modelId: 'Qwen3.8-Max', label: 'Qwen3.8-Max', family: 'Alibaba', free: false, note: '旗舰模型；官方未公开精确 Credits 倍率', source: SOURCE.qoder },
  { id: 'qoder/deepseek-v4-pro', tool: 'qoder', modelId: 'DeepSeek-V4-Pro', label: 'DeepSeek-V4-Pro', family: 'DeepSeek', free: false, note: '旗舰模型；官方未公开精确 Credits 倍率', source: SOURCE.qoder },
  { id: 'qoder/kimi-k3', tool: 'qoder', modelId: 'Kimi-K3', label: 'Kimi-K3', family: 'Moonshot', free: false, note: '旗舰模型；官方未公开精确 Credits 倍率', source: SOURCE.qoder },
  { id: 'qoder/minimax-m3', tool: 'qoder', modelId: 'MiniMax-M3', label: 'MiniMax-M3', family: 'MiniMax', free: false, note: '旗舰模型；官方未公开精确 Credits 倍率', source: SOURCE.qoder },

  // ---------------- Claude Code（本机订阅登录态，官方 CLI --model） ----------------
  { id: 'claude-code/opus', tool: 'claude-code', modelId: 'opus', label: 'Claude Opus（别名）', family: 'Anthropic', free: false, note: '官方 --model 别名，指向最新 Opus；走本机 Claude 订阅/API 计费，本工具不公开倍率', source: 'https://docs.anthropic.com/en/docs/claude-code' },
  { id: 'claude-code/sonnet', tool: 'claude-code', modelId: 'sonnet', label: 'Claude Sonnet（别名）', family: 'Anthropic', free: false, note: '官方 --model 别名，指向最新 Sonnet；走本机订阅/API 计费', source: 'https://docs.anthropic.com/en/docs/claude-code' },
  { id: 'claude-code/claude-fable-5', tool: 'claude-code', modelId: 'claude-fable-5', label: 'Claude Fable 5', family: 'Anthropic', free: false, note: '官方 --model 完整模型名示例；计费由 Anthropic 官方决定', source: 'https://docs.anthropic.com/en/docs/claude-code' },

  // ---------------- Codex CLI（本机订阅登录态） ----------------
  { id: 'codex/gpt-5.1-codex', tool: 'codex', modelId: 'gpt-5.1-codex', label: 'GPT 5.1 Codex', family: 'OpenAI', free: false, note: 'OpenAI 官方模型；走本机 Codex 订阅/API 计费，本工具不公开倍率', source: 'https://developers.openai.com/codex' },
  { id: 'codex/gpt-5.1-codex-max', tool: 'codex', modelId: 'gpt-5.1-codex-max', label: 'GPT 5.1 Codex Max', family: 'OpenAI', free: false, note: 'OpenAI 官方模型；订阅/API 计费', source: 'https://developers.openai.com/codex' },
  { id: 'codex/gpt-5.1-codex-mini', tool: 'codex', modelId: 'gpt-5.1-codex-mini', label: 'GPT 5.1 Codex Mini', family: 'OpenAI', free: false, note: 'OpenAI 官方模型；订阅/API 计费', source: 'https://developers.openai.com/codex' }
]

export function modelById(id?: string): ModelEntry | undefined {
  if (!id) return undefined
  return MODEL_CATALOG.find((item) => item.id === id)
}

/** 按 Agent 内置 ID 推断其可用的模型工具；自定义/API 成员返回 undefined（由用户自行填写）。 */
export function modelToolForAgent(agentId?: string): ModelTool | undefined {
  if (!agentId) return undefined
  const found = (Object.keys(MODEL_TOOL_AGENTS) as ModelTool[]).find((tool) => MODEL_TOOL_AGENTS[tool].includes(agentId))
  return found
}

/** 模型倍率展示文案：区分「免费 / 官方Credits倍率 / 官方刊例价 / 未公开」。 */
export function modelRateText(entry: ModelEntry): string {
  if (entry.free) return entry.creditRate === 0 ? '0x（官方免费）' : '免费（官方限时）'
  if (entry.creditRate !== undefined) return `${entry.creditRate}x`
  if (entry.priceInput !== undefined && entry.priceOutput !== undefined) {
    return `$${entry.priceInput}/$${entry.priceOutput} 每 1M`
  }
  return '官方未公开'
}

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
