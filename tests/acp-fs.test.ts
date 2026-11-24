import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpAdapter } from '@adapters/index'
import type { FileChange } from '@shared/index'
import { defaultPermissionPolicy, nowIso } from '@shared/index'
import type { AgentDefinition } from '@shared/index'

const fixture = join(process.cwd(), 'tests/fixtures/mock-acp-fs-agent.mjs')

function definition(target: string): AgentDefinition {
  return {
    id: 'agent-fs', name: 'FS Agent', kind: 'native-acp', vendor: 'Test',
    command: process.execPath, args: [fixture], env: { MOCK_WRITE_PATH: target },
    headlessArgs: [], headlessFallback: false, usageSupported: false,
    enabled: true, authMode: 'native-login', role: 'developer', installed: true
  }
}

describe('ACP 文件写入代理', () => {
  it('工作区内写入经审批后落盘并生成 FileChange', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'atd-fs-'))
    const target = join(cwd, 'note.txt')
    const changes: FileChange[] = []
    const events: string[] = []
    const adapter = new AcpAdapter()
    const session = await adapter.connect(definition(target), cwd, {
      onEvent: (event) => events.push(event.type),
      policy: defaultPermissionPolicy(),
      workspacePaths: [cwd],
      requestApproval: async () => 'approved',
      onFileChange: (change) => changes.push({ ...change, createdAt: nowIso() })
    })
    await adapter.send(session, '写入文件')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('第二行')
    expect(changes.some((change) => change.path === target && change.diff.includes('第二行'))).toBe(true)
    expect(events).toContain('file.changed')
    await adapter.disconnect(session)
  })

  it('工作目录外写入被拒绝且不会创建文件', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'atd-fs-'))
    const other = mkdtempSync(join(tmpdir(), 'atd-outside-'))
    const target = join(other, 'forbidden.txt')
    const adapter = new AcpAdapter()
    const session = await adapter.connect(definition(target), cwd, {
      onEvent: () => undefined,
      policy: { ...defaultPermissionPolicy(), restrictToWorkspace: true },
      workspacePaths: [cwd],
      requestApproval: async () => 'approved'
    })
    await expect(adapter.send(session, '写入文件')).rejects.toThrow()
    expect(existsSync(target)).toBe(false)
    await adapter.disconnect(session)
  })
})
