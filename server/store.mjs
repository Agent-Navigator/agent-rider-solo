// Local SQLite persistence backend for Agent Rider.
// Stores interaction data (runs + conversation turns) so they survive reloads.
// Uses Node's built-in node:sqlite (Node >= 22.5). No native deps to compile.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync, createReadStream } from 'node:fs'
import { dirname, join, resolve, basename, extname, normalize } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import * as pty from 'node-pty'
import { WebSocket, WebSocketServer } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_DIR = join(__dirname, '..', 'data')
mkdirSync(DB_DIR, { recursive: true })
const DB_PATH = join(DB_DIR, 'agent-rider.db')
const PORT = Number(process.env.STORE_PORT || 5174)
const DEFAULT_CWD = resolve(process.env.HOME || '/root')

// ── Persistent TUI agent sessions (tmux) ─────────────────────────────────────
// TUI agents (claude/codex) run inside a tmux session on a private tmux server
// so they keep running in the background after the websocket disconnects (card
// closed, page reloaded, even this store process restarted). Reconnecting just
// re-attaches the same session and tmux redraws the current screen.
const TUI_AGENTS = { claude: 'claude', codex: 'codex' }
const TMUX_SOCKET = 'agent-rider' // private server (`tmux -L agent-rider`)
const TMUX_CONF = join(tmpdir(), 'agent-rider-tmux.conf')
try {
  writeFileSync(
    TMUX_CONF,
    [
      'set -g status off', // no status bar — embed cleanly in the card
      'set -g window-size latest', // follow the most recently attached client
      'set -g mouse on',
      'set -g history-limit 10000',
      'set -g destroy-unattached off', // keep sessions alive while detached
      'setw -g aggressive-resize on',
    ].join('\n') + '\n',
  )
} catch {
  // best-effort; tmux falls back to its defaults if the conf can't be written
}

// Build a tmux session name that is stable per (run, agent, cwd) and safe for
// tmux (no '.' or ':'). A cwd change yields a new session so it starts there.
function tmuxSessionName(sessionKey, agent) {
  const safe = String(sessionKey).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  return `ar_${agent}_${safe}`
}

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
    agent_type TEXT,
    col_index INTEGER,
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
// Migration: which agent backend drives each conversation (hermes | claude | codex).
try {
  db.exec('ALTER TABLE runs ADD COLUMN agent_type TEXT')
} catch {
  // column already present
}
// Migration: which card column (0|1) a conversation sits in (two-column layout).
try {
  db.exec('ALTER TABLE runs ADD COLUMN col_index INTEGER')
} catch {
  // column already present
}

// Persisted display order for Agent App plugins (existence comes from the
// manifests under plugins/; this table only records the user's preferred order).
db.exec(`
  CREATE TABLE IF NOT EXISTS app_order (
    slug TEXT PRIMARY KEY,
    sort_index INTEGER,
    updated_at TEXT
  );
`)
const selectAppOrder = db.prepare('SELECT slug, sort_index FROM app_order')
const upsertAppOrder = db.prepare(`
  INSERT INTO app_order (slug, sort_index, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(slug) DO UPDATE SET sort_index = excluded.sort_index, updated_at = excluded.updated_at
`)

// User-chosen display name for an app, overriding the manifest's label. Kept
// server-side (like order) so it survives the agent rewriting its manifest.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_label (
    slug TEXT PRIMARY KEY,
    label TEXT,
    updated_at TEXT
  );
