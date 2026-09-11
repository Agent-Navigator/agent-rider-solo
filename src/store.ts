// Client for the local SQLite persistence backend (server/store.mjs), proxied at /store.
// All calls fail soft: if the backend is unavailable the app still works in-memory.

import type { WorkspacePersistResult } from './stateSaveQueue'
import type { BrowserBookmark } from './browserBookmarks'

// UI layout that should survive reloads: block positions plus visible/collapsed
// state for cards, tools, and apps. Kept intentionally loose so new layout bits
// can be added.
export interface WorkspacePanelState {
  collapsed?: boolean
  fullWindow?: boolean
  /** Browser routing preference. Auto keeps normal sites Embedded and sends
   *  signed-in/sensitive sites to External Chrome through OpenCLI. */
  browserMode?: 'auto' | 'embedded' | 'external'
  /** Address-bar value, including an unsubmitted draft, retained across Desktop changes. */
  browserAddress?: string
  /** Last top-level page URL reported by the Browser session. */
  browserUrl?: string
  /** @deprecated Migrated into appPort for legacy Embed iframe panels. */
  url?: string
  /** Editable name shown in an Agent App panel title bar. */
  appName?: string
  /** Registered app slug under the configured Agent Rider apps directory. */
  appId?: string
  /** Icon token persisted with the registered app metadata. */
  appIcon?: string
  /** Absolute registered project directory used as the TUI working directory. */
  appLocation?: string
  /** Loopback port allocated to the Agent App's proxied development server. */
  appPort?: number
  /** Fraction of the split window occupied by App View (0.2–0.8). */
  appSplit?: number
  /** TUI chat pane collapsed inside an Agent App panel so the App View keeps the
   *  whole window. Persisted because Desktop changes unmount hidden panels. */
  appChatCollapsed?: boolean
  /** Persistent TUI command selected when the Agent App panel was created. */
  agentCommand?: string
  /** TUI cards: a scratch draft the user composes safely (IME-friendly, no
   *  accidental Enter) before inserting it into the terminal. Persisted so it
   *  can also hold useful notes across sessions. */
  notepad?: string
  /** @deprecated Retained only so older workspace snapshots can round-trip. */
  richViewOpen?: boolean
}

/** Tiling layout presets for the workspace canvas. `single`/`two-up` keep the
 *  original independent-column stack behavior; the rest are true auto-growing
 *  CSS grids (more open blocks add rows, they don't overflow the preset). */
export type LayoutPreset = 'single' | 'two-up' | 'quad' | 'three-col' | 'master-stack' | 'free'
export type DesktopId = 1 | 2 | 3 | 4 | 5 | 6

export interface PaneSizeState {
  columns?: number[]
  rows?: number[]
  columnRows?: Record<string, number[]>
}

export interface DesktopLayoutSettings {
  layoutPreset: LayoutPreset
  freeRows: number
  freeCols: number
  /** Relative pane sizes, kept separately for each preset on this Desktop. */
  paneSizes?: Partial<Record<LayoutPreset, PaneSizeState>>
}

export interface AgentCommand {
  id: string
  name: string
  command: string
}

export type AgentCommandAvailability = Record<string, boolean>

export interface RateLimitWindow {
  usedPercent: number
  windowMinutes: number
  resetsAt: number | null
  resetDescription: string | null
}

export interface RateLimitBucket extends RateLimitWindow {
  name: string
}

export type UsageProviderStatus = 'idle' | 'ok' | 'error' | 'unavailable'

export interface ProviderUsage {
  provider: 'claude' | 'codex' | 'kimi' | 'grok' | 'gemini' | 'antigravity' | 'opencode-go' | 'minimax'
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
  monthly: RateLimitWindow | null
  buckets: RateLimitBucket[]
  updatedAt: number | null
  attemptedAt: number | null
  error: string | null
  status: UsageProviderStatus
  stale: boolean
}

