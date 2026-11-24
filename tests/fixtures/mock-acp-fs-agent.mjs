import * as acp from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

const sessions = new Map()

acp.agent({ name: 'mock-acp-fs-agent' })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false }
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const id = `fs-${Math.random().toString(36).slice(2, 9)}`
    sessions.set(id, true)
    return { sessionId: id }
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const target = process.env.MOCK_WRITE_PATH
    if (!target) throw new Error('MOCK_WRITE_PATH 未设置')
    await ctx.client.request(acp.methods.client.fs.writeTextFile, {
      sessionId: ctx.params.sessionId,
      path: target,
      content: '由 ACP Agent 写入\n第二行\n'
    })
    await ctx.client.notify(acp.methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '文件已写入' } }
    })
    return { stopReason: 'end_turn' }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
