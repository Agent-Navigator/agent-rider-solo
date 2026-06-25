// Local SQLite persistence backend for Agent Rider.
// Stores interaction data (runs + conversation turns) so they survive reloads.
// Uses Node's built-in node:sqlite (Node >= 22.5). No native deps to compile.
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_DIR = join(__dirname, '..', 'data')
mkdirSync(DB_DIR, { recursive: true })
const DB_PATH = join(DB_DIR, 'agent-rider.db')
const PORT = Number(process.env.STORE_PORT || 5174)

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
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    session_id TEXT,
    prompt TEXT,
    response TEXT,
    status TEXT,
    created_at TEXT,
    updated_at TEXT
  );
`)

const upsertRun = db.prepare(`
  INSERT INTO runs (id, session_id, prompt, category, category_tags, project, workspace, workspace_path, task, job, job_status, resource_ids, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    session_id = excluded.session_id, prompt = excluded.prompt, category = excluded.category,
    category_tags = excluded.category_tags, project = excluded.project, workspace = excluded.workspace,
    workspace_path = excluded.workspace_path, task = excluded.task, job = excluded.job,
    job_status = excluded.job_status, resource_ids = excluded.resource_ids,
    created_at = excluded.created_at, updated_at = excluded.updated_at
`)
const upsertTurn = db.prepare(`
  INSERT INTO turns (id, run_id, session_id, prompt, response, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    run_id = excluded.run_id, session_id = excluded.session_id, prompt = excluded.prompt,
    response = excluded.response, status = excluded.status,
    created_at = excluded.created_at, updated_at = excluded.updated_at
`)
const selectRuns = db.prepare('SELECT * FROM runs ORDER BY created_at ASC, rowid ASC')
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
    createdAt: r.created_at,
  }
}
function turnRowToApi(t) {
  return {
    id: t.id,
    runId: t.run_id,
    prompt: t.prompt,
    response: t.response,
    status: t.status,
    createdAt: t.created_at,
  }
}

function saveState({ runs = [], turns = [], sessionId = null }) {
  db.exec('BEGIN')
  try {
    for (const r of runs) {
      if (!r || !r.id) continue
      upsertRun.run(
        String(r.id),
        sessionId,
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
        r.createdAt ?? nowIso(),
        nowIso(),
      )
    }
    for (const t of turns) {
      if (!t || !t.id) continue
      upsertTurn.run(
        String(t.id),
        t.runId ?? '',
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

  sendJson(res, 404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[store] Agent Rider SQLite backend on http://127.0.0.1:${PORT} → ${DB_PATH}`)
})