export interface UsageState {
  claude: ProviderUsage
  codex: ProviderUsage
  kimi: ProviderUsage
  grok: ProviderUsage
  gemini: ProviderUsage
  antigravity: ProviderUsage
  opencodeGo: ProviderUsage
  minimax: ProviderUsage
  refreshedAt: number | null
  refreshIntervalMs: number
}

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
  /** Currently selected macOS-style workspace desktop. */
  activeDesktop?: DesktopId
  /** Independent tiling choice and free-grid dimensions for each desktop. */
  desktopLayouts?: Partial<Record<DesktopId, DesktopLayoutSettings>>
  /** Desktop membership for conversation cards and tool/app panels. */
  desktopAssignments?: Record<string, DesktopId>
  /** User-defined commands shown by the Agent selector on conversation cards. */
  agentCommands?: AgentCommand[]
  /** Distinguishes an intentionally empty command list from a pre-feature save. */
  agentCommandsInitialized?: boolean
  /** Conversation cards hidden via close, but still present in the Navigator. */
  closedRunIds?: string[]
  /** Conversation cards collapsed in the workspace. */
  collapsedRunIds?: string[]
  /** Per-card context section collapsed state. */
  cardMetaCollapsedIds?: string[]
  /** Conversations with a newly-completed, unread result (red dot). */
  unreadRunIds?: string[]
  /** Per-panel chrome state keyed by panel id: terminal, browser-*, plugin:<id>, app:<slug>. */
  panelStates?: Record<string, WorkspacePanelState>
}

export interface PersistedState {
  revision: number
  runs: unknown[]
  turns: unknown[]
  layout: WorkspaceLayout | null
}

export interface BuildIdentity {
  version: string
  sourceCommit: string
  displayVersion: string
  platform: string
}

export interface VersionInfo {
  app: BuildIdentity
  runtime: BuildIdentity | null
  sameBuild: boolean
  upgradePreparing: boolean
}

function normalizeBuildIdentity(value: unknown): BuildIdentity | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<BuildIdentity>
  if (
    typeof candidate.version !== 'string'
    || typeof candidate.sourceCommit !== 'string'
    || typeof candidate.displayVersion !== 'string'
    || typeof candidate.platform !== 'string'
  ) return null
  return {
    version: candidate.version,
    sourceCommit: candidate.sourceCommit,
    displayVersion: candidate.displayVersion,
    platform: candidate.platform,
  }
}

export async function loadVersionInfo(): Promise<VersionInfo | { error: string }> {
  try {
    const res = await fetch('/store/version')
    const data = (await res.json()) as {
      app?: unknown
      runtime?: unknown
      sameBuild?: unknown
      upgradePreparing?: unknown
      error?: string
    }
    if (!res.ok || data.error) return { error: data.error || 'Unable to load version information' }
    const app = normalizeBuildIdentity(data.app)
    const runtime = data.runtime == null ? null : normalizeBuildIdentity(data.runtime)
    if (!app || (data.runtime != null && !runtime)) return { error: 'Invalid version response' }
    return {
      app,
      runtime,
      sameBuild: Boolean(data.sameBuild),
      upgradePreparing: Boolean(data.upgradePreparing),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function acknowledgeWorkspaceUpgrade(revision: number): Promise<boolean> {
  try {
    const response = await fetch('/store/workspace/upgrade-ready', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: 1, revision }),
    })
    if (!response.ok) return false
    const body = await response.json() as { ok?: unknown; revision?: unknown }
    return body.ok === true && body.revision === revision
  } catch {
    return false
  }
}

export async function loadPersistedState(): Promise<PersistedState | null> {
  try {
    const res = await fetch('/store/state')
    if (!res.ok) return null
    const data = (await res.json()) as Partial<PersistedState>
    return {
      revision: Number.isSafeInteger(data.revision) && (data.revision ?? -1) >= 0
        ? data.revision as number
        : 0,
      runs: Array.isArray(data.runs) ? data.runs : [],
      turns: Array.isArray(data.turns) ? data.turns : [],
      layout: data.layout && typeof data.layout === 'object' ? (data.layout as WorkspaceLayout) : null,
    }
  } catch {
    return null
  }
}

export interface AgentCommandsSetting {
  commands: unknown[]
  initialized: boolean
}

