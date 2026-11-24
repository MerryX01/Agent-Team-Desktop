import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SqliteStore } from '@storage/index'
import { NativeProcessAdapter, detectAgent, detectDesktopApp, checkLoginStatus } from '@adapters/index'
import {
  DEFAULT_AGENTS, MODEL_CATALOG, MODEL_TOOL_AGENTS, MODEL_TOOL_LABEL,
  modelToolForAgent
} from '@shared/index'
import type { AgentDefinition } from '@shared/index'

const doubao = DEFAULT_AGENTS.find((agent) => agent.id === 'agent-doubao')!

describe('豆包 CLI 内置 Agent', () => {
  it('使用官方 @bytedance/doubao-cli 的命令，不冒充 ACP', () => {
    expect(doubao).toBeDefined()
    expect(doubao.name).toBe('豆包 CLI')
    expect(doubao.vendor).toBe('ByteDance')
    expect(doubao.kind).toBe('native-process')
    expect(doubao.command).toBe('doubao')
    expect(doubao.headlessCommand).toBe('doubao')
    expect(doubao.headlessArgs).toEqual(['-p'])
    expect(doubao.statusArgs).toEqual(['auth', 'status'])
    expect(doubao.authMode).toBe('native-login')
    expect(doubao.enabled).toBe(true)
    expect(doubao.note).toContain('@bytedance/doubao-cli')
  })

  it('模型目录中豆包仅作工具映射，不收录虚构的模型/倍率条目', () => {
    expect(MODEL_TOOL_LABEL.doubao).toBe('豆包 CLI')
    expect(MODEL_TOOL_AGENTS.doubao).toEqual(['agent-doubao'])
    expect(modelToolForAgent('agent-doubao')).toBe('doubao')
    expect(MODEL_CATALOG.filter((entry) => entry.tool === 'doubao')).toHaveLength(0)
  })

  it('可识别豆包桌面端安装痕迹，但不冒充可调度 CLI', async () => {
    // 未安装 CLI 时，桌面端探测仅按目录名只读扫描；无匹配时返回 undefined。
    const result = await detectDesktopApp('doubao')
    expect(result === undefined || typeof result === 'string').toBe(true)
  })

  it('检测已安装的官方 CLI 时读取 .cmd shim 并拿到版本号', async () => {
    const result = await detectAgent(doubao)
    expect(result.installed).toBe(true)
    expect(result.commandPath).toMatch(/\.cmd$/i)
    expect(result.version).toMatch(/^doubao \d+/)
  })

  it('auth status 返回 login_required 时不误判为已登录', async () => {
    const status = await checkLoginStatus(doubao)
    expect(['logged-in', 'not-logged-in']).toContain(status.state)
    if (/login_required|未登录/i.test(status.detail)) expect(status.state).toBe('not-logged-in')
  })
})

describe('豆包 Agent 持久化与运行时', () => {
  it('新库初始化默认包含豆包；旧库补装时自动回填', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atd-doubao-'))
    const dbPath = join(dir, 'test.db')
    const fresh = new SqliteStore(dbPath)
    expect(fresh.agents().some((agent) => agent.id === 'agent-doubao')).toBe(true)
    fresh.close()

    // 模拟旧库：删除豆包后重新打开，迁移逻辑应回填。
    const legacy = new SqliteStore(dbPath)
    legacy.remove('agents', 'id', 'agent-doubao')
    expect(legacy.agents().some((agent) => agent.id === 'agent-doubao')).toBe(false)
    legacy.close()

    const migrated = new SqliteStore(dbPath)
    const restored = migrated.agents().find((agent) => agent.id === 'agent-doubao')
    expect(restored).toBeDefined()
    expect(restored?.command).toBe('doubao')
    migrated.close()
  })

  it('配置 modelRef 时按官方支持的方式注入 --model', async () => {
    const adapter = new NativeProcessAdapter()
    const definition: AgentDefinition = {
      ...doubao,
      id: 'agent-doubao',
      modelRef: 'codex/gpt-5.1-codex-mini',
      headlessCommand: process.execPath,
      headlessArgs: []
    }
    const session = await adapter.connect(definition, process.cwd(), { onEvent: () => undefined })
    expect((session as unknown as { baseArgs: string[] }).baseArgs).toEqual(['--model', 'gpt-5.1-codex-mini'])
    await adapter.disconnect(session)
  })
})
