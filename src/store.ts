// Client for the local SQLite persistence backend (server/store.mjs), proxied at /store.
// All calls fail soft: if the backend is unavailable the app still works in-memory.

// UI layout that should survive reloads: block positions plus visible/collapsed
// state for cards, tools, and apps. Kept intentionally loose so new layout bits
// can be added.
export interface WorkspacePanelState {
  collapsed?: boolean
  fullWindow?: boolean
  /** App Builder panels: which tab (Chat Window / App View / Chat+App) the user last used. */
  builderMode?: 'chat' | 'app' | 'split'
  /** App Builder panels: whether the Context (Category/Project/Agent) block is folded. */
  contextCollapsed?: boolean
  /** App Builder Chat+App mode: chat pane width as a fraction of the split (0.15–0.85). */
  builderSplit?: number
}

/** Tiling layout presets for the workspace canvas. `single`/`two-up` keep the
 *  original independent-column stack behavior; the rest are true auto-growing
 *  CSS grids (more open blocks add rows, they don't overflow the preset). */
export type LayoutPreset = 'single' | 'two-up' | 'quad' | 'three-col' | 'master-stack' | 'free'

export interface WorkspaceLayout {
  /** Open tool/app panels, in launch order. */
  panelOrder?: string[]
  panelColumns?: Record<string, number>
  /** Unified display order of all blocks (card ids + panel ids). */
  layoutOrder?: string[]
  /** @deprecated superseded by layoutPreset; still read for migration. */
  workspaceColumns?: 1 | 2
  layoutPreset?: LayoutPreset
  /** Row/column count for the 'free' preset. */
  freeRows?: number
  freeCols?: number
  /** Whole left sidebar rail collapsed to save horizontal space. */
  sidebarCollapsed?: boolean
  /** Conversation cards hidden via close, but still present in the Navigator. */
  closedRunIds?: string[]
  /** Conversation cards collapsed in the workspace. */
  collapsedRunIds?: string[]
  /** Per-card context section collapsed state. */
  cardMetaCollapsedIds?: string[]
  /** Conversations with a newly-completed, unread result (red dot). */
  unreadRunIds?: string[]
  /** Per-panel chrome state keyed by panel id: terminal, plugin:<id>, app:<slug>. */
  panelStates?: Record<string, WorkspacePanelState>
}

export interface PersistedState {
  runs: unknown[]
  turns: unknown[]
  layout: WorkspaceLayout | null
}

export async function loadPersistedState(): Promise<PersistedState | null> {
  try {
    const res = await fetch('/store/state')
    if (!res.ok) return null
    const data = (await res.json()) as Partial<PersistedState>
    return {
      runs: Array.isArray(data.runs) ? data.runs : [],
      turns: Array.isArray(data.turns) ? data.turns : [],
      layout: data.layout && typeof data.layout === 'object' ? (data.layout as WorkspaceLayout) : null,
    }
  } catch {
    return null
  }
}

export async function persistState(
  runs: unknown[],
  turns: unknown[],
  sessionId: string | null,
  layout?: WorkspaceLayout,
): Promise<void> {
  try {
    await fetch('/store/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs, turns, sessionId, layout }),
    })
  } catch {
    // ignore — persistence is best-effort
  }
}

// ── Page password gate ─────────────────────────────────────────────────────

export interface PasswordStatus {
  enabled: boolean
  authenticated: boolean
  version: string | null
}

function normalizePasswordStatus(data: Partial<PasswordStatus> | null): PasswordStatus {
  return {
    enabled: Boolean(data?.enabled),
    authenticated: Boolean(data?.authenticated),
    version: typeof data?.version === 'string' ? data.version : null,
  }
}

