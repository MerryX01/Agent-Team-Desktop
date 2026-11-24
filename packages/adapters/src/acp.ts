import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'
import type { AgentDefinition } from '@shared/index'
import { defaultPermissionPolicy, newId, nowIso } from '@shared/index'
import { buildCmdLine, checkLoginStatus, detectAgent } from './detect'
import { diffSnapshots, ensurePathInWorkspace, readFileSafe, writeFileSafe } from './diff'
import { evaluatePermission, type EvaluablePolicy, type PermissionKind, type PermissionRequest } from './policy'
import type { AgentAdapter, AgentSession, ApprovalDecision, ConnectOptions, EventDraft } from './types'
import { AdapterError } from './types'

interface LiveSession extends AgentSession {
  conn: acp.ClientConnection
  active: acp.ActiveSession
  child: ChildProcessWithoutNullStreams
}

const sessions = new Map<string, LiveSession>()

function spawnAgent(definition: AgentDefinition, cwd: string): ChildProcessWithoutNullStreams {
  if (!definition.command) throw new AdapterError('未配置启动命令，请在 Agent 管理页指定', 'connect')
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new AdapterError(`工作目录不存在或不是目录: ${cwd}`, 'connect')
  }
  const args = definition.args ?? []
  const env = { ...process.env, ...(definition.env ?? {}) }
  const winScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(definition.command)
  const child = winScript
    ? spawn('cmd.exe', ['/d', '/s', '/c', buildCmdLine(definition.command, args)], {
      cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    })
    : spawn(definition.command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  return child as ChildProcessWithoutNullStreams
}

function describeUpdate(update: acp.SessionUpdate): EventDraft | undefined {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text'
        ? { type: 'agent.message.delta', message: update.content.text }
        : { type: 'agent.message.delta', message: `[${update.content.type}]` }
    case 'agent_thought_chunk':
      return { type: 'agent.message.delta', message: update.content.type === 'text' ? update.content.text : '[thought]' }
    case 'tool_call':
      return { type: 'agent.tool.started', message: update.title || '工具调用', data: { toolCallId: update.toolCallId, status: update.status ?? 'pending' } }
    case 'tool_call_update':
      return { type: 'agent.tool.finished', message: `工具调用 ${update.toolCallId}: ${update.status ?? 'unknown'}`, data: { toolCallId: update.toolCallId, status: update.status ?? 'unknown' } }
    case 'plan':
      return { type: 'system', message: 'Agent 更新了执行计划', data: { plan: update.entries?.map((entry) => entry.content) ?? [] } }
    default:
      return undefined
  }
}

function pickOutcome(options: acp.PermissionOption[], decision: ApprovalDecision): acp.PermissionOption | undefined {
  if (decision === 'approved') {
    return options.find((option) => option.kind === 'allow_once') ?? options.find((option) => option.kind === 'allow_always') ?? options[0]
  }
  return options.find((option) => option.kind === 'reject_once') ?? options.find((option) => option.kind === 'reject_always') ?? options.at(-1)
}

const INSTALL_COMMAND_RE = /(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\b|\bpip(?:3)?\s+install\b|\bapt(?:-get)?\s+install\b|\bbrew\s+install\b/i

/** 把 ACP tool_call 归一化为权限评估请求。 */
function toPermissionRequest(toolCall: acp.ToolCallUpdate, cwd: string): PermissionRequest {
  const raw = toolCall.rawInput
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const command = typeof input.command === 'string' ? input.command
    : typeof input.cmd === 'string' ? input.cmd : undefined
  const rawPath = typeof input.path === 'string' ? input.path
    : typeof input.file === 'string' ? input.file
      : typeof input.file_path === 'string' ? input.file_path : undefined
  const title = toolCall.title ?? undefined
  let kind: PermissionKind = 'other'
  switch (toolCall.kind) {
    case 'edit':
    case 'delete':
    case 'move':
      kind = 'file-write'
      break
    case 'execute':
      kind = command && INSTALL_COMMAND_RE.test(command) ? 'install' : 'shell'
      break
    case 'fetch':
      kind = 'network'
      break
    default: {
      const text = `${title ?? ''} ${command ?? ''}`.toLowerCase()
      if (command && INSTALL_COMMAND_RE.test(text)) kind = 'install'
      else if (/(write|edit|save|create|delete|remove|move)/.test(text)) kind = 'file-write'
      else if (/(shell|exec|command|bash|powershell)/.test(text)) kind = 'shell'
      else if (/(fetch|http|request|download)/.test(text)) kind = 'network'
      break
    }
  }
  return {
    kind,
    command,
    path: rawPath ? resolve(cwd, rawPath) : undefined,
    title,
    detail: typeof input.description === 'string' ? input.description : undefined
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new AdapterError(`${label} 超时 (${ms}ms)`, 'connect')), ms) })
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

