// Local SQLite persistence backend for Agent Rider.
// Stores interaction data (runs + conversation turns) so they survive reloads.
// Uses Node's built-in node:sqlite (Node >= 22.5). No native deps to compile.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pty from 'node-pty'
import { WebSocket, WebSocketServer } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_DIR = join(__dirname, '..', 'data')
mkdirSync(DB_DIR, { recursive: true })
const DB_PATH = join(DB_DIR, 'agent-rider.db')
const PORT = Number(process.env.STORE_PORT || 5174)
const DEFAULT_CWD = resolve(process.env.HOME || '/root')

const db = new DatabaseSync(DB_PATH)
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    prompt TEXT,
    category TEXT,
    category_tags TEXT,
    project TEXT,
    workspace TEXT,
    workspace_path TEXT,
    task TEXT,
    job TEXT,
    job_status TEXT,
    resource_ids TEXT,
    sort_index INTEGER,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    parent_turn_id TEXT,
    session_id TEXT,
    prompt TEXT,
    response TEXT,
    status TEXT,
    created_at TEXT,
    updated_at TEXT
  );
`)

// Migration: add sort_index to pre-existing DBs (ignore if it already exists).
try {
  db.exec('ALTER TABLE runs ADD COLUMN sort_index INTEGER')
} catch {
  // column already present
}
try {
  db.exec('ALTER TABLE turns ADD COLUMN parent_turn_id TEXT')
} catch {
  // column already present
}

const upsertRun = db.prepare(`
  INSERT INTO runs (id, session_id, prompt, category, category_tags, project, workspace, workspace_path, task, job, job_status, resource_ids, sort_index, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    session_id = excluded.session_id, prompt = excluded.prompt, category = excluded.category,
    category_tags = excluded.category_tags, project = excluded.project, workspace = excluded.workspace,
    workspace_path = excluded.workspace_path, task = excluded.task, job = excluded.job,
    job_status = excluded.job_status, resource_ids = excluded.resource_ids,
    sort_index = excluded.sort_index,
    created_at = excluded.created_at, updated_at = excluded.updated_at
`)
const upsertTurn = db.prepare(`
  INSERT INTO turns (id, run_id, parent_turn_id, session_id, prompt, response, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    run_id = excluded.run_id, parent_turn_id = excluded.parent_turn_id,
    session_id = excluded.session_id, prompt = excluded.prompt,
    response = excluded.response, status = excluded.status,
    created_at = excluded.created_at, updated_at = excluded.updated_at
`)
const selectRuns = db.prepare('SELECT * FROM runs ORDER BY sort_index ASC, created_at ASC, rowid ASC')
const selectTurns = db.prepare('SELECT * FROM turns ORDER BY created_at ASC, rowid ASC')

const nowIso = () => new Date().toISOString()
const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value ?? '')
  } catch {
    return fallback
  }
}

function runRowToApi(r) {
  return {
    id: r.id,
    prompt: r.prompt,
    category: r.category,
    categoryTags: parseJson(r.category_tags, []),
    project: r.project,
    workspace: r.workspace,
    workspacePath: r.workspace_path,
    task: r.task,
    job: r.job,
    jobStatus: r.job_status,
    resourceIds: parseJson(r.resource_ids, []),
    sessionId: r.session_id || null,
    createdAt: r.created_at,
  }
}
function turnRowToApi(t) {
  return {
    id: t.id,
    runId: t.run_id,
    parentTurnId: t.parent_turn_id || null,
    prompt: t.prompt,
    response: t.response,
    status: t.status,
    createdAt: t.created_at,
  }
}

function saveState({ runs = [], turns = [], sessionId = null }) {
  db.exec('BEGIN')
  try {
    runs.forEach((r, index) => {
      if (!r || !r.id) return
      upsertRun.run(
        String(r.id),
        r.sessionId ?? sessionId ?? null,
        r.prompt ?? '',
        r.category ?? '',
        JSON.stringify(r.categoryTags ?? []),
        r.project ?? '',
        r.workspace ?? '',
        r.workspacePath ?? '',
        r.task ?? '',
        r.job ?? '',
        r.jobStatus ?? 'queued',
        JSON.stringify(r.resourceIds ?? []),
        index,
        r.createdAt ?? nowIso(),
        nowIso(),
      )
    })
    for (const t of turns) {
      if (!t || !t.id) continue
      upsertTurn.run(
        String(t.id),
        t.runId ?? '',
        t.parentTurnId ?? null,
        sessionId,
        t.prompt ?? '',
        t.response ?? '',
        t.status ?? 'queued',
        t.createdAt ?? nowIso(),
        nowIso(),
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(body)
}

// ── Workspace filesystem browsing ──────────────────────────────────────────
// Browsing is sandboxed to BROWSE_ROOT to avoid exposing the whole filesystem.
const BROWSE_ROOT = resolve(process.env.BROWSE_ROOT || '/root')

function safeResolve(input) {
  const target = resolve(input ? String(input) : BROWSE_ROOT)
  if (target !== BROWSE_ROOT && !target.startsWith(BROWSE_ROOT + '/')) return null
  return target
}

function listDirectory(input) {
  const path = safeResolve(input)
  if (!path) return { error: 'path outside allowed root', status: 403 }
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { error: 'path not found', status: 404 }
  }
  if (!stat.isDirectory()) return { error: 'not a directory', status: 400 }

  let dirs = []
  try {
    dirs = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return { error: 'cannot read directory', status: 403 }
  }

  return {
    root: BROWSE_ROOT,
    path,
    parent: path === BROWSE_ROOT ? null : dirname(path),
    dirs,
  }
}

function makeDirectory(parent, name) {
  const cleanName = String(name || '').trim()
  if (!cleanName || cleanName.includes('/') || cleanName === '.' || cleanName === '..') {
    return { error: 'invalid folder name', status: 400 }
  }
  const parentPath = safeResolve(parent)
  if (!parentPath) return { error: 'parent outside allowed root', status: 403 }
  const target = join(parentPath, cleanName)
  if (!safeResolve(target)) return { error: 'target outside allowed root', status: 403 }
  try {
    mkdirSync(target, { recursive: true })
  } catch (error) {
    return { error: String(error?.message || error), status: 400 }
  }
  return { path: target, name: basename(target) }
}

function parseTerminalOutput(output, fallbackCwd) {
  const exitMatch = output.match(/\n?__AGENT_RIDER_EXIT__(\d+)\n?/)
  const cwdMatch = output.match(/\n?__AGENT_RIDER_CWD__(.*)\n?$/)
  const markerIndex = output.indexOf('__AGENT_RIDER_EXIT__')
  const cleanOutput = markerIndex >= 0 ? output.slice(0, markerIndex).replace(/\n+$/, '') : output.replace(/\n+$/, '')

  return {
    output: cleanOutput,
    exitCode: exitMatch ? Number(exitMatch[1]) : null,
    nextCwd: cwdMatch?.[1]?.trim() || fallbackCwd,
  }
}

function runTerminalCommand({ command, cwd }) {
  const cleanCommand = String(command || '').trim()
  const startCwd = safeResolve(cwd || DEFAULT_CWD) || DEFAULT_CWD
  if (!cleanCommand) return Promise.resolve({ output: '', exitCode: 0, cwd: startCwd, nextCwd: startCwd, timedOut: false })

  return new Promise((resolveCommand) => {
    const script = `${cleanCommand}
__agent_rider_status=$?
printf '\\n__AGENT_RIDER_EXIT__%s\\n' "$__agent_rider_status"
printf '__AGENT_RIDER_CWD__%s\\n' "$PWD"
exit "$__agent_rider_status"
`
    const child = spawn('/bin/bash', ['-lc', script], {
      cwd: startCwd,
      env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
    })
    let output = ''
    let timedOut = false
    const maxOutput = 500_000

    const appendOutput = (chunk) => {
      output += chunk.toString()
      if (output.length > maxOutput) {
        output = `${output.slice(0, maxOutput)}\n[output truncated]\n`
        child.kill('SIGTERM')
      }
    }

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 120_000)

    child.stdout.on('data', appendOutput)
    child.stderr.on('data', appendOutput)
    child.on('error', (error) => {
      clearTimeout(timeout)
      resolveCommand({
        output: String(error?.message || error),
        exitCode: 1,
        cwd: startCwd,
        nextCwd: startCwd,
        timedOut,
      })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timeout)
      const parsed = parseTerminalOutput(output, startCwd)
      resolveCommand({
        output: timedOut ? `${parsed.output}${parsed.output ? '\n' : ''}[command timed out]` : parsed.output,
        exitCode: parsed.exitCode ?? code,
        signal,
        cwd: startCwd,
        nextCwd: safeResolve(parsed.nextCwd) || startCwd,
        timedOut,
      })
    })
  })
}

function parseTerminalSize(searchParams) {
  const cols = Number(searchParams.get('cols') || 100)
  const rows = Number(searchParams.get('rows') || 28)
  return {
    cols: Number.isFinite(cols) ? Math.max(20, Math.min(240, Math.floor(cols))) : 100,
    rows: Number.isFinite(rows) ? Math.max(6, Math.min(80, Math.floor(rows))) : 28,
  }
}

function attachTerminalSocket(server) {
  const terminalWss = new WebSocketServer({ server, path: '/store/terminal/ws' })

  terminalWss.on('connection', (socket, req) => {
    const requestUrl = new URL(req.url || '/store/terminal/ws', 'http://localhost')
    const cwd = safeResolve(requestUrl.searchParams.get('cwd') || DEFAULT_CWD) || DEFAULT_CWD
    const { cols, rows } = parseTerminalSize(requestUrl.searchParams)
    const shell = process.env.SHELL || '/bin/bash'
    const terminal = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: process.env.COLORTERM || 'truecolor',
      },
    })

    const writeSocket = (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
    }

    writeSocket(`\r\n\x1b[32mConnected to Agent Rider terminal\x1b[0m\r\n`)

    const terminalData = terminal.onData((data) => writeSocket(data))
    terminal.onExit(({ exitCode, signal }) => {
      writeSocket(`\r\n\x1b[33mTerminal exited with code ${exitCode}${signal ? ` signal ${signal}` : ''}\x1b[0m\r\n`)
      socket.close()
    })

    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (message?.type === 'input') {
        terminal.write(String(message.data ?? ''))
        return
      }

      if (message?.type === 'resize') {
        const nextCols = Number(message.cols)
        const nextRows = Number(message.rows)
        if (Number.isFinite(nextCols) && Number.isFinite(nextRows)) {
          terminal.resize(Math.max(20, Math.min(240, Math.floor(nextCols))), Math.max(6, Math.min(80, Math.floor(nextRows))))
        }
      }
    })

    socket.on('close', () => {
      terminalData.dispose()
      terminal.kill()
    })
  })
}

const server = createServer((req, res) => {
  const url = (req.url || '').split('?')[0]

  if (req.method === 'GET' && url === '/store/state') {
    const runs = selectRuns.all().map(runRowToApi)
    const turns = selectTurns.all().map(turnRowToApi)
    sendJson(res, 200, { runs, turns })
    return
  }

  if (req.method === 'POST' && url === '/store/save') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 25_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        saveState(JSON.parse(body || '{}'))
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 400, { error: String(error?.message || error) })
      }
    })
    return
  }

  if (req.method === 'GET' && url === '/store/fs/list') {
    const query = new URL(req.url, 'http://localhost').searchParams
    const result = listDirectory(query.get('path') || '')
    sendJson(res, result.error ? result.status : 200, result)
    return
  }

  if (req.method === 'POST' && url === '/store/fs/mkdir') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 100_000) req.destroy()
    })
    req.on('end', () => {
      try {
        const { parent, name } = JSON.parse(body || '{}')
        const result = makeDirectory(parent, name)
        sendJson(res, result.error ? result.status : 200, result)
      } catch (error) {
        sendJson(res, 400, { error: String(error?.message || error) })
      }
    })
    return
  }

  if (req.method === 'POST' && url === '/store/terminal/run') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 100_000) req.destroy()
    })
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}')
        void runTerminalCommand(payload).then((result) => sendJson(res, 200, result))
      } catch (error) {
        sendJson(res, 400, { error: String(error?.message || error) })
      }
    })
    return
  }

  sendJson(res, 404, { error: 'not found' })
})

attachTerminalSocket(server)

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[store] Agent Rider SQLite backend on http://127.0.0.1:${PORT} → ${DB_PATH}`)
})
