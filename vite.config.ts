import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
const hermesTarget = process.env.HERMES_TARGET || 'http://127.0.0.1:8789'
const storeTarget = `http://127.0.0.1:${process.env.STORE_PORT || '5174'}`
const selkiesTarget = process.env.SELKIES_TARGET || 'http://127.0.0.1:8080'

const apiProxy = {
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
  // Same-origin static mount for built Agent Apps (plugins/<slug>/dist/),
  // served by the store backend at /apps/<slug>/ so they need no external URL.
  '/apps': {
    target: storeTarget,
    changeOrigin: true,
  },
  // Same-origin mount of the Hermes WebUI so it can be embedded in an iframe.
  // Hermes sends X-Frame-Options: DENY and CSP frame-ancestors 'none', which
  // block framing outright — we strip those headers on the proxied responses.
  '/hermes-ui': {
    target: hermesTarget,
    changeOrigin: true,
    ws: true,
    rewrite: (path: string) => path.replace(/^\/hermes-ui/, ''),
    configure: (proxy: {
      on: (event: string, cb: (proxyRes: { headers: Record<string, unknown> }) => void) => void
    }) => {
      proxy.on('proxyRes', (proxyRes) => {
        delete proxyRes.headers['x-frame-options']
        delete proxyRes.headers['content-security-policy']
        delete proxyRes.headers['content-security-policy-report-only']
      })
    },
  },
  // Local desktop viewer served by Selkies-GStreamer WebRTC.
  // Defaults to the Selkies web server's common 8080 port, but can be pointed
  // at another local deployment with SELKIES_TARGET.
  '/selkies': {
    target: selkiesTarget,
    changeOrigin: true,
    ws: true,
    rewrite: (path: string) => path.replace(/^\/selkies/, ''),
    configure: (proxy: {
      on: (event: string, cb: (proxyRes: { headers: Record<string, unknown> }) => void) => void
    }) => {
      proxy.on('proxyRes', (proxyRes) => {
        delete proxyRes.headers['x-frame-options']
        delete proxyRes.headers['content-security-policy']
        delete proxyRes.headers['content-security-policy-report-only']
      })
    },
  },
  // Selkies' bundled client fetches TURN/ICE configuration from an absolute
  // /turn path, even when the UI itself is mounted under /selkies/.
  '/turn': {
    target: selkiesTarget,
    changeOrigin: true,
  },
}

export default defineConfig({
  plugins: [react()],
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