export class AcpAdapter implements AgentAdapter {
  readonly id = 'acp'
  readonly kind = 'native-acp' as const

  detect(definition: AgentDefinition) { return detectAgent(definition) }
  loginStatus(definition: AgentDefinition) { return checkLoginStatus(definition) }

  async connect(definition: AgentDefinition, cwd: string, options: ConnectOptions): Promise<AgentSession> {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnAgent(definition, cwd)
    } catch (error) {
      throw error instanceof AdapterError ? error : new AdapterError(String(error), 'connect')
    }

    const onEvent = options.onEvent
    const policy: EvaluablePolicy = {
      ...(options.policy ?? defaultPermissionPolicy()),
      permissionMode: options.permissionMode
    }
    const workspacePaths = Array.from(new Set(
      [cwd, ...(options.workspacePaths ?? [])].flatMap((path) => {
        const resolved = resolve(path)
        try { return [resolved, realpathSync(resolved)] } catch { return [resolved] }
      })
    ))

    const client = acp.client({ name: 'agent-team-desktop' })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (ctx.params.update.sessionUpdate === 'usage_update') {
          const usage = ctx.params.update
          options.onUsage?.(usage)
          onEvent({
            type: 'usage.updated', agentId: definition.id, message: 'Agent 更新了用量信息',
            data: { sessionId: ctx.params.sessionId, used: usage.used, size: usage.size, cost: usage.cost ?? undefined }
          })
        }
        const draft = describeUpdate(ctx.params.update)
        if (draft) onEvent({ ...draft, agentId: definition.id, data: { ...draft.data ?? {}, sessionId: ctx.params.sessionId } })
      })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const request = toPermissionRequest(ctx.params.toolCall, cwd)
        const evaluation = evaluatePermission(request, policy, workspacePaths)
        const detail = request.command || request.path || request.detail ||
          ctx.params.toolCall.title || JSON.stringify(ctx.params.toolCall.rawInput ?? {})
        const eventData = {
          toolCallId: ctx.params.toolCall.toolCallId,
          options: ctx.params.options.map((o) => o.name),
          kind: evaluation.kind,
          risk: evaluation.risk,
          reason: evaluation.reason,
          decision: evaluation.decision
        }
        onEvent({
          type: 'agent.permission.required', agentId: definition.id,
          message: `请求权限: ${detail}`, data: eventData
        })
        let decision: ApprovalDecision = 'rejected'
        if (evaluation.decision === 'deny') {
          onEvent({
            type: 'policy.denied', agentId: definition.id,
            message: `策略拒绝: ${evaluation.reason}`, data: eventData
          })
        } else if (evaluation.decision === 'ask') {
          if (options.requestApproval) {
            try {
              decision = await options.requestApproval({
                title: ctx.params.toolCall.title || 'Agent 请求执行操作',
                detail,
                agentId: definition.id,
                runId: options.runId,
                taskId: options.taskId,
                kind: evaluation.kind,
                risk: evaluation.risk,
                path: request.path,
                command: request.command,
                reason: evaluation.reason
              })
            } catch { decision = 'rejected' }
          }
        } else {
          decision = 'approved'
        }
        const selected = pickOutcome(ctx.params.options, decision)
        return { outcome: { outcome: 'selected', optionId: selected?.optionId ?? '' } }
      })
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        let target: string
        try {
          target = await ensurePathInWorkspace(resolve(cwd, ctx.params.path), workspacePaths)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          onEvent({ type: 'policy.denied', agentId: definition.id, message, data: { path: ctx.params.path } })
          throw acp.RequestError.invalidParams(message)
        }
        const file = await readFileSafe(target)
        if (!file) throw acp.RequestError.resourceNotFound(target)
        let content = file.content
        const line = ctx.params.line ?? 1
        if (line > 1 || ctx.params.limit != null) {
          const lines = content.split('\n')
          content = lines.slice(Math.max(0, line - 1), Math.max(0, line - 1) + Math.max(0, ctx.params.limit ?? lines.length)).join('\n')
        }
        return { content }
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        let target: string
        try {
          target = await ensurePathInWorkspace(resolve(cwd, ctx.params.path), workspacePaths)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          onEvent({ type: 'policy.denied', agentId: definition.id, message, data: { path: ctx.params.path } })
          throw acp.RequestError.invalidParams(message)
        }
        const evaluation = evaluatePermission(
          { kind: 'file-write', path: target, title: `写入文件 ${target}` },
          policy, workspacePaths
        )
        const before = await readFileSafe(target)
        const eventData = { path: target, kind: evaluation.kind, risk: evaluation.risk, reason: evaluation.reason }
        if (evaluation.decision === 'deny') {
          onEvent({ type: 'policy.denied', agentId: definition.id, message: `策略拒绝写入: ${evaluation.reason}`, data: eventData })
          throw acp.RequestError.invalidParams(evaluation.reason)
        }
        if (evaluation.decision === 'ask') {
          if (!options.requestApproval) {
            const reason = '未配置审批处理器，拒绝写入文件'
            onEvent({ type: 'policy.denied', agentId: definition.id, message: reason, data: eventData })
            throw acp.RequestError.invalidParams(reason)
          }
          let decision: ApprovalDecision = 'rejected'
          try {
            decision = await options.requestApproval({
              title: `写入文件 ${target}`,
              detail: ctx.params.content.slice(0, 500),
              agentId: definition.id,
              runId: options.runId,
              taskId: options.taskId,
              kind: evaluation.kind,
              risk: evaluation.risk,
              path: target,
              reason: evaluation.reason
            })
          } catch { decision = 'rejected' }
          if (decision !== 'approved') {
            const reason = '用户拒绝写入文件'
            onEvent({ type: 'policy.denied', agentId: definition.id, message: reason, data: eventData })
            throw acp.RequestError.invalidParams(reason)
          }
        }
        try {
          await writeFileSafe(target, ctx.params.content, workspacePaths)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          onEvent({ type: 'policy.denied', agentId: definition.id, message, data: eventData })
          throw acp.RequestError.invalidParams(message)
        }
        const after = await readFileSafe(target)
        const change = diffSnapshots(
          before ? { [target]: before } : {},
          after ? { [target]: after } : {},
          { runId: options.runId, taskId: options.taskId, agentId: definition.id }
        )[0]
        if (change) {
          options.onFileChange?.(change)
          onEvent({
            type: 'file.changed', agentId: definition.id,
            message: `文件已变更: ${target}`,
            data: { path: target, changeId: change.id, binary: change.binary, kind: evaluation.kind, risk: evaluation.risk }
          })
        }
        return {}
      })

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    )

    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString().slice(0, 4000) })

    const conn = client.connect(stream)
    try {
      const init = await withTimeout(
        conn.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
        }),
        options.timeoutMs ?? 20000,
        'ACP initialize'
      )
      onEvent({ type: 'system', agentId: definition.id, message: `ACP 连接成功，协议版本 ${init.protocolVersion}` })
      const active = await withTimeout(conn.agent.buildSession(cwd).start(), options.timeoutMs ?? 20000, 'ACP session/new')
      const session: LiveSession = {
        id: newId('session'), agentId: definition.id, sessionId: active.sessionId, pid: child.pid,
        protocol: 'acp', status: 'online', cwd, startedAt: nowIso(), conn, active, child
      }
      sessions.set(session.id, session)
      return session
    } catch (error) {
      conn.close()
      child.kill()
      const suffix = stderr ? `; stderr: ${stderr.slice(-500)}` : ''
      throw new AdapterError(`ACP 连接失败: ${error instanceof Error ? error.message : String(error)}${suffix}`, 'connect')
    }
  }

  async send(session: AgentSession, prompt: string, context?: { taskId?: string; runId?: string }): Promise<string> {
    const live = sessions.get(session.id)
    if (!live) throw new AdapterError('会话不存在或已关闭', 'send')
    live.status = 'busy'
    const prefix = context?.taskId ? `[任务 ${context.taskId}] ` : ''
    const wrapped = prefix + prompt
    let output = ''
    const promptPromise = live.active.prompt(wrapped)
    promptPromise.catch(() => undefined)

    const pump = (async () => {
      for (;;) {
        const message = await live.active.nextUpdate()
        if (message.kind === 'stop') break
        const draft = describeUpdate(message.update)
        if (draft?.type === 'agent.message.delta' && message.update.sessionUpdate === 'agent_message_chunk') {
          output += draft.message
        }
      }
      await promptPromise
    })()

    try {
      await withTimeout(pump, 120000, 'ACP prompt')
      live.status = 'online'
      return output
    } catch (error) {
      live.status = 'failed'
      throw error instanceof AdapterError ? error : new AdapterError(String(error), 'send')
    }
  }

  async cancel(session: AgentSession): Promise<void> {
    const live = sessions.get(session.id)
    if (!live?.sessionId) return
    await live.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: live.sessionId })
    live.status = 'closed'
  }

  async disconnect(session: AgentSession): Promise<void> {
    const live = sessions.get(session.id)
    if (!live) return
    try { live.active.dispose() } catch { /* ignore */ }
    try { live.conn.close() } catch { /* ignore */ }
    if (!live.child.killed) live.child.kill()
    live.status = 'closed'
    sessions.delete(session.id)
  }
}

export const acpAdapter = new AcpAdapter()
