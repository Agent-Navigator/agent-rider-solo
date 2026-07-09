// Local SQLite persistence backend for Agent Rider.
// Stores interaction data (runs + conversation turns) so they survive reloads.
// Uses Node's built-in node:sqlite (Node >= 22.5). No native deps to compile.
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync, createReadStream, accessSync, constants, unlinkSync, renameSync } from 'node:fs'
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
const REQUESTED_HOME_CWD = resolve(process.env.HOME || '/root')

function canReadDirectory(path) {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.R_OK | constants.X_OK)
    return true
  } catch {
    return false
  }
}

function firstReadableDirectory(paths) {
  for (const path of paths) {
    if (path && canReadDirectory(path)) return path
  }
  return null
}

const CONFIGURED_BROWSE_ROOT = resolve(process.env.BROWSE_ROOT || REQUESTED_HOME_CWD)
const BROWSE_ROOT = firstReadableDirectory([CONFIGURED_BROWSE_ROOT, REQUESTED_HOME_CWD, process.cwd()]) || CONFIGURED_BROWSE_ROOT
const DEFAULT_CWD = canReadDirectory(REQUESTED_HOME_CWD) ? REQUESTED_HOME_CWD : BROWSE_ROOT
const APPS_DIR = resolve(
  process.env.AGENT_RIDER_APPS_DIR
  || process.env.AGENT_RIDER_PLUGINS_DIR
  || (process.env.APP_DIR ? join(process.env.APP_DIR, 'shared', 'plugins') : join(BROWSE_ROOT, '.agent-rider', 'apps')),
)
try {
  mkdirSync(APPS_DIR, { recursive: true })
} catch {
  // Best-effort: scanApps() will surface an empty list if the root is unreadable.
}
const AGENT_PATH = [
  join(DEFAULT_CWD, '.local', 'bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  ...(process.env.PATH || '').split(':'),
].filter((part, index, parts) => part && parts.indexOf(part) === index).join(':')

function resolveCommandFile(name) {
  if (name.includes('/')) return name
  for (const dir of AGENT_PATH.split(':')) {
    const candidate = join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return name
}

function shellQuote(args) {
  return args.map((arg) => `'${String(arg).replaceAll("'", "'\\''")}'`).join(' ')
}

// ── Persistent TUI agent sessions (tmux) ─────────────────────────────────────
// TUI agents run inside a tmux session on a private tmux server so they keep
// running in the background after the websocket disconnects (card closed, page
// reloaded, even this store process restarted). Reconnecting just re-attaches
// the same session and tmux redraws the current screen.
const TUI_AGENTS = {
  claude: { label: 'claude', file: resolveCommandFile('claude'), argv: ['--permission-mode', 'auto'] },
  codex: { label: 'codex', file: resolveCommandFile('codex'), argv: ['--yolo'] },
  agy: { label: 'agy', file: resolveCommandFile('agy'), argv: ['--dangerously-skip-permissions'] },
}
const TMUX_SOCKET = 'agent-rider' // private server (`tmux -L agent-rider`)
const TMUX_CONF = join(tmpdir(), 'agent-rider-tmux.conf')
const AGENT_RIDER_BACKGROUND_PATH = join(__dirname, '..', 'agent-rider-background.md')
const APP_PLUGIN_GUIDE_PATH = join(__dirname, '..', 'plugins', 'AGENTS.md')
const AGENT_RIDER_BACKGROUND = (() => {
  try {
    return readFileSync(AGENT_RIDER_BACKGROUND_PATH, 'utf8').trim()
  } catch {
    return ''
  }
})()
const APP_PLUGIN_GUIDE = (() => {
  try {
    return readFileSync(APP_PLUGIN_GUIDE_PATH, 'utf8').trim()
  } catch {
    return ''
  }
})()
try {
  writeFileSync(
    TMUX_CONF,
    [
      'set -g status off', // no status bar — embed cleanly in the card
      'set -g window-size latest', // follow the most recently attached client
      'set -g mouse off',
      'set -g set-clipboard external',
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

function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
}

function tmuxSessionExists(name) {
  const result = spawnSync('tmux', ['-L', TMUX_SOCKET, 'has-session', '-t', name], { stdio: 'ignore' })
  return result.status === 0
}

function agentRiderBackgroundPrompt(agentLabel, { promptContext = 'agent-rider', appWorkspace = '' } = {}) {
  if (!AGENT_RIDER_BACKGROUND) return ''
  const background = promptContext === 'app-builder'
    ? [
      AGENT_RIDER_BACKGROUND,
      APP_PLUGIN_GUIDE ? `Agent Rider App plugin guide:\n${APP_PLUGIN_GUIDE}` : '',
      appWorkspace ? `App workspace: ${appWorkspace}` : '',
    ].filter(Boolean).join('\n\n')
    : AGENT_RIDER_BACKGROUND
  return [
    'Context only:',
    background.replace(/\s+/g, ' ').trim(),
    `Agent Rider connection: ${agentLabel}.`,
    'Say context loaded, then wait.',
  ].join(' ')
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
    model TEXT,
    model_provider TEXT,
    reasoning_effort TEXT,
    agent_type TEXT,
    agent_command TEXT,
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
// Migration: which agent backend drives each conversation (hermes | claude | codex | agy | custom).
try {
  db.exec('ALTER TABLE runs ADD COLUMN agent_type TEXT')
} catch {
  // column already present
}
// Migration: custom TUI agent bash command for Conversation Cards.
try {
  db.exec('ALTER TABLE runs ADD COLUMN agent_command TEXT')
} catch {
  // column already present
}
// Migration: which card column (0|1) a conversation sits in (two-column layout).
try {
  db.exec('ALTER TABLE runs ADD COLUMN col_index INTEGER')
} catch {
  // column already present
}
// Migration: per-card Hermes model/reasoning controls.
try {
  db.exec('ALTER TABLE runs ADD COLUMN model TEXT')
} catch {
  // column already present
}
try {
  db.exec('ALTER TABLE runs ADD COLUMN model_provider TEXT')
} catch {
  // column already present
}
try {
  db.exec('ALTER TABLE runs ADD COLUMN reasoning_effort TEXT')
} catch {
  // column already present
}

// Persisted display order for Agent Apps (existence comes from manifests under
// the local apps dir; this table only records the user's preferred order).
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

// Generic key/value store for UI layout state (e.g. workspace panel order +
// column count) so the arrangement of every component survives a reload.
db.exec(`
  CREATE TABLE IF NOT EXISTS app_kv (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  );
`)
const selectKv = db.prepare('SELECT value FROM app_kv WHERE key = ?')
const upsertKv = db.prepare(`
  INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`)
function getKv(key) {
  const row = selectKv.get(key)
  return row ? row.value : null
}

const upsertRun = db.prepare(`
  INSERT INTO runs (id, session_id, prompt, category, category_tags, project, workspace, workspace_path, task, job, job_status, resource_ids, model, model_provider, reasoning_effort, agent_type, agent_command, col_index, sort_index, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    session_id = excluded.session_id, prompt = excluded.prompt, category = excluded.category,
    category_tags = excluded.category_tags, project = excluded.project, workspace = excluded.workspace,
    workspace_path = excluded.workspace_path, task = excluded.task, job = excluded.job,
    job_status = excluded.job_status, resource_ids = excluded.resource_ids,
    model = excluded.model, model_provider = excluded.model_provider,
    reasoning_effort = excluded.reasoning_effort,
    agent_type = excluded.agent_type, agent_command = excluded.agent_command,
    col_index = excluded.col_index, sort_index = excluded.sort_index,
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
    model: r.model || '',
    modelProvider: r.model_provider || null,
    reasoningEffort: r.reasoning_effort || '',
    sessionId: r.session_id || null,
    agentType: r.agent_type || 'hermes',
    agentCommand: r.agent_command || '',
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

function saveState({ runs = [], turns = [], sessionId = null, layout = undefined }) {
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
        r.model ?? '',
        r.modelProvider ?? null,
        r.reasoningEffort ?? '',
        r.agentType ?? 'hermes',
        r.agentCommand ?? '',
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
    // Persist UI layout (workspace panel order + columns) when provided. Left
    // undefined the existing layout is kept untouched.
    if (layout !== undefined) {
      upsertKv.run('layout', JSON.stringify(layout ?? null), nowIso())
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
  res.end(body)
}

// ── Page password gate ─────────────────────────────────────────────────────

const PASSWORD_KV_KEY = 'page_password'
const PASSWORD_SECRET_KV_KEY = 'page_password_session_secret'
const PASSWORD_COOKIE = 'agent_rider_auth'
const PASSWORD_MIN_LENGTH = 4
const PASSWORD_ITERATIONS = 210_000
const PASSWORD_KEYLEN = 32
const PASSWORD_DIGEST = 'sha256'
const PASSWORD_SESSION_MS = 30 * 24 * 60 * 60 * 1000

function safeEqualText(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  return left.length === right.length && timingSafeEqual(left, right)
}

function passwordRecord() {
  const record = parseJson(getKv(PASSWORD_KV_KEY), null)
  if (!record || typeof record !== 'object') return null
  if (!record.salt || !record.hash || !record.version) return null
  return record
}

function hashPassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  return pbkdf2Sync(String(password), String(salt), iterations, PASSWORD_KEYLEN, PASSWORD_DIGEST).toString('base64url')
}

function verifyPassword(password, record = passwordRecord()) {
  if (!record || typeof password !== 'string') return false
  const hash = hashPassword(password, record.salt, Number(record.iterations) || PASSWORD_ITERATIONS)
  return safeEqualText(hash, record.hash)
}

function setPasswordRecord(password) {
  const salt = randomBytes(16).toString('base64url')
  const record = {
    salt,
    hash: hashPassword(password, salt),
    iterations: PASSWORD_ITERATIONS,
    digest: PASSWORD_DIGEST,
    version: randomBytes(12).toString('base64url'),
    updatedAt: nowIso(),
  }
  upsertKv.run(PASSWORD_KV_KEY, JSON.stringify(record), nowIso())
  return record
}

function sessionSecret() {
  const existing = getKv(PASSWORD_SECRET_KV_KEY)
  if (existing) return existing
  const secret = randomBytes(32).toString('base64url')
  upsertKv.run(PASSWORD_SECRET_KV_KEY, secret, nowIso())
  return secret
}

function signAuthToken(version, expiresAt) {
  return createHmac('sha256', sessionSecret()).update(`${version}.${expiresAt}`).digest('base64url')
}

function authCookieValue(record) {
  const expiresAt = Date.now() + PASSWORD_SESSION_MS
  return `${record.version}.${expiresAt}.${signAuthToken(record.version, expiresAt)}`
}

function authCookieHeader(record) {
  return `${PASSWORD_COOKIE}=${authCookieValue(record)}; Path=/; Max-Age=${Math.floor(PASSWORD_SESSION_MS / 1000)}; HttpOnly; SameSite=Strict`
}

function clearAuthCookieHeader() {
  return `${PASSWORD_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`
}

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        if (index === -1) return [part, '']
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]
      }),
  )
}

function isAuthorized(req) {
  const record = passwordRecord()
  if (!record) return true
  const token = cookies(req)[PASSWORD_COOKIE]
  if (!token) return false
  const [version, expiresAtRaw, signature] = token.split('.')
  const expiresAt = Number(expiresAtRaw)
  if (!version || !signature || version !== record.version || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return false
  return safeEqualText(signature, signAuthToken(version, expiresAt))
}

function readJsonBody(req, limit, onDone) {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
    if (body.length > limit) req.destroy()
  })
  req.on('end', () => {
    try {
      onDone(JSON.parse(body || '{}'))
    } catch (error) {
      onDone(null, error)
    }
  })
}

function handlePasswordRoute(req, res, url) {
  if (req.method === 'GET' && url === '/store/password/status') {
    const enabled = Boolean(passwordRecord())
    sendJson(res, 200, { enabled, authenticated: !enabled || isAuthorized(req), version: passwordRecord()?.version || null })
    return true
  }

  if (req.method === 'POST' && url === '/store/password/login') {
    readJsonBody(req, 20_000, (body, error) => {
      if (error) return sendJson(res, 400, { error: String(error?.message || error) })
      const record = passwordRecord()
      if (!record) return sendJson(res, 200, { ok: true, enabled: false, authenticated: true })
      if (!verifyPassword(body?.password, record)) return sendJson(res, 401, { error: 'Invalid password' })
      sendJson(res, 200, { ok: true, enabled: true, authenticated: true, version: record.version }, { 'Set-Cookie': authCookieHeader(record) })
    })
    return true
  }

  if (req.method === 'POST' && url === '/store/password/set') {
    readJsonBody(req, 20_000, (body, error) => {
      if (error) return sendJson(res, 400, { error: String(error?.message || error) })
      const nextPassword = String(body?.nextPassword || '')
      if (nextPassword.length < PASSWORD_MIN_LENGTH) return sendJson(res, 400, { error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` })
      const current = passwordRecord()
      if (current && !verifyPassword(body?.currentPassword, current)) return sendJson(res, 401, { error: 'Current password is incorrect' })
      const next = setPasswordRecord(nextPassword)
      sendJson(res, 200, { ok: true, enabled: true, authenticated: true, version: next.version }, { 'Set-Cookie': authCookieHeader(next) })
    })
    return true
  }

  if (req.method === 'POST' && url === '/store/password/logout') {
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearAuthCookieHeader() })
    return true
  }

  return false
}