async function passwordJson(path: string, body?: Record<string, string>): Promise<PasswordStatus | { error: string }> {
  try {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = (await res.json()) as Partial<PasswordStatus> & { error?: string }
    if (!res.ok || data.error) return { error: data.error || 'Password request failed' }
    return normalizePasswordStatus(data)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function loadPasswordStatus(): Promise<PasswordStatus> {
  const result = await passwordJson('/store/password/status')
  if ('error' in result) return { enabled: false, authenticated: true, version: null }
  return result
}

export async function loginPagePassword(password: string): Promise<PasswordStatus | { error: string }> {
  return passwordJson('/store/password/login', { password })
}

export async function setPagePassword(currentPassword: string, nextPassword: string): Promise<PasswordStatus | { error: string }> {
  return passwordJson('/store/password/set', { currentPassword, nextPassword })
}

export async function logoutPagePassword(): Promise<void> {
  try {
    await fetch('/store/password/logout', { method: 'POST' })
  } catch {
    // ignore — the UI can still return to the locked state locally
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

export type FsFilePreviewKind = 'text' | 'markdown' | 'code' | 'image' | 'html'

export interface FsFilePreview {
  name: string
  path: string
  size: number
  kind: FsFilePreviewKind
  mime: string
  content?: string
  dataUrl?: string
  viewUrl?: string
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

export interface FsSearchResultEntry extends FsEntry {
  type: 'dir' | 'file'
  size?: number | null
}

export interface FsSearchResult {
  root: string
  path: string
  query: string
  results: FsSearchResultEntry[]
  truncated?: boolean
}

export async function searchFiles(path: string, query: string): Promise<FsSearchResult | { error: string }> {
  try {
    const res = await fetch(`/store/fs/search?path=${encodeURIComponent(path)}&query=${encodeURIComponent(query)}`)
    const data = (await res.json()) as Partial<FsSearchResult> & { error?: string }
    if (!res.ok || data.error) return { error: data.error || 'Search failed' }
    if (!data.results) return { error: 'Invalid search response' }
    return data as FsSearchResult
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readFilePreview(path: string): Promise<FsFilePreview | { error: string }> {
  try {
    const res = await fetch(`/store/fs/read?path=${encodeURIComponent(path)}`)
    const data = (await res.json()) as Partial<FsFilePreview> & { error?: string }
    if (!res.ok || data.error) return { error: data.error || 'Unable to open this file' }
    if (!data.name || !data.path || !data.kind || !data.mime || typeof data.size !== 'number') {
      return { error: 'Invalid file preview response' }
    }
    return data as FsFilePreview
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
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

export async function moveDir(source: string, target: string): Promise<{ path: string; moved: boolean } | { error: string; conflict?: boolean; source?: string; target?: string }> {
  try {
    const res = await fetch('/store/fs/move-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, target }),
    })
    const data = (await res.json()) as { path?: string; moved?: boolean; error?: string; conflict?: boolean; source?: string; target?: string }
    if (!res.ok || !data.path) {
      return {
        error: data.error || 'Failed to move folder',
        conflict: data.conflict,
        source: data.source,
        target: data.target,
      }
    }
    return { path: data.path, moved: Boolean(data.moved) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// Same-origin URL for downloading a workspace file as an attachment.
export function fileDownloadUrl(path: string): string {
  return `/store/fs/download?path=${encodeURIComponent(path)}`
}

export async function deleteFile(path: string): Promise<{ ok: true } | { error: string }> {
  try {
    const res = await fetch('/store/fs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    const data = (await res.json()) as { deleted?: boolean; error?: string }
    if (!res.ok || !data.deleted) return { error: data.error || 'Failed to delete file' }
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// Upload a file into a workspace directory. Sends the raw bytes as the body;
// the target folder and filename ride along as query params.
export async function uploadFile(dir: string, file: File): Promise<{ path: string; name: string } | { error: string }> {
  try {
    const res = await fetch(`/store/fs/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    })
    const data = (await res.json()) as { path?: string; name?: string; uploaded?: boolean; error?: string }
    if (!res.ok || !data.uploaded || !data.path) return { error: data.error || 'Failed to upload file' }
    return { path: data.path, name: data.name || file.name }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// ── Local Agent Apps ─────────────────────────────────────────────────────────

export interface AgentApp {
  id: string
  workspacePath?: string
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
  appsRoot?: string
}

const EMPTY_APP_LISTING: AppListing = { apps: [], warnings: [], hash: '0' }

function normalizeAppListing(data: Partial<AppListing> | null): AppListing {
  if (!data) return EMPTY_APP_LISTING
  return {
    apps: Array.isArray(data.apps) ? (data.apps as AgentApp[]) : [],
    warnings: Array.isArray(data.warnings) ? (data.warnings as AppWarning[]) : [],
    hash: typeof data.hash === 'string' ? data.hash : '0',
    appsRoot: typeof data.appsRoot === 'string' ? data.appsRoot : undefined,
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
