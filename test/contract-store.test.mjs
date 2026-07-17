import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { chmod, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))

let sandbox
let baseUrl
let store
let cookie = ''

const backend = process.env.AGENT_RIDER_CONTRACT_BACKEND || 'rust'

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForStore() {
  let lastError
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/store/state`)
      if (response.ok) return
      lastError = new Error(`store returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await sleep(25)
  }
  throw lastError ?? new Error('store did not start')
}

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options)
}

async function json(path, options = {}) {
  const response = await request(path, options)
  return { response, body: await response.json() }
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'agent-rider-contract-'))
  const workspace = join(sandbox, 'workspace')
  const apps = join(sandbox, 'apps')
  const appDist = join(apps, 'sample-app', 'dist')
  const bin = join(workspace, '.local', 'bin')
  await mkdir(join(workspace, 'notes'), { recursive: true })
  await mkdir(appDist, { recursive: true })
  await mkdir(bin, { recursive: true })
  await writeFile(join(workspace, 'README.md'), '# Fixture\n')
  await writeFile(join(workspace, 'notes', 'todo.txt'), 'ship rust backend\n')
  await writeFile(join(apps, 'sample-app', 'manifest.json'), JSON.stringify({
    id: 'sample-app',
    label: 'Sample App',
    group: 'Fixtures',
    kind: 'static',
    entry: '/apps/sample-app/',
    version: 1,
  }))
  await writeFile(join(appDist, 'index.html'), '<!doctype html><title>Sample App</title>')

  const fakeHermes = join(bin, 'hermes')
  await writeFile(fakeHermes, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'test', 'fixtures', 'fake-hermes-acp.mjs'))} "$@"\n`)
  await chmod(fakeHermes, 0o755)
  for (const agent of ['codex', 'claude', 'agy', 'devin']) {
    const executable = join(bin, agent)
    await writeFile(executable, '#!/bin/sh\nprintf fixture-agent\\n\n')
    await chmod(executable, 0o755)
  }

  if (backend === 'node') {
    await cp(join(ROOT, 'server'), join(sandbox, 'server'), { recursive: true })
    await symlink(join(ROOT, 'node_modules'), join(sandbox, 'node_modules'), 'dir')
  }

  const port = await allocatePort()
  baseUrl = `http://127.0.0.1:${port}`
  const command = backend === 'rust'
    ? [join(ROOT, 'target', 'debug', 'agent-rider-store'), []]
    : [process.execPath, ['server/store.mjs']]
  store = spawn(command[0], command[1], {
    cwd: sandbox,
    env: {
      ...process.env,
      HOME: workspace,
      BROWSE_ROOT: workspace,
      AGENT_RIDER_APPS_DIR: apps,
      APP_DIR: sandbox,
      HERMES_TARGET: fakeHermes,
      STORE_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  store.stderr.on('data', (chunk) => { stderr += chunk })
  store.once('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      process.stderr.write(`fixture store exited early (code ${code}, signal ${signal}): ${stderr}\n`)
    }
  })

  await waitForStore()
})

after(async () => {
  if (store && !store.killed) {
    store.kill('SIGTERM')
    await new Promise((resolve) => store.once('exit', resolve))
  }
  if (sandbox) await rm(sandbox, { recursive: true, force: true })
})