// ── Workspace filesystem browsing ──────────────────────────────────────────
// Browsing is sandboxed to BROWSE_ROOT to avoid exposing the whole filesystem.

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

const SEARCH_MAX_RESULTS = 200
const SEARCH_MAX_DEPTH = 12

function searchFiles(input, queryText) {
  const path = safeResolve(input)
  if (!path) return { error: 'path outside allowed root', status: 403 }
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { error: 'path not found', status: 404 }
  }
  if (!stat.isDirectory()) return { error: 'not a directory', status: 400 }

  const needle = String(queryText || '').trim().toLowerCase()
  if (!needle) return { root: BROWSE_ROOT, path, query: '', results: [], truncated: false }

  const results = []

  function walk(dirPath, depth) {
    if (results.length >= SEARCH_MAX_RESULTS || depth > SEARCH_MAX_DEPTH) return
    let entries
    try {
      entries = readdirSync(dirPath, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'))
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= SEARCH_MAX_RESULTS) return
      const entryPath = join(dirPath, entry.name)
      const isDir = entry.isDirectory()
      if (entry.name.toLowerCase().includes(needle)) {
        if (isDir) {
          results.push({ name: entry.name, path: entryPath, type: 'dir' })
        } else if (entry.isFile()) {
          let size = null
          try {
            size = statSync(entryPath).size
          } catch {
            // Unreadable file (e.g. broken symlink) — report it without a size.
          }
          results.push({ name: entry.name, path: entryPath, type: 'file', size })
        }
      }
      if (isDir) walk(entryPath, depth + 1)
    }
  }

  walk(path, 0)
  results.sort((a, b) => a.name.localeCompare(b.name))
  return { root: BROWSE_ROOT, path, query: needle, results, truncated: results.length >= SEARCH_MAX_RESULTS }
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

