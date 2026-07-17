import { defineConfig, type ProxyOptions } from 'vite'
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

const defaultAllowedHosts = ['dev-agent-rider.aicrmtech.com', 'hermes-agent-yen.tailf0a6a7.ts.net']
const envAllowedHosts = splitCsv(process.env.VITE_ALLOWED_HOSTS)
const allowedHosts = process.env.VITE_ALLOWED_HOSTS === 'all'
  ? true
  : envAllowedHosts?.length
    ? envAllowedHosts
    : defaultAllowedHosts
const storeTarget = `http://127.0.0.1:${process.env.STORE_PORT || '5174'}`
// Hermes conversations are served by the store backend's embedded ACP server
// (server/hermesAcp.mjs) by default — no external hermes-webui deployment
// needed. Set HERMES_TARGET to point /api at an external Hermes WebUI instead.
const hermesTarget = process.env.HERMES_TARGET || storeTarget

const apiProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: hermesTarget,
    changeOrigin: true,
    ws: true,
    rewriteWsOrigin: true,
    configure: (proxy: { on: (event: string, cb: (req: { removeHeader: (name: string) => void }) => void) => void }) => {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.removeHeader('origin')
        proxyReq.removeHeader('referer')
      })
    },
  },
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