export interface UsageCredentialSettings {
  openCodeConfigured: boolean
  openCodeWorkspaceId: string
  miniMaxConfigured: boolean
  miniMaxGroupId: string
  miniMaxModels: string
}

async function usageResponse(res: Response): Promise<UsageState> {
  if (!res.ok) throw new Error(`Usage request failed (${res.status})`)
  return await res.json() as UsageState
}

export async function loadUsageState(): Promise<UsageState> {
  return usageResponse(await fetch('/store/usage'))
}

export async function refreshUsageState(force = false): Promise<UsageState> {
  return usageResponse(await fetch('/store/usage/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  }))
}

export async function loadAgentCommandsSetting(): Promise<AgentCommandsSetting | null> {
  try {
    const res = await fetch('/store/settings/agent-commands')
    if (!res.ok) return null
    const data = (await res.json()) as { commands?: unknown; initialized?: unknown }
    return {
      commands: Array.isArray(data.commands) ? data.commands : [],
      initialized: data.initialized === true,
    }
  } catch {
    return null
  }
}

export interface WorkspaceBootstrap {
  state: PersistedState
  agentCommandsSetting: AgentCommandsSetting
}

/**
 * Loads the state needed to arm workspace auto-save as one all-or-nothing
 * bootstrap. A partial response during an application upgrade stays unresolved
 * instead of being mistaken for a new empty workspace.
 */
export async function loadWorkspaceBootstrap(): Promise<WorkspaceBootstrap | null> {
  const [state, agentCommandsSetting] = await Promise.all([
    loadPersistedState(),
    loadAgentCommandsSetting(),
  ])
  return state && agentCommandsSetting ? { state, agentCommandsSetting } : null
}

export async function persistAgentCommandsSetting(commands: AgentCommand[]): Promise<void> {
  try {
    await fetch('/store/settings/agent-commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocol: 2, commands }),
    })
  } catch {
    // ignore - persistence is best-effort
  }
}

export async function loadBrowserBookmarks(): Promise<BrowserBookmark[]> {
  const res = await fetch('/store/settings/browser-bookmarks')
  const data = await res.json().catch(() => null) as { bookmarks?: unknown; error?: string } | null
  if (!res.ok) throw new Error(data?.error ?? `Browser bookmarks request failed (${res.status})`)
  return Array.isArray(data?.bookmarks) ? data.bookmarks as BrowserBookmark[] : []
}

export async function persistBrowserBookmarks(
  bookmarks: BrowserBookmark[],
): Promise<BrowserBookmark[]> {
  const res = await fetch('/store/settings/browser-bookmarks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocol: 1, bookmarks }),
  })
  const data = await res.json().catch(() => null) as { bookmarks?: unknown; error?: string } | null
  if (!res.ok) throw new Error(data?.error ?? `Browser bookmarks save failed (${res.status})`)
  return Array.isArray(data?.bookmarks) ? data.bookmarks as BrowserBookmark[] : []
}

export async function loadUsageCredentialSettings(): Promise<UsageCredentialSettings> {
  const res = await fetch('/store/settings/usage')
  if (!res.ok) throw new Error(`Usage settings request failed (${res.status})`)
  return await res.json() as UsageCredentialSettings
}

export async function persistUsageCredentialSettings(update: {
  openCodeCookie?: string
  openCodeWorkspaceId: string
  clearOpenCodeCookie?: boolean
  miniMaxCookie?: string
  miniMaxGroupId: string
  miniMaxModels: string
  clearMiniMaxCookie?: boolean
}): Promise<UsageCredentialSettings> {
  const res = await fetch('/store/settings/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(data?.error ?? `Usage settings request failed (${res.status})`)
  }
  return await res.json() as UsageCredentialSettings
}

export async function loadAgentCommandAvailability(
  commands: AgentCommand[],
): Promise<AgentCommandAvailability | null> {
  try {
    const res = await fetch('/store/agents/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: commands.map(({ id, command }) => ({ id, command })),
      }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { availability?: unknown }
    if (!data.availability || typeof data.availability !== 'object') return null
    return Object.fromEntries(
      Object.entries(data.availability).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
    )
  } catch {
    return null
  }
}