function moveDirectory(sourceInput, targetInput) {
  const source = safeResolve(sourceInput)
  const target = safeResolve(targetInput)
  if (!source || !target) return { error: 'path outside allowed root', status: 403 }
  if (source === BROWSE_ROOT) return { error: 'cannot move browse root', status: 400 }
  if (source === target) return { path: target, moved: false }
  if (target.startsWith(source + '/')) return { error: 'cannot move a folder inside itself', status: 400 }

  try {
    const sourceStat = statSync(source)
    if (!sourceStat.isDirectory()) return { error: 'source is not a directory', status: 400 }
  } catch {
    return { error: 'source folder not found', status: 404 }
  }

  if (existsSync(target)) return { error: 'target folder already exists', status: 409, conflict: true, source, target }

  try {
    mkdirSync(dirname(target), { recursive: true })
    renameSync(source, target)
  } catch (error) {
    return { error: String(error?.message || error), status: 400 }
  }
  return { path: target, moved: true }
}

const FILE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024
const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown'])
const HTML_EXTS = new Set(['.html', '.htm'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])
const TEXT_EXTS = new Set(['.txt', '.text', '.log', '.csv', '.tsv', '.ini', '.conf', '.config', '.env', '.example'])
const CODE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.css', '.scss', '.sass', '.less',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.xml',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.cs',
  '.php', '.sh', '.bash', '.zsh', '.fish', '.sql',
  '.vue', '.svelte', '.astro',
])
const CODE_FILENAMES = new Set([
  'Dockerfile', 'Containerfile', 'Makefile', 'Rakefile', 'Gemfile',
  'package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js',
])

