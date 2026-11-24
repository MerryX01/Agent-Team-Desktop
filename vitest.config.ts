import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(root, 'packages/shared/src'),
      '@storage': resolve(root, 'packages/storage/src'),
      '@adapters': resolve(root, 'packages/adapters/src'),
      '@orchestrator': resolve(root, 'packages/orchestrator/src')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    environment: 'node'
  }
})
