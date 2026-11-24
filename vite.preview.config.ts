import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(root, 'src'),
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': resolve(root, 'packages/shared/src'),
      '@storage': resolve(root, 'packages/storage/src'),
      '@adapters': resolve(root, 'packages/adapters/src'),
      '@orchestrator': resolve(root, 'packages/orchestrator/src')
    }
  },
  server: { host: '127.0.0.1', port: 5173 }
})