function previewKind(filePath) {
  const ext = extname(filePath).toLowerCase()
  const name = basename(filePath)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (HTML_EXTS.has(ext)) return 'html'
  if (MARKDOWN_EXTS.has(ext)) return 'markdown'
  if (CODE_EXTS.has(ext) || CODE_FILENAMES.has(name)) return 'code'
  if (TEXT_EXTS.has(ext) || ext === '') return 'text'
  return null
}

function readFilePreview(input) {
  const path = safeResolve(input)
  if (!path) return { error: 'path outside allowed root', status: 403 }
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { error: 'file not found', status: 404 }
  }
  if (!stat.isFile()) return { error: 'not a file', status: 400 }

  const kind = previewKind(path)
  if (!kind) return { error: 'unsupported file type', status: 415 }
  if (kind !== 'html' && stat.size > FILE_PREVIEW_MAX_BYTES) return { error: 'file too large to preview', status: 413 }

  const ext = extname(path).toLowerCase()
  const mime = MIME_TYPES[ext] || (kind === 'image' ? 'application/octet-stream' : 'text/plain; charset=utf-8')
  const base = { name: basename(path), path, size: stat.size, kind, mime }
  if (kind === 'html') {
    return { ...base, viewUrl: workspaceFileViewUrl(path) }
  }
  const buffer = readFileSync(path)
  if (kind === 'image') {
    return { ...base, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
  }
  return { ...base, content: buffer.toString('utf8') }
}

