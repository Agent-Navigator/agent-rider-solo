import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const configDir = dirname(fileURLToPath(import.meta.url))

function buildGitVersion() {
  try {
    return execSync('git rev-parse HEAD', { cwd: configDir }).toString().trim().slice(-6)
  } catch {
    return 'unknown'
  }
}

const splitCsv = (value: string | undefined) =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const defaultAllowedHosts = ['dev-agent-rider.aicrmtech.com']
const envAllowedHosts = splitCsv(process.env.VITE_ALLOWED_HOSTS)
const allowedHosts = process.env.VITE_ALLOWED_HOSTS === 'all'
  ? true
  : envAllowedHosts?.length
    ? envAllowedHosts
    : defaultAllowedHosts
const storeTarget = `http://127.0.0.1:${process.env.STORE_PORT || '5174'}`
const apiProxy = {
  // Local SQLite persistence backend (server/store.mjs)
  '/store': {
    target: storeTarget,
    changeOrigin: true,
    ws: true,
  },
  // Same-origin static mount for built Agent Apps (AGENT_RIDER_APPS_DIR/<slug>/dist/),
  // served by the store backend at /apps/<slug>/ so they need no external URL.
  '/apps': {
    target: storeTarget,
    changeOrigin: true,
  },
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(buildGitVersion()),
  },
  resolve: {
    preserveSymlinks: true,
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts,
    proxy: apiProxy,
  },
  preview: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts,
    proxy: apiProxy,
  },
})
