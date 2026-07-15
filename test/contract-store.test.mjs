import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))

let sandbox
let baseUrl
let store

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
  await mkdir(join(workspace, 'notes'), { recursive: true })
  await mkdir(appDist, { recursive: true })
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

  await cp(join(ROOT, 'server'), join(sandbox, 'server'), { recursive: true })
  await symlink(join(ROOT, 'node_modules'), join(sandbox, 'node_modules'), 'dir')

  const port = await allocatePort()
  baseUrl = `http://127.0.0.1:${port}`
  store = spawn(process.execPath, ['server/store.mjs'], {
    cwd: sandbox,
    env: {
      ...process.env,
      HOME: workspace,
      BROWSE_ROOT: workspace,
      AGENT_RIDER_APPS_DIR: apps,
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
      agentType: 'hermes',
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
      agentType: 'hermes',
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

test('password gate protects store routes and issues a reusable session cookie', async () => {
  const configured = await json('/store/password/set', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: '', nextPassword: 'fixture-password' }),
  })
  assert.equal(configured.response.status, 200)
  assert.equal(configured.body.enabled, true)
  assert.equal(configured.body.authenticated, true)
  const cookie = configured.response.headers.get('set-cookie').split(';', 1)[0]
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
  const listing = await json('/store/fs/list?path=', { headers: { Cookie: (await json('/store/password/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'fixture-password' }),
  })).response.headers.get('set-cookie').split(';', 1)[0] } })
  assert.equal(listing.response.status, 200)
  assert.deepEqual(listing.body.dirs, [{ name: 'notes', path: join(sandbox, 'workspace', 'notes') }])
  assert.deepEqual(listing.body.files, [{ name: 'README.md', path: join(sandbox, 'workspace', 'README.md'), size: 10 }])

  const cookie = (await json('/store/password/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'fixture-password' }),
  })).response.headers.get('set-cookie').split(';', 1)[0]

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