export async function persistState(
  runs: unknown[],
  turns: unknown[],
  sessionId: string | null,
  layout?: WorkspaceLayout,
  revision = 0,
  deletedRunIds: string[] = [],
  deletedTurnIds: string[] = [],
): Promise<WorkspacePersistResult> {
  try {
    const response = await fetch('/store/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: 4,
        revision,
        runs,
        turns,
        sessionId,
        layout,
        deletedRunIds,
        deletedTurnIds,
      }),
    })
    const body = await response.json().catch(() => ({})) as { revision?: unknown }
    if (response.ok && Number.isSafeInteger(body.revision) && (body.revision as number) >= 0) {
      return { status: 'saved', revision: body.revision as number }
    }
    if (
      response.status === 409
      && Number.isSafeInteger(body.revision)
      && (body.revision as number) >= 0
    ) {
      return { status: 'conflict', revision: body.revision as number }
    }
    return { status: 'retry' }
  } catch {
    return { status: 'retry' }
  }
}

// ── Durable To-Do items ────────────────────────────────────────────────────

export interface TodoItem {
  id: string
  content: string
  completed: boolean
  sortIndex: number
  createdAt: string
  updatedAt: string
}

type TodoListResult = { items: TodoItem[] } | { error: string }
type TodoItemResult = { item: TodoItem } | { error: string }

function normalizeTodoItem(value: Partial<TodoItem>): TodoItem | null {
  if (typeof value.id !== 'string' || typeof value.content !== 'string') return null
  return {
    id: value.id,
    content: value.content,
    completed: Boolean(value.completed),
    sortIndex: typeof value.sortIndex === 'number' ? value.sortIndex : 0,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  }
}

async function todoJson(path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = (await response.json()) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'To-Do request failed')
  return data
}

