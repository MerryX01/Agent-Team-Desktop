import { isAbsolute, resolve, sep } from 'node:path'
import type { PermissionPolicy } from '@shared/index'

export type PermissionKind = 'file-write' | 'shell' | 'network' | 'install' | 'other'
export type PermissionDecision = 'allow' | 'ask' | 'deny'
export type RiskLevel = 'low' | 'medium' | 'high'

export interface PermissionRequest {
  kind: PermissionKind
  command?: string
  path?: string
  title?: string
  detail?: string
}

/** PermissionPolicy 本身不含 permissionMode（它属于 Team），此处按需扩展以便统一评估。 */
export type EvaluablePolicy = PermissionPolicy & {
  permissionMode?: 'ask' | 'auto-deny' | 'plan'
}

export interface PermissionEvaluation {
  decision: PermissionDecision
  reason: string
  kind: PermissionKind
  risk: RiskLevel
}

function normalizeForCompare(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/**
 * 判断目标路径是否位于任一工作目录内。
 * 使用 path.resolve + 路径分隔符边界，避免 `C:\foo2` 被误判为位于 `C:\foo` 内。
 */
export function isPathInWorkspace(target: string, workspacePaths: string[]): boolean {
  if (!target || workspacePaths.length === 0) return false
  let resolvedTarget: string
  try {
    resolvedTarget = resolve(target)
  } catch {
    return false
  }
  const comparedTarget = normalizeForCompare(resolvedTarget)
  for (const workspace of workspacePaths) {
    if (!workspace) continue
    let resolvedWorkspace: string
    try {
      resolvedWorkspace = resolve(workspace)
    } catch {
      continue
    }
    const comparedWorkspace = normalizeForCompare(resolvedWorkspace)
    const boundary = comparedWorkspace.endsWith(sep) ? comparedWorkspace : comparedWorkspace + sep
    if (comparedTarget === comparedWorkspace || comparedTarget.startsWith(boundary)) return true
  }
  return false
}

function matchesAnyPattern(value: string, patterns: string[]): string | undefined {
  if (!value) return undefined
  const haystack = normalizeForCompare(value)
  return patterns.find((pattern) => {
    const needle = normalizeForCompare(pattern)
    return needle.length > 0 && haystack.includes(needle)
  })
}

function riskForKind(kind: PermissionKind, decision: PermissionDecision): RiskLevel {
  if (decision === 'deny') return 'high'
  if (kind === 'install') return 'high'
  if (kind === 'file-write') return decision === 'allow' ? 'low' : 'medium'
  return 'medium'
}

function decisionText(decision: PermissionDecision): string {
  return decision === 'allow' ? '允许' : decision === 'ask' ? '需要审批' : '拒绝'
}

/**
 * 根据团队策略评估一次权限请求。
 * 评估顺序：全局模式 -> 工作区边界 -> denyPatterns -> allowPatterns -> 按操作类型取策略。
 */
export function evaluatePermission(
  request: PermissionRequest,
  policy: EvaluablePolicy,
  workspacePaths: string[] = []
): PermissionEvaluation {
  const kind = request.kind
  const base = { kind }

  // 1. 团队级全局模式优先于一切细粒度配置
  if (policy.permissionMode === 'auto-deny' || policy.permissionMode === 'plan') {
    return {
      ...base, decision: 'deny', risk: 'high',
      reason: `团队处于 ${policy.permissionMode} 模式，拒绝所有敏感操作`
    }
  }

  // 2. 路径必须落在工作区内，允许多个工作目录
  if (policy.restrictToWorkspace && request.path) {
    if (!isAbsolute(request.path) || !isPathInWorkspace(request.path, workspacePaths)) {
      return {
        ...base, decision: 'deny', risk: 'high',
        reason: `路径 ${request.path} 不在允许的工作目录内`
      }
    }
  }

  const subject = request.command || request.title || request.detail || ''

  // 3. 禁止模式优先于允许模式
  const denied = matchesAnyPattern(subject, policy.denyPatterns ?? [])
  if (denied) {
    return {
      ...base, decision: 'deny', risk: 'high',
      reason: `操作命中禁止模式「${denied}」`
    }
  }

  // 4. allowPatterns 可以把原本需要询问的操作提升为允许
  const allowed = matchesAnyPattern(subject, policy.allowPatterns ?? [])
  if (allowed) {
    return {
      ...base, decision: 'allow', risk: riskForKind(kind, 'allow'),
      reason: `操作命中允许模式「${allowed}」`
    }
  }

  // 5. 按操作类型套用策略
  let configured: 'ask' | 'allow' | 'deny'
  let label: string
  switch (kind) {
    case 'network':
      configured = policy.network
      label = '网络访问'
      break
    case 'shell':
      configured = policy.shellCommand
      label = 'Shell 命令'
      break
    case 'file-write':
      configured = policy.fileWrite
      label = '文件写入'
      break
    case 'install':
      configured = policy.installPackage
      label = '安装依赖包'
      break
    default:
      configured = 'ask'
      label = '其他操作'
      break
  }

  return {
    ...base,
    decision: configured,
    risk: riskForKind(kind, configured),
    reason: `${label}按策略处理：${decisionText(configured)}`
  }
}