test('state API persists full state and reconciles deleted rows', async () => {
  const initial = await json('/store/state')
  assert.equal(initial.response.status, 200)
  assert.deepEqual(initial.body, { runs: [], turns: [], layout: null })

  const createdAt = '2026-07-14T00:00:00.000Z'
  const payload = {
    sessionId: 'session-fixture',
    layout: { layoutPreset: 'two-up', sidebarCollapsed: true },
    runs: [{
      id: 'run-1',
      prompt: 'Port the store',
      category: 'Engineering',
      categoryTags: ['rust'],
      project: 'Agent Rider',
      workspace: 'fixture',
      workspacePath: '/workspace',
      task: 'state migration',
      job: 'backend rewrite',
      jobStatus: 'running',
      resourceIds: ['resource-1'],
      model: 'model-1',
      modelProvider: 'provider-1',
      reasoningEffort: 'high',
      agentType: 'codex',
      agentCommand: '',
      column: 1,
      createdAt,
    }],
    turns: [{
      id: 'turn-1',
      runId: 'run-1',
      parentTurnId: null,
      prompt: 'Port the store',
      response: 'Working',
      status: 'running',
      createdAt,
    }],
  }
  const saved = await json('/store/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  assert.equal(saved.response.status, 200)
  assert.deepEqual(saved.body, { ok: true })

  const persisted = await json('/store/state')
  assert.equal(persisted.response.status, 200)
  assert.deepEqual(persisted.body, {
    layout: payload.layout,
    runs: [{
      id: 'run-1',
      prompt: 'Port the store',
      category: 'Engineering',
      categoryTags: ['rust'],
      project: 'Agent Rider',
      workspace: 'fixture',
      workspacePath: '/workspace',
      task: 'state migration',
      job: 'backend rewrite',
      jobStatus: 'running',
      resourceIds: ['resource-1'],
      model: 'model-1',
      modelProvider: 'provider-1',
      reasoningEffort: 'high',
      sessionId: 'session-fixture',
      agentType: 'codex',
      agentCommand: '',
      column: 1,
      createdAt,
    }],
    turns: [{
      id: 'turn-1',
      runId: 'run-1',
      parentTurnId: null,
      prompt: 'Port the store',
      response: 'Working',
      status: 'running',
      createdAt,
    }],
  })

  // Databases from before agent_type was introduced contain NULL here. Those
  // rows were Hermes conversations and must not silently become Codex on an
  // upgrade, or the UI would hide their saved transcript behind a new TUI.
  const legacyDb = new DatabaseSync(join(sandbox, 'data', 'agent-rider.db'))
  legacyDb.prepare('UPDATE runs SET agent_type = NULL WHERE id = ?').run('run-1')
  legacyDb.close()
  const legacy = await json('/store/state')
  assert.equal(legacy.body.runs[0].agentType, 'hermes')

  const cleared = await json('/store/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runs: [], turns: [] }),
  })
  assert.equal(cleared.response.status, 200)
  assert.deepEqual(cleared.body, { ok: true })

  const afterDeletion = await json('/store/state')
  assert.deepEqual(afterDeletion.body, { runs: [], turns: [], layout: payload.layout })
})

test('terminal WebSocket accepts input and streams PTY output', async () => {
  const wsUrl = baseUrl.replace('http://', 'ws://') + `/store/terminal/ws?cwd=${encodeURIComponent(join(sandbox, 'workspace'))}&cols=80&rows=24`
  const socket = new WebSocket(wsUrl)
  socket.binaryType = 'arraybuffer'
  let output = ''
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`terminal output timed out: ${output}`)), 5000)
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'input', data: 'printf websocket-ok\\n\n' })))
    socket.addEventListener('message', (event) => {
      output += typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString()
      if (output.includes('websocket-ok')) {
        clearTimeout(timer)
        resolve()
      }
    })
    socket.addEventListener('error', reject)
  })
  socket.close()
  assert.match(output, /websocket-ok/)
})

test('password gate protects store routes and issues a reusable session cookie', async () => {
  const configured = await json('/store/password/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: '', nextPassword: 'fixture-password' }),
  })
  assert.equal(configured.response.status, 200)
  assert.equal(configured.body.enabled, true)
  assert.equal(configured.body.authenticated, true)
  cookie = configured.response.headers.get('set-cookie').split(';', 1)[0]
  assert.match(cookie, /^agent_rider_auth=/)

  const locked = await json('/store/state')
  assert.equal(locked.response.status, 401)
  assert.deepEqual(locked.body, { error: 'locked' })

  const rejected = await json('/store/password/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  })
  assert.equal(rejected.response.status, 401)
  assert.deepEqual(rejected.body, { error: 'Invalid password' })

  const login = await json('/store/password/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'fixture-password' }),
  })
  assert.equal(login.response.status, 200)
  const loginCookie = login.response.headers.get('set-cookie').split(';', 1)[0]

  const unlocked = await json('/store/state', { headers: { Cookie: loginCookie } })
  assert.equal(unlocked.response.status, 200)

  const logout = await json('/store/password/logout', {
    method: 'POST',
    headers: { Cookie: cookie },
  })
  assert.equal(logout.response.status, 200)
  assert.deepEqual(logout.body, { ok: true })
})

