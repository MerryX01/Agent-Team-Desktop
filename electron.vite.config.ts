import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const alias = {
  '@shared': resolve(root, 'packages/shared/src'),
  '@storage': resolve(root, 'packages/storage/src'),
  '@adapters': resolve(root, 'packages/adapters/src'),
  '@orchestrator': resolve(root, 'packages/orchestrator/src')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { input: resolve(root, 'electron/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: { rollupOptions: { input: resolve(root, 'electron/preload/index.ts') } }
  },
  renderer: {
    root: resolve(root, 'src'),
    resolve: { alias },
    plugins: [vue(), tailwindcss()],
    build: { rollupOptions: { input: resolve(root, 'src/index.html') } }
  }
})
