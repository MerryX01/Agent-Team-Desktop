import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { CredentialStore } from '@adapters/index'

interface StoredCredential {
  iv: string
  value: string
  algorithm: 'safeStorage'
}

/**
 * API Key 不写入 SQLite：数据库只保存 credentialRef，密钥经 Electron safeStorage
 * （Windows 上由系统 DPAPI 保护）加密后单独存放。
 */
export class ElectronCredentialStore implements CredentialStore {
  private readonly file: string
  private data: Record<string, StoredCredential>

  constructor(userDataPath: string) {
    this.file = join(userDataPath, 'credentials.enc.json')
    if (!existsSync(userDataPath)) mkdirSync(userDataPath, { recursive: true })
    this.data = this.load()
  }

  private load(): Record<string, StoredCredential> {
    if (!existsSync(this.file)) return {}
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, StoredCredential>
    } catch {
      return {}
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
  }

  get(ref: string): string | undefined {
    const item = this.data[ref]
    if (!item) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(item.value, 'base64'))
    } catch {
      return undefined
    }
  }

  set(ref: string, secret: string): void {
    this.data[ref] = {
      iv: '',
      value: safeStorage.encryptString(secret).toString('base64'),
      algorithm: 'safeStorage'
    }
    this.persist()
  }

  delete(ref: string): void {
    delete this.data[ref]
    this.persist()
  }
}