test('filesystem and Agent App routes keep their current contract', async () => {
  const listing = await json('/store/fs/list?path=', { headers: { Cookie: cookie } })
  assert.equal(listing.response.status, 200)
  assert.deepEqual(listing.body.dirs, [{ name: 'notes', path: join(sandbox, 'workspace', 'notes') }])
  assert.deepEqual(listing.body.files, [{ name: 'README.md', path: join(sandbox, 'workspace', 'README.md'), size: 10 }])

  const preview = await json(`/store/fs/read?path=${encodeURIComponent(join(sandbox, 'workspace', 'README.md'))}`, { headers: { Cookie: cookie } })
  assert.equal(preview.response.status, 200)
  assert.deepEqual(preview.body, {
    name: 'README.md',
    path: join(sandbox, 'workspace', 'README.md'),
    size: 10,
    kind: 'markdown',
    mime: 'text/plain; charset=utf-8',
    content: '# Fixture\n',
  })

  const outside = await json(`/store/fs/list?path=${encodeURIComponent(tmpdir())}`, { headers: { Cookie: cookie } })
  assert.equal(outside.response.status, 403)
  assert.deepEqual(outside.body, { error: 'path outside allowed root', status: 403 })

  const apps = await json('/store/apps', { headers: { Cookie: cookie } })
  assert.equal(apps.response.status, 200)
  assert.equal(apps.body.apps.length, 1)
  assert.deepEqual(apps.body.apps[0], {
    id: 'sample-app',
    dir: 'sample-app',
    workspacePath: join(sandbox, 'apps', 'sample-app'),
    label: 'Sample App',
    group: 'Fixtures',
    kind: 'static',
    entry: '/apps/sample-app/',
    description: '',
    dataScopes: [],
    version: 1,
    hasDist: true,
  })

  const app = await request('/apps/sample-app/', { headers: { Cookie: cookie } })
  assert.equal(app.status, 200)
  assert.equal(await app.text(), '<!doctype html><title>Sample App</title>')
})

test('filesystem mutations and app metadata writes preserve response contracts', async () => {
  const created = await json('/store/fs/mkdir', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ parent: join(sandbox, 'workspace'), name: 'uploads' }),
  })
  assert.equal(created.response.status, 200)
  assert.deepEqual(created.body, { path: join(sandbox, 'workspace', 'uploads'), name: 'uploads' })

  const uploaded = await json(`/store/fs/upload?path=${encodeURIComponent(join(sandbox, 'workspace', 'uploads'))}&name=fixture.txt`, {
    method: 'POST', headers: { Cookie: cookie }, body: 'uploaded bytes',
  })
  assert.equal(uploaded.response.status, 200)
  assert.equal(await readFile(join(sandbox, 'workspace', 'uploads', 'fixture.txt'), 'utf8'), 'uploaded bytes')

  const downloaded = await request(`/store/fs/download?path=${encodeURIComponent(join(sandbox, 'workspace', 'uploads', 'fixture.txt'))}`, { headers: { Cookie: cookie } })
  assert.equal(downloaded.status, 200)
  assert.match(downloaded.headers.get('content-disposition'), /fixture\.txt/)
  assert.equal(await downloaded.text(), 'uploaded bytes')

  const moved = await json('/store/fs/move-dir', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ source: join(sandbox, 'workspace', 'uploads'), target: join(sandbox, 'workspace', 'archive') }),
  })
  assert.equal(moved.response.status, 200)
  assert.equal(moved.body.moved, true)

  const deleted = await json('/store/fs/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ path: join(sandbox, 'workspace', 'archive', 'fixture.txt') }),
  })
  assert.deepEqual(deleted.body, { path: join(sandbox, 'workspace', 'archive', 'fixture.txt'), deleted: true })

  const renamed = await json('/store/apps/rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ slug: 'sample-app', label: 'Renamed Fixture' }),
  })
  assert.equal(renamed.body.apps[0].label, 'Renamed Fixture')
  const ordered = await json('/store/apps/order', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ order: ['sample-app'] }),
  })
  assert.equal(ordered.response.status, 200)
  assert.equal(ordered.body.apps[0].id, 'sample-app')
})

