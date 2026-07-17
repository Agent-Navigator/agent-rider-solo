import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, cp, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BINARY = join(ROOT, 'target', 'debug', 'agrider')
const platformArch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
const platform = `linux-${platformArch}`
const archiveName = `agrider-${platform}.tar.gz`

let sandbox
let bundle
let digest
let server
let baseUrl
let manifest
let healthStatus = 200
let holdManifest = false
let heldResponse
let manifestRequested

function command(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, options)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

function stableManifest(overrides = {}) {
  return {
    version: '0.1.2',
    source_commit: 'fixture-commit',
    assets: [{ platform, archive: archiveName, sha256: digest }],
    ...overrides,
  }
}

async function setupInstall(name) {
  const home = join(sandbox, `home-${name}`)
  const root = join(home, '.local', 'share', 'agrider')
  const old = join(root, 'releases', '0.1.1')
  await mkdir(join(root, 'shared', 'data'), { recursive: true })
  await mkdir(join(root, 'shared', 'plugins'), { recursive: true })
  await mkdir(old, { recursive: true })
  await writeFile(join(old, 'agrider'), 'old release\n')
  await writeFile(join(root, 'shared', 'data', 'state.txt'), 'saved state\n')
  await writeFile(join(root, 'shared', 'plugins', 'app.txt'), 'local app\n')
  await symlink(old, join(root, 'current'))
  const config = join(home, '.config', 'agrider', 'env')
  await mkdir(join(home, '.config', 'agrider'), { recursive: true })
  await writeFile(config, 'AGENT_RIDER_PORT=5173\n')
  return { home, root, old, config, log: join(sandbox, `${name}.systemctl.log`) }
}

async function runUpgrade(install, extra = {}) {
  return command(BINARY, ['upgrade'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: install.home,
      PATH: `${join(sandbox, 'mock-bin')}:${process.env.PATH}`,
      MOCK_SYSTEMCTL_LOG: install.log,
      AGRIDER_DATA_ROOT: install.root,
      AGRIDER_CONFIG_FILE: install.config,
      AGRIDER_RELEASE_BASE: baseUrl,
      AGRIDER_HEALTH_URL: `${baseUrl}/store/state`,
      AGRIDER_HEALTH_ATTEMPTS: '2',
      AGRIDER_HEALTH_DELAY_MS: '1',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'agrider-upgrade-test-'))
  const source = join(sandbox, 'bundle')
  await mkdir(join(source, 'frontend'), { recursive: true })
  await writeFile(join(source, 'agrider'), '#!/bin/sh\nexit 0\n')
  await chmod(join(source, 'agrider'), 0o755)
  await writeFile(join(source, 'frontend', 'index.html'), '<!doctype html><title>new</title>\n')
  await writeFile(join(source, 'release.json'), '{"version":"0.1.2","source_commit":"fixture-commit"}\n')
  const archive = join(sandbox, archiveName)
  const packed = await command('tar', ['-C', source, '-czf', archive, '.'])
  assert.equal(packed.code, 0, packed.stderr)
  bundle = await readFile(archive)
  digest = createHash('sha256').update(bundle).digest('hex')

  const mockBin = join(sandbox, 'mock-bin')
  await mkdir(mockBin)
  await writeFile(join(mockBin, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$MOCK_SYSTEMCTL_LOG"
case "$*" in *is-active*) exit 0 ;; esac
exit 0
`)
  await chmod(join(mockBin, 'systemctl'), 0o755)

  manifest = stableManifest()
  server = createServer((request, response) => {
    if (request.url === '/manifest.json') {
      if (holdManifest) {
        heldResponse = response
        manifestRequested?.()
        return
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(manifest))
    } else if (request.url === `/${archiveName}`) {
      response.end(bundle)
    } else if (request.url === '/store/state') {
      response.statusCode = healthStatus
      response.end('{}')
    } else {
      response.statusCode = 404
      response.end('not found')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(sandbox, { recursive: true, force: true })
})

test('stable upgrade backs up state, switches atomically, and restarts once healthy', async () => {
  const install = await setupInstall('success')
  manifest = stableManifest()
  healthStatus = 200
  const result = await runUpgrade(install)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(await readlink(join(install.root, 'current')), join(install.root, 'releases', '0.1.2'))
  assert.equal(await readFile(join(install.root, 'shared', 'data', 'state.txt'), 'utf8'), 'saved state\n')
  assert.equal(await readFile(join(install.root, 'shared', 'plugins', 'app.txt'), 'utf8'), 'local app\n')
  const backups = await readdir(join(install.root, 'shared', 'backups'))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(join(install.root, 'shared', 'backups', backups[0], 'data', 'state.txt'), 'utf8'), 'saved state\n')
  const log = await readFile(install.log, 'utf8')
  assert.match(log, /--user stop agrider\.service/)
  assert.match(log, /--user restart agrider\.service/)
})

test('already-current and prerelease manifests do not stop the service', async () => {
  const current = await setupInstall('current')
  manifest = stableManifest({ version: '0.1.1' })
  let result = await runUpgrade(current)
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /already current/)

  const prerelease = await setupInstall('prerelease')
  manifest = stableManifest({ version: '0.1.2-beta.1' })
  result = await runUpgrade(prerelease)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /prerelease/)
  await assert.rejects(readFile(prerelease.log), { code: 'ENOENT' })
})

test('download and checksum failures happen before service shutdown', async () => {
  const checksum = await setupInstall('checksum')
  manifest = stableManifest({
    assets: [{ platform, archive: archiveName, sha256: '0'.repeat(64) }],
  })
  let result = await runUpgrade(checksum)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /checksum mismatch/)
  assert.equal(await readlink(join(checksum.root, 'current')), checksum.old)
  await assert.rejects(readFile(checksum.log), { code: 'ENOENT' })

  const missing = await setupInstall('missing')
  manifest = stableManifest({
    assets: [{ platform, archive: 'missing.tar.gz', sha256: digest }],
  })
  result = await runUpgrade(missing)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /404/)
  await assert.rejects(readFile(missing.log), { code: 'ENOENT' })
})

test('failed health validation restores the old release and service', async () => {
  const install = await setupInstall('rollback')
  manifest = stableManifest()
  healthStatus = 500
  const result = await runUpgrade(install)
  healthStatus = 200
  assert.equal(result.code, 1)
  assert.match(result.stderr, /restored previous release/)
  assert.equal(await readlink(join(install.root, 'current')), install.old)
  const log = await readFile(install.log, 'utf8')
  assert.equal(log.match(/--user restart agrider\.service/g)?.length, 2)
})

test('a concurrent upgrade is rejected by the update lock', async () => {
  const install = await setupInstall('concurrent')
  manifest = stableManifest({ version: '0.1.1' })
  holdManifest = true
  const requested = new Promise((resolve) => { manifestRequested = resolve })
  const first = runUpgrade(install)
  await requested
  const second = await runUpgrade(install)
  assert.equal(second.code, 1)
  assert.match(second.stderr, /already running/)
  holdManifest = false
  heldResponse.setHeader('content-type', 'application/json')
  heldResponse.end(JSON.stringify(manifest))
  const firstResult = await first
  assert.equal(firstResult.code, 0, firstResult.stderr)
})
