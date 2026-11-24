import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  MODEL_CATALOG, ModelEntrySchema, AgentDefinitionSchema, MODEL_TOOL_AGENTS, modelById, modelRateText,
  modelToolForAgent, newId, type ModelTool, type AgentDefinition
} from '@shared/index'
import { SqliteStore } from '@storage/index'
import { NativeProcessAdapter } from '@adapters/process'

describe('模型映射目录（官方口径）', () => {
  it('所有条目通过 Zod 校验，且 ID 唯一', () => {
    expect(MODEL_CATALOG.length).toBeGreaterThan(30)
    expect(new Set(MODEL_CATALOG.map((item) => item.id)).size).toBe(MODEL_CATALOG.length)
    for (const entry of MODEL_CATALOG) {
      expect(() => ModelEntrySchema.parse(entry)).not.toThrow()
      expect(entry.source.startsWith('https://')).toBe(true)
    }
  })

  it('覆盖全部 5 个工具，且每个内置 Agent 都可映射到目录', () => {
    const tools = new Set<ModelTool>(MODEL_CATALOG.map((item) => item.tool))
    expect([...tools].sort()).toEqual(['claude-code', 'codex', 'opencode', 'qoder', 'trae'])
    for (const ids of Object.values(MODEL_TOOL_AGENTS)) {
      for (const id of ids) expect(modelToolForAgent(id)).toBeDefined()
    }
  })

  it('免费模型如实标注；未公开倍率的不臆造数字', () => {
    const openFree = MODEL_CATALOG.filter((item) => item.tool === 'opencode' && item.free)
    expect(openFree.length).toBeGreaterThanOrEqual(8)
    for (const entry of openFree) {
      expect(modelRateText(entry)).toMatch(/免费/)
    }
    const qoderFlash = modelById('qoder/qwen3.8-flash')!
    expect(qoderFlash.free).toBe(true)
    expect(qoderFlash.creditRate).toBe(0)
    expect(modelRateText(qoderFlash)).toBe('0x（官方免费）')

    const qoderUnknown = modelById('qoder/glm-5.3-flash')!
    expect(qoderUnknown.creditRate).toBeUndefined()
    expect(modelRateText(qoderUnknown)).toBe('官方未公开')

    const priced = modelById('opencode/qwen3.8-flash')!
    expect(modelRateText(priced)).toBe('$0.15/$0.47 每 1M')
    expect(priced.free).toBe(false)
  })

  it('Trae 只收中国版积分倍率口径，不混入国际版刊列价', () => {
    const trae = MODEL_CATALOG.filter((item) => item.tool === 'trae')
    expect(trae.length).toBeGreaterThanOrEqual(9)
    for (const entry of trae) {
      // CN 版按「积分 × 消耗速度倍率」计费，不存在 USD 刊列价
      expect(entry.priceInput).toBeUndefined()
      expect(entry.priceOutput).toBeUndefined()
      expect(entry.source).toContain('trae.cn')
    }
    // IDE 模型选择器实测可核对的 9 个模型必须全部在列
    for (const label of [
      'Seed-2.1-Turbo', 'Seed-2.1-Pro-0915', 'Seed-Evolving', 'Seed-Code',
      'GLM-5.4', 'GLM-5.3-Flash', 'GLM-5.3-FlashX', 'GLM-5.3', 'DeepSeek-V4.1-Flash'
    ]) {
      expect(trae.some((item) => item.label === label)).toBe(true)
    }
    // 国际版（docs.trae.ai）独有模型不得混入
    for (const label of ['GPT-6-Luna', 'GPT-6.2-Sol', 'GPT-5.2', 'GPT-5.4', 'Gemini-3.1-Pro-Preview', 'Gemini-3-Flash-Preview']) {
      expect(trae.some((item) => item.label === label)).toBe(false)
    }
    // 记基准倍率 + 折扣规则，而不是某一次截图里的即时值
    const turbo = modelById('trae/seed-2.1-turbo')!
    expect(turbo.creditRate).toBe(0.4)
    expect(turbo.note).toContain('0.20x')
    expect(modelRateText(turbo)).toBe('0.4x 基准')
    // 套餐锁定且官方未公开倍率的，不得臆造数字
    const glm54 = modelById('trae/glm-5.4')!
    expect(glm54.creditRate).toBeUndefined()
    expect(modelRateText(glm54)).toBe('官方未公开')
  })

  it('自定义/API Agent 不映射到内置工具', () => {
    expect(modelToolForAgent('custom-1')).toBeUndefined()
    expect(modelToolForAgent(undefined)).toBeUndefined()
  })
})

describe('模型映射持久化与运行时应用', () => {
  it('SQLite 迁移支持 modelRef 列并随 Agent 保存', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atd-model-'))
    const store = new SqliteStore(join(dir, 'test.db'))
    const agent = store.agents().find((item) => item.id === 'agent-opencode')!
    expect(agent.modelRef).toBeUndefined()
    expect(agent.cwd).toBeUndefined()
    expect(agent.desktopPath).toBeUndefined()
    store.update('agents', 'id', agent.id, { modelRef: 'opencode/deepseek-v4.1-flash-free' })
    const updated = store.agents().find((item) => item.id === agent.id)
    expect(updated?.modelRef).toBe('opencode/deepseek-v4.1-flash-free')
    // 回归：从 DB 读出的 Agent 原样回传 IPC 校验应通过（null 已归一为 undefined）
    expect(() => AgentDefinitionSchema.parse(updated)).not.toThrow()
    store.close()
  })

  it('headless Agent 按 --model 追加所选模型', async () => {
    const adapter = new NativeProcessAdapter()
    const definition: AgentDefinition = {
      id: newId('agent'), name: 'codex', kind: 'native-process', vendor: 'OpenAI',
      command: process.execPath, args: [], env: {}, headlessArgs: [], headlessFallback: true,
      enabled: true, authMode: 'native-login', role: 'developer', installed: true,
      usageSupported: false, modelRef: 'codex/gpt-5.1-codex-mini'
    }
    const session = await adapter.connect(definition, process.cwd(), { onEvent: () => undefined })
    expect((session as unknown as { baseArgs: string[] }).baseArgs).toEqual(['--model', 'gpt-5.1-codex-mini'])
    await adapter.disconnect(session)
  })

  it('未选择模型时不追加任何参数', async () => {
    const adapter = new NativeProcessAdapter()
    const definition: AgentDefinition = {
      id: newId('agent'), name: 'codex', kind: 'native-process', vendor: 'OpenAI',
      command: process.execPath, args: [], env: {}, headlessArgs: [], headlessFallback: true,
      enabled: true, authMode: 'native-login', role: 'developer', installed: true,
      usageSupported: false
    }
    const session = await adapter.connect(definition, process.cwd(), { onEvent: () => undefined })
    expect((session as unknown as { baseArgs: string[] }).baseArgs).toEqual([])
    await adapter.disconnect(session)
  })
})