test('agent availability and terminal HTTP contracts are stable', async () => {
  const agents = await json('/store/agents', { headers: { Cookie: cookie } })
  assert.equal(agents.response.status, 200)
  assert.deepEqual(agents.body.agents, { hermes: true, claude: true, codex: true, agy: true, devin: true })

  const terminal = await json('/store/terminal/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ command: 'printf contract && cd notes', cwd: join(sandbox, 'workspace') }),
  })
  assert.equal(terminal.response.status, 200)
  assert.equal(terminal.body.output, 'contract')
  assert.equal(terminal.body.exitCode, 0)
  assert.equal(terminal.body.nextCwd, join(sandbox, 'workspace', 'notes'))
  assert.equal(terminal.body.timedOut, false)

  const usage = await json('/store/terminal/usage', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ agent: 'codex', session: 'missing', cwd: join(sandbox, 'workspace') }),
  })
  assert.deepEqual(usage.body, { available: false, reason: 'no-session' })
})

test('Hermes ACP REST, SSE replay, exclusivity, cancel, and recovery contracts', async () => {
  const sessionResponse = await json('/api/session/new', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ workspace: join(sandbox, 'workspace') }),
  })
  assert.equal(sessionResponse.response.status, 200)
  const sessionId = sessionResponse.body.session.session_id
  assert.equal(sessionResponse.body.session.model, 'hermes-test')

  const models = await json('/api/models', { headers: { Cookie: cookie } })
  assert.equal(models.body.default_model, 'hermes-test')
  assert.equal(models.body.active_provider, 'fixture')

  const started = await json('/api/chat/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ session_id: sessionId, message: 'contract', workspace: join(sandbox, 'workspace') }),
  })
  assert.equal(started.response.status, 200)
  const streamId = started.body.stream_id
  await sleep(75)
  const replay = await request(`/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`, { headers: { Cookie: cookie } })
  const replayText = await replay.text()
  assert.match(replayText, /event: thought[\s\S]*fixture thought/)
  assert.match(replayText, /event: token[\s\S]*echo: contract/)
  assert.match(replayText, /event: stream_end/)

  const waiting = await json('/api/chat/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ session_id: sessionId, message: 'wait for cancel', workspace: join(sandbox, 'workspace') }),
  })
  const conflict = await json('/api/chat/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ session_id: sessionId, message: 'second', workspace: join(sandbox, 'workspace') }),
  })
  assert.equal(conflict.response.status, 409)
  assert.equal(conflict.body.active_stream_id, waiting.body.stream_id)
  const cancelled = await json(`/api/chat/cancel?stream_id=${encodeURIComponent(waiting.body.stream_id)}`, { method: 'POST', headers: { Cookie: cookie } })
  assert.deepEqual(cancelled.body, { cancelled: true })
  await sleep(25)
  const cancelledReplay = await request(`/api/chat/stream?stream_id=${encodeURIComponent(waiting.body.stream_id)}`, { headers: { Cookie: cookie } })
  assert.match(await cancelledReplay.text(), /event: cancel/)

  const reasoning = await json('/api/reasoning', { headers: { Cookie: cookie } })
  assert.deepEqual(reasoning.body, { supported_efforts: [], reasoning_effort: '' })

  const crashing = await json('/api/chat/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ session_id: sessionId, message: 'crash', workspace: join(sandbox, 'workspace') }),
  })
  assert.equal(crashing.response.status, 200)
  await sleep(75)
  const crashReplay = await request(`/api/chat/stream?stream_id=${encodeURIComponent(crashing.body.stream_id)}`, { headers: { Cookie: cookie } })
  assert.match(await crashReplay.text(), /event: (?:app)?error/)
  const recovered = await json('/api/session/new', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ workspace: join(sandbox, 'workspace') }),
  })
  assert.equal(recovered.response.status, 200)
})