`)
const selectAppLabels = db.prepare('SELECT slug, label FROM app_label')
const upsertAppLabel = db.prepare(`
  INSERT INTO app_label (slug, label, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(slug) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at
`)
const deleteAppLabel = db.prepare('DELETE FROM app_label WHERE slug = ?')

const upsertRun = db.prepare(`
  INSERT INTO runs (id, session_id, prompt, category, category_tags, project, workspace, workspace_path, task, job, job_status, resource_ids, agent_type, col_index, sort_index, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    session_id = excluded.session_id, prompt = excluded.prompt, category = excluded.category,
    category_tags = excluded.category_tags, project = excluded.project, workspace = excluded.workspace,
    workspace_path = excluded.workspace_path, task = excluded.task, job = excluded.job,
    job_status = excluded.job_status, resource_ids = excluded.resource_ids,
    agent_type = excluded.agent_type, col_index = excluded.col_index, sort_index = excluded.sort_index,
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
    agentType: r.agent_type || 'hermes',
    column: Number.isFinite(r.col_index) ? r.col_index : 0,
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
        r.agentType ?? 'hermes',
        Number.isFinite(r.column) ? r.column : 0,
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
    // Reconcile deletions: the client sends the full state, so any row no longer
    // present has been deleted and must be removed (an upsert-only save would let
    // deleted conversations reappear on the next reload).
    const runIds = runs.filter((r) => r && r.id).map((r) => String(r.id))
    const turnIds = turns.filter((t) => t && t.id).map((t) => String(t.id))
    if (runIds.length) {
      db.prepare(`DELETE FROM runs WHERE id NOT IN (${runIds.map(() => '?').join(',')})`).run(...runIds)
    } else {
      db.exec('DELETE FROM runs')
    }
    if (turnIds.length) {
      db.prepare(`DELETE FROM turns WHERE id NOT IN (${turnIds.map(() => '?').join(',')})`).run(...turnIds)
    } else {
      db.exec('DELETE FROM turns')
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
  let files = []
  try {
    const entries = readdirSync(path, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'))
    dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filePath = join(path, entry.name)
        let size = null
        try {
          size = statSync(filePath).size
        } catch {
          // Unreadable file (e.g. broken symlink) — list it without a size.
        }
        return { name: entry.name, path: filePath, size }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return { error: 'cannot read directory', status: 403 }
  }

  return {
    root: BROWSE_ROOT,
    path,
    parent: path === BROWSE_ROOT ? null : dirname(path),
    dirs,
    files,
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

// ── Agent App plugins ───────────────────────────────────────────────────────
// Apps are self-contained static web apps living under plugins/<slug>/, built to
// plugins/<slug>/dist/ and served same-origin at /apps/<slug>/. They are
// discovered at runtime (no rebuild of the main app) by scanning manifests.
const PLUGINS_DIR = join(__dirname, '..', 'plugins')
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

function readManifest(dir) {
  const manifestPath = join(PLUGINS_DIR, dir, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return { __parseError: true }
  }
}

// Returns { apps, warnings, hash }. `apps` is the active, de-duplicated, ordered
// list; `warnings` surfaces invalid/duplicate manifests so the UI can flag them.
function scanApps() {
  let dirs = []
  try {
    dirs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return { apps: [], warnings: [], hash: '0' }
  }

  const warnings = []
  const candidates = []
  const seenIds = new Map() // id -> [dirs]
  const labelMap = new Map(selectAppLabels.all().map((row) => [row.slug, row.label]))

  for (const dir of dirs) {
    const manifest = readManifest(dir)
    if (!manifest) continue // no manifest.json → not an app (e.g. first-party build-time plugin)
    if (manifest.__parseError) {
      warnings.push({ dir, error: 'manifest.json is not valid JSON' })
      continue
    }
    const id = String(manifest.id ?? dir)
    if (!SLUG_RE.test(id)) {
      warnings.push({ dir, id, error: 'invalid slug (use lowercase letters, digits, hyphens)' })
      continue
    }
    seenIds.set(id, [...(seenIds.get(id) ?? []), dir])
    const distDir = join(PLUGINS_DIR, dir, 'dist')
    candidates.push({
      id,
      dir,
      label: labelMap.get(id) ?? String(manifest.label ?? id),
      group: String(manifest.group ?? 'App'),
      kind: manifest.kind === 'embedded' ? 'embedded' : 'static',
      entry: String(manifest.entry ?? `/apps/${id}/`),
      description: manifest.description ? String(manifest.description) : '',
      dataScopes: Array.isArray(manifest.dataScopes) ? manifest.dataScopes.map(String) : [],
      version: Number(manifest.version ?? 1),
      hasDist: existsSync(join(distDir, 'index.html')),
    })
  }

  // Global slug uniqueness: a slug claimed by more than one folder is a conflict —
  // none of them are listed, and we warn instead of silently shadowing.
  const conflicts = new Set([...seenIds.entries()].filter(([, ds]) => ds.length > 1).map(([id]) => id))
  for (const id of conflicts) {
    warnings.push({ id, dirs: seenIds.get(id), error: 'duplicate slug claimed by multiple folders' })
  }

  const orderMap = new Map(selectAppOrder.all().map((row) => [row.slug, row.sort_index]))
  const active = candidates.filter((app) => !conflicts.has(app.id))
  active.sort((a, b) => {
    const ai = orderMap.has(a.id) ? orderMap.get(a.id) : Number.MAX_SAFE_INTEGER
    const bi = orderMap.has(b.id) ? orderMap.get(b.id) : Number.MAX_SAFE_INTEGER
    if (ai !== bi) return ai - bi
    return a.label.localeCompare(b.label) // new (unordered) apps fall to the end, then alphabetical
  })

  // Cheap change-detection token for client polling — changes only when the
  // listing meaningfully changes (set, order, build status, or warnings).
  const hashSource = JSON.stringify({
    apps: active.map((a) => [a.id, a.label, a.group, a.kind, a.entry, a.hasDist]),
    warnings,
  })
  let hash = 0
  for (let i = 0; i < hashSource.length; i += 1) hash = (hash * 31 + hashSource.charCodeAt(i)) | 0
  return { apps: active, warnings, hash: String(hash) }
}

function setAppOrder(slugs) {
  if (!Array.isArray(slugs)) return { error: 'order must be an array of slugs', status: 400 }
  db.exec('BEGIN')
  try {
    slugs.forEach((slug, index) => {
      if (typeof slug === 'string' && SLUG_RE.test(slug)) upsertAppOrder.run(slug, index, nowIso())
    })
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    return { error: String(error?.message || error), status: 400 }
  }
  return scanApps()
}

// Sets (or clears, when label is empty) a user display-name override for an app.
function setAppLabel(slug, label) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) return { error: 'invalid slug', status: 400 }
  const clean = String(label ?? '').trim().slice(0, 80)
  if (clean) upsertAppLabel.run(slug, clean, nowIso())
  else deleteAppLabel.run(slug)
  return scanApps()
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

// Serves a built Agent App's static files from plugins/<slug>/dist/.
// SPA-friendly: requests without a file extension fall back to index.html.
function serveAppStatic(req, res, urlPath) {
  const rest = urlPath.slice('/apps/'.length)
  const slug = rest.split('/')[0]
  if (!SLUG_RE.test(slug)) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  const distDir = join(PLUGINS_DIR, slug, 'dist')
  let relative = decodeURIComponent(rest.slice(slug.length)) || '/'
  if (relative.endsWith('/')) relative += 'index.html'
  // Resolve and confirm the target stays within the app's dist directory.
  let target = normalize(join(distDir, relative))
  if (target !== distDir && !target.startsWith(distDir + '/')) {
    sendJson(res, 403, { error: 'path outside app' })
    return
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    // SPA fallback for extension-less routes; otherwise a genuine miss.
    if (!extname(relative)) {
      target = join(distDir, 'index.html')
      if (!existsSync(target)) {
        sendJson(res, 404, { error: 'app not built (no dist/index.html)' })
        return
      }
    } else {
      sendJson(res, 404, { error: 'not found' })
      return
    }
  }
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(target)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  })
  createReadStream(target).pipe(res)
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

    // Optional `agent` param runs a TUI coding agent (allowlisted, so the param
    // can't spawn an arbitrary command). With a `session` key the agent runs in
    // a detached-survivable tmux session (persistent background); reconnecting
    // re-attaches it. Without a key it runs directly and dies on disconnect.
    const agentParam = requestUrl.searchParams.get('agent') || ''
    const agentCmd = Object.prototype.hasOwnProperty.call(TUI_AGENTS, agentParam) ? TUI_AGENTS[agentParam] : null
    const sessionKey = (requestUrl.searchParams.get('session') || '').trim()
    const persistent = Boolean(agentCmd && sessionKey)

    let file
    let argv
    if (persistent) {
      // `new-session -A` attaches if the session exists, else creates it running
      // the agent. -x/-y/-c apply only on create; on re-attach tmux redraws.
      const name = tmuxSessionName(`${sessionKey}|${cwd}`, agentParam)
      file = 'tmux'
      argv = ['-L', TMUX_SOCKET, '-f', TMUX_CONF, 'new-session', '-A', '-s', name,
        '-x', String(cols), '-y', String(rows), '-c', cwd, '--', agentCmd]
    } else if (agentCmd) {
      file = agentCmd
      argv = []
    } else {
      file = shell
      argv = ['-l']
    }

    const terminal = pty.spawn(file, argv, {
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

    writeSocket(
      agentCmd
        ? `\r\n\x1b[32m${persistent ? 'Attaching' : 'Starting'} ${agentCmd} in ${cwd}…\x1b[0m\r\n`
        : `\r\n\x1b[32mConnected to Agent Rider terminal\x1b[0m\r\n`,
    )

    const terminalData = terminal.onData((data) => writeSocket(data))
    terminal.onExit(({ exitCode, signal }) => {
      // In persistent mode this fires when the tmux *client* exits — i.e. on
      // detach (socket closed → we killed it) as well as real session end. The
      // tmux session itself lives on the private server until the agent exits.
      writeSocket(`\r\n\x1b[33m${persistent ? 'Detached' : 'Terminal exited'} (code ${exitCode}${signal ? ` signal ${signal}` : ''})\x1b[0m\r\n`)
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

  // Static mount for built Agent Apps — served same-origin so they need no
  // external URL and inherit no frame-blocking headers.
  if (req.method === 'GET' && url.startsWith('/apps/')) {
    serveAppStatic(req, res, url)
    return
  }

  if (req.method === 'GET' && url === '/store/apps') {
    sendJson(res, 200, scanApps())
    return
  }

  if (req.method === 'POST' && url === '/store/apps/order') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 100_000) req.destroy()
    })
    req.on('end', () => {
      try {
        const { order } = JSON.parse(body || '{}')
        const result = setAppOrder(order)
        sendJson(res, result.error ? result.status : 200, result)
      } catch (error) {
        sendJson(res, 400, { error: String(error?.message || error) })
      }
    })
    return
  }

  if (req.method === 'POST' && url === '/store/apps/rename') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 100_000) req.destroy()
    })
    req.on('end', () => {
      try {
        const { slug, label } = JSON.parse(body || '{}')
        const result = setAppLabel(slug, label)
        sendJson(res, result.error ? result.status : 200, result)
      } catch (error) {
        sendJson(res, 400, { error: String(error?.message || error) })
      }
    })
    return
  }

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