export async function loadTodos(): Promise<TodoListResult> {
  try {
    const data = await todoJson('/store/todos')
    const items = Array.isArray(data.items)
      ? data.items.map((item) => normalizeTodoItem(item as Partial<TodoItem>)).filter((item): item is TodoItem => Boolean(item))
      : []
    return { items }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function createTodo(content: string): Promise<TodoItemResult> {
  try {
    const data = await todoJson('/store/todos/create', { content })
    const item = normalizeTodoItem((data.item ?? {}) as Partial<TodoItem>)
    return item ? { item } : { error: 'Invalid To-Do response' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function updateTodo(id: string, changes: { content?: string; completed?: boolean }): Promise<TodoItemResult> {
  try {
    const data = await todoJson('/store/todos/update', { id, ...changes })
    const item = normalizeTodoItem((data.item ?? {}) as Partial<TodoItem>)
    return item ? { item } : { error: 'Invalid To-Do response' }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function deleteTodo(id: string): Promise<{ ok: true } | { error: string }> {
  try {
    await todoJson('/store/todos/delete', { id })
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function setTodoOrder(order: string[]): Promise<{ ok: true } | { error: string }> {
  try {
    await todoJson('/store/todos/order', { order })
    return { ok: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
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

export async function loadPasswordStatus(): Promise<PasswordStatus | null> {
  const result = await passwordJson('/store/password/status')
  // A service restart is not evidence that password protection is disabled.
  // Keep the status unresolved so callers can retry without hydrating/saving
  // an empty workspace while the upgrade is between application processes.
  if ('error' in result) return null
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
  modifiedAt: number | null
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

export type FsFilePreviewKind = 'text' | 'markdown' | 'code' | 'csv' | 'image' | 'html'

export interface FsFilePreview {
  name: string
  path: string
  size: number
  modifiedAt: number | null
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
    data.modifiedAt = typeof data.modifiedAt === 'number' ? data.modifiedAt : null
    return data as FsFilePreview
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function writeFileContent(path: string, content: string): Promise<{ path: string; name: string; size: number } | { error: string }> {
  try {
    const res = await fetch('/store/fs/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    })
    const data = (await res.json()) as { path?: string; name?: string; size?: number; written?: boolean; error?: string }
    if (!res.ok || !data.written || !data.path || !data.name || typeof data.size !== 'number') {
      return { error: data.error || 'Failed to save file' }
    }
    return { path: data.path, name: data.name, size: data.size }
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

export async function moveFsEntry(source: string, destination: string, name?: string): Promise<{ path: string; name: string; moved: boolean } | { error: string }> {
  try {
    const res = await fetch('/store/fs/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, destination, ...(name === undefined ? {} : { name }) }),
    })
    const data = (await res.json()) as { path?: string; name?: string; moved?: boolean; error?: string }
    if (!res.ok || !data.path || !data.name) return { error: data.error || 'Failed to move item' }
    return { path: data.path, name: data.name, moved: Boolean(data.moved) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export async function duplicateFsEntry(path: string): Promise<{ path: string; name: string } | { error: string }> {
  try {
    const res = await fetch('/store/fs/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    const data = (await res.json()) as { path?: string; name?: string; duplicated?: boolean; error?: string }
    if (!res.ok || !data.duplicated || !data.path || !data.name) return { error: data.error || 'Failed to duplicate item' }
    return { path: data.path, name: data.name }
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
  dir: string
  workspacePath?: string
  location: string
  icon: string
  label: string
  group: string
  kind: 'static' | 'dynamic'
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
  const apps = Array.isArray(data.apps)
    ? (data.apps as AgentApp[]).map((app) => ({
        ...app,
        dir: typeof app.dir === 'string' ? app.dir : app.id,
        location: typeof app.location === 'string'
          ? app.location
          : typeof app.workspacePath === 'string'
            ? app.workspacePath
            : '',
        icon: typeof app.icon === 'string' && app.icon ? app.icon : 'app-window',
        kind: app.kind === 'static' ? 'static' as const : 'dynamic' as const,
      }))
    : []
  return {
    apps,
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

export async function createAgentApp(
  label = 'New App',
  icon = 'app-window',
): Promise<{ app: AgentApp; listing: AppListing } | null> {
  try {
    const res = await fetch('/store/apps/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, icon }),
    })
    const data = (await res.json()) as {
      app?: AgentApp
      listing?: Partial<AppListing>
      error?: string
    }
    if (!res.ok || !data.app || !data.listing) return null
    return { app: data.app, listing: normalizeAppListing(data.listing) }
  } catch {
    return null
  }
}

export async function deleteAgentApp(slug: string): Promise<AppListing | null> {
  try {
    const res = await fetch('/store/apps/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    })
    if (!res.ok) return null
    return normalizeAppListing((await res.json()) as Partial<AppListing>)
  } catch {
    return null
  }
}

export async function duplicateAgentApp(
  slug: string,
): Promise<{ app: AgentApp; listing: AppListing } | null> {
  try {
    const res = await fetch('/store/apps/duplicate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug }),
    })
    const data = (await res.json()) as {
      app?: AgentApp
      listing?: Partial<AppListing>
      error?: string
    }
    if (!res.ok || !data.app || !data.listing) return null
    return { app: data.app, listing: normalizeAppListing(data.listing) }
  } catch {
    return null
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

export interface AgentAppPort {
  panel: string
  port: number
  target: string
}

export async function allocateAgentAppPort(panel: string, usedPorts: number[]): Promise<AgentAppPort> {
  const query = new URLSearchParams({ panel })
  const used = [...new Set(usedPorts.filter((port) => Number.isInteger(port) && port >= 1024 && port <= 65535))]
  if (used.length) query.set('used', used.join(','))
  const res = await fetch(`/store/agent-app/port?${query}`)
  const data = (await res.json()) as Partial<AgentAppPort> & { error?: string }
  if (!res.ok || !Number.isInteger(data.port)) {
    throw new Error(data.error || 'Unable to allocate an Agent App port')
  }
  return data as AgentAppPort
}

export async function agentAppPortReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`/store/agent-app/status?port=${encodeURIComponent(port)}`, {
      cache: 'no-store',
    })
    if (!res.ok) return false
    const data = (await res.json()) as { ready?: unknown }
    return data.ready === true
  } catch {
    return false
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
