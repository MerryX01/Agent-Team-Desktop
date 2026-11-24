import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SqliteStore } from '@storage/index'
import { AdapterRegistry } from '@adapters/index'
import { probeAgents } from '@orchestrator/health'

const live = process.env.ATD_LIVE_PROBE === '1'

/**
 * 真机体检：只有显式设置 ATD_LIVE_PROBE=1 时才运行，避免 CI/常规测试消耗账号额度。
 * 目的：证明每个本机 Agent 到底是「能回复」还是「没额度/没登录/没装」。
 */
describe.skipIf(!live)('真实 CLI 应答体检', () => {
  it('逐个连接并发送最小 prompt，输出可复核的体检结果', async () => {
    const store = new SqliteStore(':memory:')
    const registry = new AdapterRegistry(store)
    const only = (process.env.ATD_LIVE_AGENTS ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    const results = await probeAgents(store, registry, {
      cwd: process.cwd(),
      concurrency: 3,
      agentIds: only.length ? only : undefined,
      onResult: (result) => {
        console.log(`[probe] ${result.agentName}: ${result.state} ${result.latencyMs}ms ${result.detail.slice(0, 120)}`)
      }
    })
    const outDir = join(process.cwd(), 'tmp')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'live-probe.json'), JSON.stringify(results, null, 2), 'utf8')
    console.log('[probe] summary', results.map((item) => `${item.agentName}=${item.state}`).join(', '))
    expect(results.length).toBeGreaterThan(0)
    await registry.disconnectAll()
    store.close()
  }, 900000)
})