function workspaceFileViewUrl(path) {
  const relativePath = path === BROWSE_ROOT ? '' : path.slice(BROWSE_ROOT.length + 1)
  const encoded = relativePath.split('/').map((part) => encodeURIComponent(part)).join('/')
  return `/store/fs/view/${encoded}`
}

// Serve a workspace file inline so HTML previews behave like a real browser page:
// scripts can run, and relative JS/CSS/image/font dependencies resolve next to
// the opened HTML file instead of relative to the Agent Rider app shell.
function serveWorkspaceFileInline(req, res, urlPath) {
  const prefix = '/store/fs/view/'
  let relativePath
  try {
    relativePath = decodeURIComponent(urlPath.slice(prefix.length))
  } catch {
    sendJson(res, 400, { error: 'invalid file path' })
    return
  }
  let target = safeResolve(join(BROWSE_ROOT, relativePath))
  if (!target) {
    sendJson(res, 403, { error: 'path outside allowed root' })
    return
  }
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html')
  let stat
  try {
    stat = statSync(target)
  } catch {
    sendJson(res, 404, { error: 'file not found' })
    return
  }
  if (!stat.isFile()) {
    sendJson(res, 400, { error: 'not a file' })
    return
  }
  const mime = MIME_TYPES[extname(target).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  createReadStream(target).pipe(res)
}

// Resolve a file inside the sandbox for downloading as an attachment.
function resolveFileForDownload(input) {
  const path = safeResolve(input)
  if (!path) return { error: 'path outside allowed root', status: 403 }
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { error: 'file not found', status: 404 }
  }
  if (!stat.isFile()) return { error: 'not a file', status: 400 }
  const ext = extname(path).toLowerCase()
  return { path, name: basename(path), size: stat.size, mime: MIME_TYPES[ext] || 'application/octet-stream' }
}

// Delete a single file within the sandbox. Directories are refused to avoid
// accidental recursive removal from a read-first browser.
function deleteFile(input) {
  const path = safeResolve(input)
  if (!path) return { error: 'path outside allowed root', status: 403 }
  if (path === BROWSE_ROOT) return { error: 'cannot delete the workspace root', status: 400 }
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { error: 'file not found', status: 404 }
  }
  if (!stat.isFile()) return { error: 'only files can be deleted', status: 400 }
  try {
    unlinkSync(path)
  } catch (error) {
    return { error: String(error?.message || error), status: 400 }
  }
  return { path, deleted: true }
}

// ── Local Agent Apps ─────────────────────────────────────────────────────────
// Apps are runtime data, not Agent Rider source code. They live under
// AGENT_RIDER_APPS_DIR/<slug>/ (default: BROWSE_ROOT/.agent-rider/apps), build to
// <slug>/dist/, and are served same-origin at /apps/<slug>/.
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

