// Client for the local SQLite persistence backend (server/store.mjs), proxied at /store.
// All calls fail soft: if the backend is unavailable the app still works in-memory.

export interface PersistedState {
  runs: unknown[]
  turns: unknown[]
}

export async function loadPersistedState(): Promise<PersistedState | null> {
  try {
    const res = await fetch('/store/state')
    if (!res.ok) return null
    const data = (await res.json()) as Partial<PersistedState>
    return {
      runs: Array.isArray(data.runs) ? data.runs : [],
      turns: Array.isArray(data.turns) ? data.turns : [],
    }
  } catch {
    return null
  }
}

export async function persistState(runs: unknown[], turns: unknown[], sessionId: string | null): Promise<void> {
  try {
    await fetch('/store/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs, turns, sessionId }),
    })
  } catch {
    // ignore — persistence is best-effort
  }
}

export interface FsEntry {
  name: string
  path: string
}

export interface FsFileEntry extends FsEntry {
  size: number | null
}

export interface FsListing {
  root: string
  path: string
  parent: string | null
  dirs: FsEntry[]
  files?: FsFileEntry[]
}

export async function listDir(path?: string): Promise<FsListing | null> {
  try {
    const res = await fetch(`/store/fs/list?path=${encodeURIComponent(path ?? '')}`)
    if (!res.ok) return null
    return (await res.json()) as FsListing
  } catch {
    return null
  }
}

export async function makeDir(parent: string, name: string): Promise<{ path: string } | { error: string }> {
  try {
    const res = await fetch('/store/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent, name }),
    })
    const data = (await res.json()) as { path?: string; error?: string }
    if (!res.ok || !data.path) return { error: data.error || 'Failed to create folder' }
    return { path: data.path }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// ── Agent App plugins ────────────────────────────────────────────────────────

export interface AgentApp {
  id: string
  label: string
  group: string
  kind: 'static' | 'embedded'
  entry: string
  description: string
  dataScopes: string[]
  version: number
  hasDist: boolean
}

export interface AppWarning {
  dir?: string
  dirs?: string[]
  id?: string
  error: string
}

export interface AppListing {
  apps: AgentApp[]
  warnings: AppWarning[]
  hash: string
}

const EMPTY_APP_LISTING: AppListing = { apps: [], warnings: [], hash: '0' }

function normalizeAppListing(data: Partial<AppListing> | null): AppListing {
  if (!data) return EMPTY_APP_LISTING
  return {
    apps: Array.isArray(data.apps) ? (data.apps as AgentApp[]) : [],
    warnings: Array.isArray(data.warnings) ? (data.warnings as AppWarning[]) : [],
    hash: typeof data.hash === 'string' ? data.hash : '0',
  }
}

export async function listApps(): Promise<AppListing> {
  try {
    const res = await fetch('/store/apps')
    if (!res.ok) return EMPTY_APP_LISTING
    return normalizeAppListing((await res.json()) as Partial<AppListing>)
  } catch {
    return EMPTY_APP_LISTING
  }
}

export async function setAppOrder(order: string[]): Promise<AppListing> {
  try {
    const res = await fetch('/store/apps/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order }),
    })
    if (!res.ok) return EMPTY_APP_LISTING
    return normalizeAppListing((await res.json()) as Partial<AppListing>)
  } catch {
    return EMPTY_APP_LISTING
  }
}

export async function renameApp(slug: string, label: string): Promise<AppListing> {
  try {
    const res = await fetch('/store/apps/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, label }),
    })
    if (!res.ok) return EMPTY_APP_LISTING
    return normalizeAppListing((await res.json()) as Partial<AppListing>)
  } catch {
    return EMPTY_APP_LISTING
  }
}

export interface TerminalRunResult {
  cwd: string
  nextCwd: string
  output: string
  exitCode: number | null
  signal?: string | null
  timedOut: boolean
}

export async function runTerminalCommand(command: string, cwd: string): Promise<TerminalRunResult> {
  const res = await fetch('/store/terminal/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, cwd }),
  })
  const data = (await res.json()) as Partial<TerminalRunResult> & { error?: string }
  if (!res.ok) throw new Error(data.error || 'Terminal command failed')
  return {
    cwd: String(data.cwd ?? cwd),
    nextCwd: String(data.nextCwd ?? cwd),
    output: String(data.output ?? ''),
    exitCode: typeof data.exitCode === 'number' ? data.exitCode : null,
    signal: data.signal ?? null,
    timedOut: Boolean(data.timedOut),
  }
}
