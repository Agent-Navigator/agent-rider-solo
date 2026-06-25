import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiProxy = {
  '/api': {
    target: 'http://127.0.0.1:8789',
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
    target: 'http://127.0.0.1:5174',
    changeOrigin: true,
  },
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: ['dev-agent-rider.aicrmtech.com'],
    proxy: apiProxy,
  },
  preview: {
    host: true,
    port: 5173,
    strictPort: true,
    allowedHosts: ['dev-agent-rider.aicrmtech.com'],
    proxy: apiProxy,
  },
})
