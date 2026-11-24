import * as acp from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

const sessions = new Map()

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

const app = acp.agent({ name: 'mock-acp-agent' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false }
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const id = `mock-${Math.random().toString(36).slice(2, 9)}`
    sessions.set(id, { controller: new AbortController() })
    return { sessionId: id }
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const session = sessions.get(ctx.params.sessionId)
    if (!session) throw acp.RequestError.sessionNotFound(ctx.params.sessionId)
    const text = ctx.params.prompt.map((block) => block.type === 'text' ? block.text : '').join('')
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: '读取上下文', status: 'in_progress' }
    })
    await delay(30)
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' }
    })
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ECHO:${text}` } }
    })
    if (session.controller.signal.aborted) return { stopReason: 'cancelled' }
    await delay(text.includes('SLOW') ? 1500 : 20)
    if (session.controller.signal.aborted) return { stopReason: 'cancelled' }
    return { stopReason: 'end_turn' }
  })
  .onNotification(acp.methods.agent.session.cancel, (ctx) => {
    sessions.get(ctx.params.sessionId)?.controller.abort()
  })

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
)
app.connect(stream)