function readManifest(dir) {
  const manifestPath = join(APPS_DIR, dir, 'manifest.json')
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
    dirs = readdirSync(APPS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return { apps: [], warnings: [], hash: '0', appsRoot: APPS_DIR }
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
    if (id !== dir) {
      warnings.push({ dir, id, error: 'manifest id must match folder name' })
      continue
    }
    seenIds.set(id, [...(seenIds.get(id) ?? []), dir])
    const distDir = join(APPS_DIR, dir, 'dist')
    candidates.push({
      id,
      dir,
      workspacePath: join(APPS_DIR, dir),
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
  return { apps: active, warnings, hash: String(hash), appsRoot: APPS_DIR }
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
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
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
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
}

// Serves a built Agent App's static files from AGENT_RIDER_APPS_DIR/<slug>/dist/.
// SPA-friendly: requests without a file extension fall back to index.html.
function serveAppStatic(req, res, urlPath) {
  const rest = urlPath.slice('/apps/'.length)
  const slug = rest.split('/')[0]
  if (!SLUG_RE.test(slug)) {
    sendJson(res, 404, { error: 'not found' })
    return
  }
  const distDir = join(APPS_DIR, slug, 'dist')
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
    if (!isAuthorized(req)) {
      socket.close(1008, 'locked')
      return
    }

    const requestUrl = new URL(req.url || '/store/terminal/ws', 'http://localhost')
    const cwd = safeResolve(requestUrl.searchParams.get('cwd') || DEFAULT_CWD) || DEFAULT_CWD
    const { cols, rows } = parseTerminalSize(requestUrl.searchParams)
    const shell = process.env.SHELL || '/bin/bash'

    // Optional `agent` param runs a TUI coding agent. Built-ins are allowlisted;
    // agent=custom accepts a user-entered bash command from an authenticated UI.
    // With a `session` key the terminal runs in a detached-survivable tmux
    // session (persistent background); reconnecting re-attaches it. Without a
    // key it runs directly and dies on disconnect. A `reset=1` attach kills the
    // existing tmux session first, giving the UI's Reset button explicit restart
    // semantics without making normal close/reopen or resize destructive.
    const agentParam = requestUrl.searchParams.get('agent') || ''
    const agentCmd = Object.prototype.hasOwnProperty.call(TUI_AGENTS, agentParam) ? TUI_AGENTS[agentParam] : null
    const customCommand = agentParam === 'custom' ? (requestUrl.searchParams.get('command') || '').trim() : ''
    const promptContext = requestUrl.searchParams.get('prompt_context') === 'app-builder' ? 'app-builder' : 'agent-rider'
    const appWorkspace = promptContext === 'app-builder'
      ? safeResolve(requestUrl.searchParams.get('app_workspace') || cwd) || cwd
      : ''
    const resetSession = requestUrl.searchParams.get('reset') === '1'
    const customCommandTooLong = customCommand.length > 2000
    if (agentParam === 'custom' && (!customCommand || customCommandTooLong)) {
      socket.send(customCommandTooLong
        ? '\r\n\x1b[31mCustom agent command is too long.\x1b[0m\r\n'
        : '\r\n\x1b[31mCustom agent command is empty.\x1b[0m\r\n')
      socket.close(1008, 'invalid custom agent command')
      return
    }
    const agentLabel = agentCmd ? [agentCmd.label, ...agentCmd.argv].join(' ') : customCommand
    const hasAgentCommand = Boolean(agentCmd || customCommand)
    const launchLabel = hasAgentCommand ? agentLabel : 'Local Terminal'
    const agentShellCommand = agentCmd ? shellQuote([agentCmd.file, ...agentCmd.argv]) : customCommand
    const launchCommand = hasAgentCommand ? agentShellCommand : shellQuote([shell, '-l'])
    const sessionKey = (requestUrl.searchParams.get('session') || '').trim()
    const persistent = Boolean(sessionKey)

    let file
    let argv
    let shouldInjectAgentRiderBackground = Boolean(agentCmd && !persistent)
    if (persistent) {
      // `new-session -A` attaches if the session exists, else creates it running
      // the agent. -x/-y/-c apply only on create; on re-attach tmux redraws.
      const sessionKind = hasAgentCommand ? agentParam : 'shell'
      const nameKey = agentParam === 'custom'
        ? `${sessionKey}|${cwd}|${shortHash(launchCommand)}`
        : `${sessionKey}|${cwd}`
      const name = tmuxSessionName(nameKey, sessionKind)
      if (resetSession && tmuxSessionExists(name)) {
        spawnSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', name], { stdio: 'ignore' })
      }
      shouldInjectAgentRiderBackground = Boolean(agentCmd && !tmuxSessionExists(name))
      file = 'tmux'
      argv = ['-L', TMUX_SOCKET, '-f', TMUX_CONF, 'new-session', '-A', '-s', name,
        '-x', String(cols), '-y', String(rows), '-c', cwd, '-e', `PATH=${AGENT_PATH}`, '--', launchCommand]
    } else if (agentCmd) {
      file = agentCmd.file
      argv = agentCmd.argv
    } else if (customCommand) {
      file = shell
      argv = ['-lc', customCommand]
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
        PATH: AGENT_PATH,
        TERM: 'xterm-256color',
        COLORTERM: process.env.COLORTERM || 'truecolor',
      },
    })

    const writeSocket = (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
    }

    writeSocket(
      hasAgentCommand || persistent
        ? `\r\n\x1b[32m${persistent ? (resetSession ? 'Resetting' : 'Attaching') : 'Starting'} ${launchLabel} in ${cwd}…\x1b[0m\r\n`
        : `\r\n\x1b[32mConnected to Agent Rider terminal\x1b[0m\r\n`,
    )

    const terminalData = terminal.onData((data) => writeSocket(data))
    if (shouldInjectAgentRiderBackground) {
      const backgroundPrompt = agentRiderBackgroundPrompt(agentLabel, { promptContext, appWorkspace })
      if (backgroundPrompt) {
        setTimeout(() => {
          try {
            terminal.write(`${backgroundPrompt}\r`)
          } catch {
            // The websocket/PTY may have closed before the delayed injection.
          }
        }, 2000)
      }
    }
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

  if (handlePasswordRoute(req, res, url)) return

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: 'locked' })
    return
  }

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
    const layout = parseJson(getKv('layout'), null)
    sendJson(res, 200, { runs, turns, layout })
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

  if (req.method === 'GET' && url === '/store/fs/read') {
    const query = new URL(req.url, 'http://localhost').searchParams
    const result = readFilePreview(query.get('path') || '')
    sendJson(res, result.error ? result.status : 200, result)
    return
  }

  if (req.method === 'GET' && url === '/store/fs/search') {
    const query = new URL(req.url, 'http://localhost').searchParams
    const result = searchFiles(query.get('path') || '', query.get('query') || '')
    sendJson(res, result.error ? result.status : 200, result)
    return
  }

  if (req.method === 'GET' && url.startsWith('/store/fs/view/')) {
    serveWorkspaceFileInline(req, res, url)
    return
  }

  if (req.method === 'GET' && url === '/store/fs/download') {
    const query = new URL(req.url, 'http://localhost').searchParams
    const result = resolveFileForDownload(query.get('path') || '')
    if (result.error) {
      sendJson(res, result.status, result)
      return
    }
    res.writeHead(200, {
      'Content-Type': result.mime,
      'Content-Length': result.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`,
      'Cache-Control': 'no-store',
    })
    createReadStream(result.path).pipe(res)
    return
  }

  if (req.method === 'POST' && url === '/store/fs/delete') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 100_000) req.destroy()
    })
    req.on('end', () => {
      try {
        const { path } = JSON.parse(body || '{}')
        const result = deleteFile(path)
        sendJson(res, result.error ? result.status : 200, result)
      } catch (error) {
        sendJson(res, 400, { error: String(error?.message || error) })
      }
    })
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

  if (req.method === 'POST' && url === '/store/fs/move-dir') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 100_000) req.destroy()
    })
    req.on('end', () => {
      try {
        const { source, target } = JSON.parse(body || '{}')
        const result = moveDirectory(source, target)
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
  if (BROWSE_ROOT !== CONFIGURED_BROWSE_ROOT) {
    console.warn(`[store] BROWSE_ROOT ${CONFIGURED_BROWSE_ROOT} is not readable; using ${BROWSE_ROOT}`)
  }
  console.log(`[store] Agent Rider SQLite backend on http://127.0.0.1:${PORT} → ${DB_PATH}`)
})
