import { app, BrowserWindow, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..')
const isDev = process.env.ELECTRON_DEV === '1'
const webPort = Number(process.env.WEB_PORT || 5173)
const storePort = Number(process.env.STORE_PORT || 5174)
const rendererUrl = process.env.ELECTRON_RENDERER_URL || `http://127.0.0.1:${webPort}`
const startupTimeoutMs = 30_000

const children = new Set()

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function spawnManaged(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      STORE_PORT: String(storePort),
      WEB_PORT: String(webPort),
      VITE_ALLOWED_HOSTS: process.env.VITE_ALLOWED_HOSTS || 'all',
    },
    ...options,
  })

  children.add(child)
  child.stdout?.on('data', (chunk) => process.stdout.write(`[${label}] ${chunk}`))
  child.stderr?.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk}`))
  child.on('exit', (code, signal) => {
    children.delete(child)
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      console.error(`[${label}] exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`)
    }
  })

  return child
}

function startStoreBackend() {
  return spawnManaged('store', process.execPath, [join(rootDir, 'server/store.mjs')], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      STORE_PORT: String(storePort),
      WEB_PORT: String(webPort),
      VITE_ALLOWED_HOSTS: process.env.VITE_ALLOWED_HOSTS || 'all',
    },
  })
}

function startRendererServer() {
  if (process.env.ELECTRON_RENDERER_URL) return null

  const script = isDev ? 'dev' : 'preview'
  const distIndex = join(rootDir, 'dist', 'index.html')
  if (!isDev && !existsSync(distIndex)) {
    throw new Error('Missing dist/index.html. Run `npm run build` before `npm run electron:preview`.')
  }

  return spawnManaged('renderer', npmCommand(), [
    'run',
    script,
    '--',
    '--host',
    '127.0.0.1',
    '--port',
    String(webPort),
  ])
}

async function waitForUrl(url) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < startupTimeoutMs) {
    try {
      const response = await fetch(url, { method: 'HEAD' })
      if (response.ok) return
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    backgroundColor: '#0c111b',
    title: 'Agent Rider',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  void win.loadURL(rendererUrl)
}

function stopChildren() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
}

app.whenReady().then(async () => {
  startStoreBackend()
  startRendererServer()
  await waitForUrl(rendererUrl)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  console.error(error)
  app.quit()
})

app.on('before-quit', stopChildren)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
