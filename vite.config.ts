import { defineConfig, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import { createCipheriv, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
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
const guacamoleTarget = process.env.GUACAMOLE_TARGET || 'http://127.0.0.1:8081'
const guacamoleJsonSecretFile = process.env.GUACAMOLE_JSON_SECRET_KEY_FILE || '/root/.guacamole-json-secret'
const guacamoleVncPasswordFile = process.env.GUACAMOLE_VNC_PASSWORD_FILE || '/root/.guacamole-vnc-password'

function readTrimmedFile(path: string) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return undefined
  }
}

function getGuacamoleJsonSecretKey() {
  return process.env.GUACAMOLE_JSON_SECRET_KEY?.trim() || readTrimmedFile(guacamoleJsonSecretFile)
}

function getGuacamoleVncPassword() {
  return process.env.GUACAMOLE_VNC_PASSWORD?.trim() || readTrimmedFile(guacamoleVncPasswordFile)
}

function encryptGuacamoleJsonAuth(secretHex: string, authPayload: unknown) {
  if (!/^[0-9a-fA-F]{32}$/.test(secretHex)) {
    throw new Error('GUACAMOLE_JSON_SECRET_KEY must be a 32-digit hexadecimal AES-128 key')
  }

  const key = Buffer.from(secretHex, 'hex')
  const json = JSON.stringify(authPayload)
  const signature = createHmac('sha256', key).update(json, 'utf8').digest()
  const signedPayload = Buffer.concat([signature, Buffer.from(json, 'utf8')])
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16))

  return Buffer.concat([cipher.update(signedPayload), cipher.final()]).toString('base64')
}

function getGuacamoleConnectionName() {
  return process.env.GUACAMOLE_CONNECTION_NAME || 'Local Desktop'
}

function createGuacamoleClientIdentifier(connectionName: string) {
  return Buffer.from(`${connectionName}\0c\0json`, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function getGuacamoleConnectionParameters() {
  const protocol = process.env.GUACAMOLE_PROTOCOL || 'vnc'
  const parameters: Record<string, string> = {
    hostname: process.env.GUACAMOLE_DESKTOP_HOST || '127.0.0.1',
    port: process.env.GUACAMOLE_DESKTOP_PORT || '5903',
  }

  const password = getGuacamoleVncPassword()
  if (password) parameters.password = password

  if (protocol === 'vnc') {
    parameters['resize-method'] = process.env.GUACAMOLE_RESIZE_METHOD || 'display-update'
    parameters['color-depth'] = process.env.GUACAMOLE_COLOR_DEPTH || '24'
  }

  if (process.env.GUACAMOLE_PARAMETERS_JSON) {
    const extra = JSON.parse(process.env.GUACAMOLE_PARAMETERS_JSON) as Record<string, unknown>
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null) parameters[key] = String(value)
    }
  }

  return { protocol, parameters }
}

function createGuacamoleAuthData() {
  const secretKey = getGuacamoleJsonSecretKey()
  if (!secretKey) {
    throw new Error(`Missing Guacamole JSON auth secret. Set GUACAMOLE_JSON_SECRET_KEY or create ${guacamoleJsonSecretFile}.`)
  }

  const { protocol, parameters } = getGuacamoleConnectionParameters()
  // The encrypted JSON auth blob stays in the client URL and is re-sent by the
  // Guacamole webapp on every tunnel reconnect. A short TTL therefore makes the
  // desktop drop with "connection not found" once it lapses (~every few
  // minutes), so default to a full working day and keep it overridable.
  const expires = Date.now() + Number(process.env.GUACAMOLE_AUTH_TTL_MS || 12 * 60 * 60 * 1000)
  const connectionName = getGuacamoleConnectionName()
  const username = process.env.GUACAMOLE_AUTH_USERNAME || 'agent-rider'

  return encryptGuacamoleJsonAuth(secretKey, {
    username,
    expires,
    connections: {
      [connectionName]: {
        id: process.env.GUACAMOLE_CONNECTION_ID || 'local-desktop',
        protocol,
        parameters,
      },
    },
  })
}

function guacamoleAutoLoginPlugin(): Plugin {
  function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) {
    const requestUrl = new URL(req.url || '/', 'http://localhost')
    if (requestUrl.pathname !== '/guacamole-auth/start') {
      next()
      return
    }

    try {
      const data = createGuacamoleAuthData()
      const clientIdentifier = createGuacamoleClientIdentifier(getGuacamoleConnectionName())
      res.statusCode = 302
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Location', `/guacamole/?data=${encodeURIComponent(data)}#/client/${encodeURIComponent(clientIdentifier)}`)
      res.end()
    } catch (error) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(error instanceof Error ? error.message : 'Unable to create Guacamole auto-login URL')
    }
  }

  return {
    name: 'agent-rider-guacamole-auto-login',
    configureServer(server) {
      server.middlewares.use(handleRequest)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handleRequest)
    },
  }
}

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
  // Apache Guacamole web application. The iframe enters through
  // /guacamole-auth/start, which redirects here with short-lived encrypted JSON
  // auth data so no Guacamole login prompt or desktop password is exposed.
  '/guacamole': {
    target: guacamoleTarget,
    changeOrigin: true,
    ws: true,
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
}

export default defineConfig({
  plugins: [guacamoleAutoLoginPlugin(), react()],
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
