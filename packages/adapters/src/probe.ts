import type { AgentHealth } from '@shared/index'

export type ProbeFailureKind = Extract<AgentHealth, 'no-quota' | 'login-required' | 'timeout' | 'not-installed' | 'error'>

const LOGIN_PATTERNS = [
  /401\b/i, /\bunauthorized\b/i, /\bunauthenticated\b/i, /\bnot\s+logged\s+in\b/i,
  /\blogin\s+(is\s+)?required\b/i, /\bplease\s+(run\s+)?login\b/i, /\bsign\s+in\b/i,
  /\bauthentication\b.*\b(fail|required|expired)\b/i, /\binvalid\s+api\s*key\b/i,
  /未登录/, /请先登录/, /登录已?过期/, /登录状态.*(失效|异常)/, /需要登录/, /认证失败/
]

const QUOTA_PATTERNS = [
  /quota/i, /insufficient\s+(balance|credit|funds|quota)/i, /\bcredits?\b.*\b(exhaust|insufficient|used\s+up)/i,
  /\bout\s+of\s+(credits?|quota|tokens?)\b/i, /\bpayment\s+required\b/i, /\bbilling\b/i,
  /\busage\s+limit\b/i, /\blimit\s+(reached|exceeded)\b/i, /rate[\s-]?limit/i, /\b429\b/,
  /\btoo\s+many\s+requests\b/i, /额度/, /余额不足/, /积分不足/, /套餐.*(用尽|到期|不足)/, /超出.*(额度|限制)/, /限流/
]

const TIMEOUT_PATTERNS = [/timeout/i, /timed?\s*out/i, /超时/, /ETIMEDOUT/]
const MISSING_PATTERNS = [
  /ENOENT/i, /not\s+recognized\s+as\s+an?\s+internal\s+or\s+external\s+command/i,
  /command\s+not\s+found/i, /未找到命令/, /不是内部或外部命令/, /no\s+such\s+file/i
]

/** 把 Agent 的失败文本归因为可执行的状态，供 UI 直接说明“为什么它不理你”。 */
export function classifyAgentFailure(message: string): ProbeFailureKind {
  const text = message || ''
  if (LOGIN_PATTERNS.some((pattern) => pattern.test(text))) return 'login-required'
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(text))) return 'no-quota'
  if (TIMEOUT_PATTERNS.some((pattern) => pattern.test(text))) return 'timeout'
  if (MISSING_PATTERNS.some((pattern) => pattern.test(text))) return 'not-installed'
  return 'error'
}

export const HEALTH_LABEL: Record<AgentHealth, string> = {
  unknown: '未体检',
  ready: '可用',
  'no-quota': '无额度',
  'login-required': '未登录',
  'not-installed': '未安装',
  timeout: '超时',
  error: '异常',
  skipped: '已跳过'
}

/** 只有 ready 才参与群聊调度；其余状态一律跳过并把原因写进交付门禁。 */
export function isDispatchable(health: AgentHealth | undefined): boolean {
  return health === 'ready'
}
