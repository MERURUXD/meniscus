import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

/** Serves the fixture page; `@sessile/*` resolve to their TypeScript sources through the workspace. */
export default defineConfig({
  root: fileURLToPath(new URL('./fixtures', import.meta.url)),
  clearScreen: false,
  logLevel: 'warn',
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
  },
})
