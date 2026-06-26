import { type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTermTerminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { HermesBridge, type HermesConnectionState } from './hermesBridge'
import {
  loadPersistedState,
  persistState,
  listDir,
  readFilePreview,
  makeDir,
  listApps,
  setAppOrder,
  renameApp,
  type FsListing,
  type FsFilePreview,
  type AgentApp,
  type AppListing,
  type AppWarning,
  type WorkspacePanelState,
} from './store'
import { plugins, type AgentRiderPlugin } from '../plugins'
import { WebView } from '../plugins/WebView'

type JobStatus = 'queued' | 'running' | 'done' | 'error'
type ResourceHealth = 'Ready' | 'Needs setup' | 'Draft'

type ChatRole = 'user' | 'assistant'

// Which agent backend drives a conversation card. 'hermes' streams turns over
// /api (the default); the others run an interactive TUI CLI in an embedded
// terminal (see WebTerminal + the /store/terminal/ws `agent` param).
type AgentType = 'hermes' | 'claude' | 'codex' | 'agy'
type TuiAgentType = Exclude<AgentType, 'hermes'>

const AGENT_OPTIONS: { value: AgentType; label: string }[] = [
  { value: 'hermes', label: 'Hermes Agent' },
  { value: 'claude', label: 'claude (CLI)' },
  { value: 'codex', label: 'codex (CLI)' },
  { value: 'agy', label: 'agy (Antigravity)' },
]

function isTuiAgent(agent: AgentType): agent is TuiAgentType {
  return agent === 'claude' || agent === 'codex' || agent === 'agy'
}

function agentLabel(agent: AgentType) {
  return AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent
}

interface RunNode {
  id: string
  prompt: string
  category: string
  categoryTags: string[]
  project: string
  workspace: string
  workspacePath: string
  task: string
  job: string
  jobStatus: JobStatus
  resourceIds: string[]
  sessionId?: string | null
  agentType: AgentType
  /** Which card column (0 = left, 1 = right) in the two-column layout. */
  column: number
  createdAt: string
}

interface ResourceItem {
  id: string
  kind: string
  name: string
  detail: string
  health: ResourceHealth
  assignedRunIds: string[]
  assignedTaskIds: string[]
}

interface TurnItem {
  id: string
  prompt: string
  response: string
  status: JobStatus
  runId: string
  parentTurnId?: string | null
  createdAt: string
}

interface TurnTreeNode {
  turn: TurnItem
  children: TurnTreeNode[]
}

interface QueuedPromptEntry {
  turnId: string
  runId: string
  prompt: string
  workspace: string
}

interface CategoryRule {
  name: string
  tags: string[]
  terms: string[]
}

interface ResourceTemplate {
  id: string
  kind: string
  name: string
  detail: string
  terms: string[]
  always?: boolean
}

interface ConversationTreeProject {
  project: string
  runs: RunNode[]
}

interface ConversationTreeCategory {
  category: string
  projects: ConversationTreeProject[]
}

const DEFAULT_CWD = '/root/agent-work/DEV/agent-rider'
const DEFAULT_TERMINAL_CWD = '/root'
const DEFAULT_TITLE = 'Agent Rider'
const AGENT_TERMINAL_STATE_PREFIX = 'agent-terminal:'

const categoryRules: CategoryRule[] = [
  {
    name: 'Infrastructure',
    tags: ['infra', 'runtime', 'systems'],
    terms: ['api', 'cron', 'db', 'deploy', 'database', 'monitor', 'network', 'server', 'ssh', 'tailscale', 'worker'],
  },
  {
    name: 'Customer Ops',
    tags: ['customers', 'inbox', 'crm'],
    terms: ['chat', 'customer', 'email', 'inbox', 'lead', 'outreach', 'sales', 'slack', 'support'],
  },
  {
    name: 'Knowledge Ops',
    tags: ['research', 'docs', 'analysis'],
    terms: ['brief', 'document', 'docs', 'memo', 'notes', 'pdf', 'report', 'research', 'summary'],
  },
  {
    name: 'Product Delivery',
    tags: ['product', 'release', 'planning'],
    terms: ['design', 'feature', 'launch', 'product', 'roadmap', 'sprint', 'website'],
  },
]

const resourceTemplates: ResourceTemplate[] = [
  {
    id: 'res-email',
    kind: 'Email account',
    name: 'Shared inbox credential',
    detail: 'Reusable mail identity for inbound triage, drafts, and notification routing.',
    terms: ['customer', 'email', 'inbox', 'lead', 'outreach', 'report', 'sales', 'smtp', 'support'],
  },
  {
    id: 'res-chat',
    kind: 'Chat app account',
    name: 'Team chat account',
    detail: 'Workspace chat identity for messages, mentions, and channel context.',
    terms: ['chat', 'discord', 'line', 'telegram', 'mention', 'slack', 'teams', 'whatsapp'],
  },
  {
    id: 'res-website',
    kind: 'Website account',
    name: 'Website operator login',
    detail: 'Reusable website or CMS account for browser sessions and site changes.',
    terms: ['browser', 'cms', 'cloudflare', 'login', 'site', 'website', 'google', 'microsoft', 'm365'],
  },
  {
    id: 'res-api-token',
    kind: 'API token',
    name: 'Integration API token',
    detail: 'Token profile for service calls, webhooks, and third-party integrations.',
    terms: ['api', 'integration', 'token', 'webhook', 'llm', 'telegrambot'],
  },
  {
    id: 'res-database',
    kind: 'DB connection',
    name: 'Operational database',
    detail: 'Connection profile for SQL queries, warehouse reads, and audit-safe exports.',
    terms: ['database', 'db', 'mysql', 'postgres', 'sql', 'warehouse'],
  },
  {
    id: 'res-documents',
    kind: 'Document set',
    name: 'Project document library',
    detail: 'Reusable source folder for briefs, PDFs, notes, reports, and working docs.',
    terms: ['brief', 'document', 'docs', 'memo', 'notes', 'pdf', 'report', 'research', 'summary'],
    always: true,
  },
  {
    id: 'res-network',
    kind: 'Networking',
    name: 'SSH and Tailscale profile',
    detail: 'Private network details for SSH hosts, tunnels, VPN routes, and Tailscale nodes.',
    terms: ['network', 'private', 'ssh', 'tailscale', 'tunnel', 'vpn'],
  },
  {
    id: 'res-agent',
    kind: 'AI agent',
    name: 'Automation agent profile',
    detail: 'Default agent identity, model preference, memory scope, and run policy.',
    terms: ['agent', 'automation', 'background', 'job', 'task', 'worker'],
    always: true,
  },
  {
    id: 'res-server',
    kind: 'Remote server',
    name: 'Remote execution server',
    detail: 'Server target for deployments, monitors, workers, and long-running jobs.',
    terms: ['cloud', 'deploy', 'host', 'monitor', 'server', 'vm', 'worker'],
  },
]

function makeId(prefix: string) {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10)
  return `${prefix}-${suffix}`
}

function agentTerminalStateKey(runId: string) {
  return `${AGENT_TERMINAL_STATE_PREFIX}${runId}`
}

function normalizePanelStates(value: unknown): Record<string, WorkspacePanelState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const states: Record<string, WorkspacePanelState> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const source = raw as Record<string, unknown>
    const state: WorkspacePanelState = {}
    if (typeof source.collapsed === 'boolean') state.collapsed = source.collapsed
    if (typeof source.fullWindow === 'boolean') state.fullWindow = source.fullWindow
    if (Object.keys(state).length) states[key] = state
  }
  return states
}

function layoutRunIdSet(value: unknown, validRunIds: Set<string>) {
  if (!Array.isArray(value)) return null
  return new Set(value.filter((id): id is string => typeof id === 'string' && validRunIds.has(id)))
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function compactText(value: string, max = 96) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1)}…`
}

async function copyToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function titleCase(words: string[]) {
  if (!words.length) return ''
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ')
}

function importantWords(message: string) {
  const stopWords = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'build',
    'by',
    'for',
    'from',
    'in',
    'into',
    'is',
    'it',
    'make',
    'my',
    'of',
    'on',
    'or',
    'our',
    'please',
    'set',
    'that',
    'the',
    'this',
    'to',
    'up',
    'with',
  ])

  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word))
}

function hasAnyTerm(message: string, terms: string[]) {
  const words = new Set(
    message
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  )

  return terms.some((term) => words.has(term.toLowerCase()))
}

function inferCategory(message: string) {
  return categoryRules.find((rule) => hasAnyTerm(message, rule.terms)) ?? {
    name: 'Operations',
    tags: ['ops', 'general', 'local'],
    terms: [],
  }
}

function deriveResources(message: string) {
  return resourceTemplates.filter((template) => template.always || hasAnyTerm(message, template.terms))
}

interface RunOverrides {
  category?: string
  project?: string
  workspace?: string
}

function tagsForCategory(name: string) {
  const match = categoryRules.find((rule) => rule.name.toLowerCase() === name.toLowerCase())
  if (match) return match.tags
  const slug = slugify(name)
  return slug ? [slug] : ['custom']
}

// Derive a conversation's metadata from its first prompt, honoring any
// context the user already set on the card (category / project / workspace).
function deriveRunFields(prompt: string, overrides: RunOverrides = {}) {
  const inferred = inferCategory(prompt)
  const categoryName = (overrides.category ?? '').trim() || inferred.name
  const categoryTags = (overrides.category ?? '').trim() ? tagsForCategory(categoryName) : inferred.tags

  const words = importantWords(prompt)
  const label = titleCase(words.slice(0, 3)) || `${categoryName} Flow`
  const project = (overrides.project ?? '').trim() || `${label} Project`
  const workspacePath = (overrides.workspace ?? '').trim() || DEFAULT_CWD

  return {
    prompt,
    category: categoryName,
    categoryTags,
    project,
    workspace: `${project} workspace`,
    workspacePath,
    job: 'Hermes run',
  }
}

function conversationTitle(run: RunNode) {
  return run.task.trim() || run.project.trim() || compactText(run.prompt, 48) || 'Untitled conversation'
}

function buildTurnTree(turns: TurnItem[]) {
  const nodes = new Map<string, TurnTreeNode>()
  const roots: TurnTreeNode[] = []

  for (const turn of turns) {
    nodes.set(turn.id, { turn, children: [] })
  }

  for (const turn of turns) {
    const node = nodes.get(turn.id)
    if (!node) continue

    const parentId = turn.parentTurnId ?? null
    const parent = parentId ? nodes.get(parentId) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  return roots
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function StatusPill({ state, detail }: { state: HermesConnectionState | JobStatus; detail: string }) {
  const tone =
    state === 'ready' || state === 'done'
      ? 'done'
      : state === 'busy' || state === 'running'
        ? 'running'
        : state === 'queued'
          ? 'queued'
          : state === 'error'
            ? 'error'
            : 'idle'

  return <span className={`pill ${tone}`}>{detail}</span>
}

function TreeRow({ label, value, depth }: { label: string; value: string; depth: number }) {
  return (
    <div className={`tree-row depth-${depth}`}>
      <span className="tree-label">{label}</span>
      <strong className="tree-value">{value}</strong>
    </div>
  )
}

function turnRoleLabel(status: JobStatus) {
  return status === 'queued' ? 'Queued' : status === 'error' ? 'Error' : status === 'done' ? 'Done' : 'Running'
}

function formatBytes(size: number | null): string {
  if (size == null) return ''
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

function filePathFromDrag(event: DragEvent<HTMLElement>) {
  return event.dataTransfer.getData('application/x-agent-rider-file-path') || event.dataTransfer.getData('text/plain')
}

function insertIntoTextarea(textarea: HTMLTextAreaElement, value: string) {
  const start = textarea.selectionStart ?? textarea.value.length
  const end = textarea.selectionEnd ?? textarea.value.length
  const prefix = textarea.value.slice(0, start)
  const suffix = textarea.value.slice(end)
  const needsLeadingSpace = Boolean(prefix && !/\s$/.test(prefix))
  const needsTrailingSpace = Boolean(suffix && !/^\s/.test(suffix))
  const inserted = `${needsLeadingSpace ? ' ' : ''}${value}${needsTrailingSpace ? ' ' : ''}`
  const nextValue = `${prefix}${inserted}${suffix}`
  const nextCursor = start + inserted.length
  textarea.focus()
  textarea.setRangeText(inserted, start, end, 'end')
  textarea.setSelectionRange(nextCursor, nextCursor)
  return nextValue
}

/**
 * Read-only file browser scoped to a conversation's workspace. Collapsed by default
 * and lazy-loaded on first expand. Navigation is bounded to the workspace subtree
 * (you can't browse above `rootPath`), and the backend further sandboxes to BROWSE_ROOT.
 */
function FileBrowser({ rootPath }: { rootPath: string }) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState(rootPath)
  const [listing, setListing] = useState<FsListing | null>(null)
  const [preview, setPreview] = useState<FsFilePreview | null>(null)
  const [previewFullWindow, setPreviewFullWindow] = useState(false)
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  async function load(target: string) {
    setLoading(true)
    setError(null)
    setPreview(null)
    setPreviewFullWindow(false)
    setPreviewError(null)
    // Fall back to the workspace root if the target can't be read.
    const result = (await listDir(target)) ?? (await listDir(rootPath))
    if (!result) {
      setError('Unable to read this folder.')
      setListing(null)
      setLoading(false)
      return
    }
    setListing(result)
    setPath(result.path)
    setLoading(false)
  }

  async function openFile(filePath: string) {
    setPreviewLoading(true)
    setPreviewError(null)
    const result = await readFilePreview(filePath)
    if ('error' in result) {
      setPreview(null)
      setPreviewFullWindow(false)
      setPreviewError(result.error)
    } else {
      setPreview(result)
    }
    setPreviewLoading(false)
  }

  // When the conversation's workspace changes, reset to its root (reload if open).
  useEffect(() => {
    setPath(rootPath)
    setListing(null)
    setPreview(null)
    setPreviewFullWindow(false)
    setPreviewError(null)
    if (open) void load(rootPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath])

  function toggleOpen() {
    const next = !open
    setOpen(next)
    if (next && !listing) void load(path)
  }

  // Only allow walking up while staying within the workspace subtree.
  const canGoUp = path !== rootPath && (path.startsWith(rootPath + '/') || rootPath === '/')
  const relLabel = path === rootPath ? '.' : path.startsWith(rootPath + '/') ? path.slice(rootPath.length + 1) : path

  return (
    <div className={`file-browser ${open ? 'open' : ''}`}>
      <button type="button" className="file-browser-toggle" onClick={toggleOpen} aria-expanded={open}>
        <span className={`file-browser-caret ${open ? 'open' : ''}`} aria-hidden>▾</span>
        <span className="tree-label">Files</span>
        {open ? <span className="file-browser-cwd" title={path}>{relLabel}</span> : null}
        <span className="file-browser-action">{open ? 'Hide' : 'Browse'}</span>
      </button>

      {open ? (
        <div className="file-browser-body">
          <div className="file-browser-bar">
            <button
              type="button"
              className="file-browser-up"
              disabled={!canGoUp || loading}
              onClick={() => listing?.parent && void load(listing.parent)}
              title={canGoUp ? 'Up one folder' : 'At workspace root'}
            >
              ↑ ..
            </button>
            <button
              type="button"
              className="file-browser-refresh"
              disabled={loading}
              onClick={() => void load(path)}
              title="Refresh"
            >
              ⟳
            </button>
          </div>

          {error ? <p className="error-text">{error}</p> : null}

          <div className="file-browser-list">
            {loading ? (
              <div className="file-browser-empty">Loading…</div>
            ) : listing && (listing.dirs.length || listing.files?.length) ? (
              <>
                {listing.dirs.map((dir) => (
                  <button
                    type="button"
                    key={dir.path}
                    className="file-row dir"
                    onClick={() => void load(dir.path)}
                    title={dir.name}
                  >
                    <span className="file-row-name">📁 {dir.name}</span>
                  </button>
                ))}
                {(listing.files ?? []).map((file) => (
                  <button
                    type="button"
                    key={file.path}
                    className={`file-row file ${preview?.path === file.path ? 'active' : ''}`}
                    title={file.path}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'copy'
                      event.dataTransfer.setData('application/x-agent-rider-file-path', file.path)
                      event.dataTransfer.setData('text/plain', file.path)
                    }}
                    onClick={() => void openFile(file.path)}
                  >
                    <span className="file-row-name">📄 {file.name}</span>
                    <span className="file-row-size">{formatBytes(file.size)}</span>
                  </button>
                ))}
              </>
            ) : (
              <div className="file-browser-empty">Empty folder.</div>
            )}
          </div>

          {previewLoading ? <div className="file-browser-empty">Opening file…</div> : null}
          {previewError ? <p className="error-text">{previewError}</p> : null}
          {preview ? (
            <div className={`file-preview ${previewFullWindow ? 'full-window' : ''}`}>
              <div className="file-preview-head">
                <div className="file-preview-title">
                  <strong>{preview.name}</strong>
                  <span>{preview.kind} · {formatBytes(preview.size)}</span>
                </div>
                <div className="file-preview-actions">
                  <button
                    type="button"
                    className="file-preview-icon-button"
                    title={previewFullWindow ? 'Exit full window' : 'Expand to full window'}
                    aria-label={previewFullWindow ? 'Exit full window' : 'Expand to full window'}
                    onClick={() => setPreviewFullWindow((current) => !current)}
                  >
                    {previewFullWindow ? '↙' : '⛶'}
                  </button>
                  <button
                    type="button"
                    className="file-preview-close"
                    onClick={() => {
                      setPreview(null)
                      setPreviewFullWindow(false)
                    }}
                    aria-label="Close file preview"
                  >
                    ×
                  </button>
                </div>
              </div>
              {preview.kind === 'image' ? (
                <div className="file-preview-media">
                  <img src={preview.dataUrl} alt={preview.name} />
                </div>
              ) : preview.kind === 'html' ? (
                <iframe
                  className="file-preview-html"
                  title={preview.name}
                  sandbox=""
                  srcDoc={preview.content ?? ''}
                />
              ) : preview.kind === 'markdown' ? (
                <div className="file-preview-markdown md-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content ?? ''}</ReactMarkdown>
                </div>
              ) : (
                <pre className={`file-preview-code ${preview.kind}`}><code>{preview.content ?? ''}</code></pre>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// Interactive areas that should keep their own mouse behaviour rather than
// starting a drag (shared by cards and workspace panels).
const DRAG_EXCLUDE = 'input, textarea, select, button, a, iframe, [contenteditable="true"], .conv-agent-terminal, .terminal-screen, .file-preview'

// Start an HTML5 drag using an off-screen clone of `element` as the ghost, so
// the ghost tracks the exact grab point (passing the live element is
// unreliable) and carries no box-shadow (which would offset it).
function beginElementDrag(event: DragEvent, element: HTMLElement | null, id: string) {
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', id)
  if (!element) return
  const rect = element.getBoundingClientRect()
  const clone = element.cloneNode(true) as HTMLElement
  clone.classList.add('drag-ghost')
  clone.style.position = 'fixed'
  clone.style.top = '0'
  clone.style.left = '-100000px'
  clone.style.width = `${rect.width}px`
  clone.style.height = `${rect.height}px`
  clone.style.margin = '0'
  clone.style.pointerEvents = 'none'
  clone.style.boxShadow = 'none'
  document.body.appendChild(clone)
  event.dataTransfer.setDragImage(clone, event.clientX - rect.left, event.clientY - rect.top)
  window.setTimeout(() => clone.remove(), 0)
}

// Wraps a workspace tool/app panel so it can be dragged to reorder among the
// other panels (same drag affordance as conversation cards).
function DraggablePanel({
  panelId,
  dragging,
  dragActive,
  onDragStartPanel,
  onDragEndPanel,
  onDropOnPanel,
  children,
}: {
  panelId: string
  dragging: boolean
  dragActive: boolean
  onDragStartPanel: () => void
  onDragEndPanel: () => void
  onDropOnPanel: (after: boolean) => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [dragOverAfter, setDragOverAfter] = useState(false)
  const dragOverAfterRef = useRef(false)
  return (
    <div
      ref={ref}
      className={`plugin-panel workspace-panel ${dragging ? 'dragging' : ''} ${dragOver ? (dragOverAfter ? 'drag-over after' : 'drag-over') : ''}`}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement
        if (ref.current) ref.current.draggable = !target.closest(DRAG_EXCLUDE)
      }}
      onDragStart={(event) => {
        const target = event.target as HTMLElement
        if (target.closest(DRAG_EXCLUDE)) {
          event.preventDefault()
          return
        }
        beginElementDrag(event, ref.current, panelId)
        onDragStartPanel()
      }}
      onDragEnd={() => {
        setDragOver(false)
        onDragEndPanel()
      }}
      onDragOver={(event) => {
        if (!dragActive) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        const after = event.clientY > rect.top + rect.height / 2
        dragOverAfterRef.current = after
        if (!dragOver) setDragOver(true)
        if (after !== dragOverAfter) setDragOverAfter(after)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return
        setDragOver(false)
      }}
      onDrop={(event) => {
        if (!dragActive) return
        event.preventDefault()
        event.stopPropagation()
        setDragOver(false)
        // Use the position computed during dragover (the drop event's clientY
        // is unreliable across browsers) so it matches the indicator shown.
        onDropOnPanel(dragOverAfterRef.current)
      }}
    >
      {children}
    </div>
  )
}

function ConversationCard({
  run,
  turns,
  collapsed,
  metaCollapsed,
  active,
  isNewDone,
  onToggle,
  onMetaCollapsedChange,
  onSend,
  onTitleChange,
  onCategoryChange,
  onProjectChange,
  onAgentChange,
  onOpenPicker,
  onClose,
  dragging,
  dragActive,
  onDragStartCard,
  onDragEndCard,
  onDropOnCard,
  agentTerminalState,
  onAgentTerminalStateChange,
}: {
  run: RunNode
  turns: TurnItem[]
  collapsed: boolean
  metaCollapsed: boolean
  active: boolean
  isNewDone: boolean
  onToggle: () => void
  onMetaCollapsedChange: (collapsed: boolean) => void
  onSend: (text: string, parentTurnId?: string | null) => void
  onTitleChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onProjectChange: (value: string) => void
  onAgentChange: (value: AgentType) => void
  onOpenPicker: () => void
  onClose: () => void
  /** True while THIS card is the one being dragged. */
  dragging: boolean
  /** True while SOME other card is being dragged (enables drop targets). */
  dragActive: boolean
  onDragStartCard: () => void
  onDragEndCard: () => void
  /** Drop the dragged card before (after=false) or after (after=true) this one. */
  onDropOnCard: (after: boolean) => void
  agentTerminalState?: WorkspacePanelState
  onAgentTerminalStateChange: (patch: WorkspacePanelState) => void
}) {
  const agentType: AgentType = run.agentType ?? 'hermes'
  const tui = isTuiAgent(agentType)
  const cardRef = useRef<HTMLElement | null>(null)
  const [dragOver, setDragOver] = useState(false)
  // Whether the hovering drop would land after (below) this card vs before.
  // Ref mirrors it for a staleness-free read in the drop handler.
  const [dragOverAfter, setDragOverAfter] = useState(false)
  const dragOverAfterRef = useRef(false)
  const [draft, setDraft] = useState('')
  const [askParentId, setAskParentId] = useState<string | null>(null)
  const [askDraft, setAskDraft] = useState('')
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null)
  const [collapsedTurnIds, setCollapsedTurnIds] = useState<Set<string>>(new Set())
  const turnTree = useMemo(() => buildTurnTree(turns), [turns])
  const status = run.jobStatus
  const isDraft = turns.length === 0
  const lastTurnId = turns.length ? turns[turns.length - 1].id : null
  const lastTurnRef = useRef<HTMLDivElement | null>(null)

  // Auto-hide past turns (keeping only the latest expanded) and scroll to it
  // whenever a new turn arrives.
  useEffect(() => {
    if (!lastTurnId) return
    setCollapsedTurnIds(new Set(turns.filter((turn) => turn.id !== lastTurnId).map((turn) => turn.id)))
    const frame = requestAnimationFrame(() => {
      lastTurnRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastTurnId])

  function hideAllTurns() {
    setCollapsedTurnIds(new Set(turns.map((turn) => turn.id)))
    setAskParentId(null)
    setAskDraft('')
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onSend(text)
  }

  function toggleTurnCollapsed(turnId: string) {
    setCollapsedTurnIds((current) => {
      const next = new Set(current)
      if (next.has(turnId)) next.delete(turnId)
      else next.add(turnId)
      return next
    })
    if (askParentId === turnId) {
      setAskParentId(null)
      setAskDraft('')
    }
  }

  function toggleTurnFromKey(event: KeyboardEvent<HTMLDivElement>, turnId: string) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggleTurnCollapsed(turnId)
  }

  function submitAskMore(event: FormEvent<HTMLFormElement>, parentTurnId: string) {
    event.preventDefault()
    const text = askDraft.trim()
    if (!text) return
    setAskDraft('')
    setAskParentId(null)
    onSend(text, parentTurnId)
  }

  async function copyPrompt(turn: TurnItem) {
    try {
      await copyToClipboard(turn.prompt)
      setCopiedTurnId(turn.id)
      window.setTimeout(() => {
        setCopiedTurnId((current) => (current === turn.id ? null : current))
      }, 1200)
    } catch {
      // Clipboard access can be blocked by browser settings.
    }
  }

  function renderTurnNode(node: TurnTreeNode, depth = 0): ReactNode {
    const { turn, children } = node
    const canAskMore = turn.status !== 'running' && turn.status !== 'queued'
    const isTurnCollapsed = collapsedTurnIds.has(turn.id)

    return (
      <div
        key={turn.id}
        ref={turn.id === lastTurnId ? lastTurnRef : undefined}
        className={`turn-node depth-${Math.min(depth, 4)}`}
      >
        <article className={`turn ${turn.status} ${isTurnCollapsed ? 'collapsed' : ''}`}>
          <div
            className={`bubble user turn-toggle ${isTurnCollapsed ? 'collapsed' : ''}`}
            role="button"
            tabIndex={0}
            aria-expanded={!isTurnCollapsed}
            onClick={() => toggleTurnCollapsed(turn.id)}
            onKeyDown={(event) => toggleTurnFromKey(event, turn.id)}
          >
            <div className="bubble-head">
              <span className="role-group">
                <span className={`turn-toggle-caret ${isTurnCollapsed ? '' : 'open'}`} aria-hidden>
                  ▾
                </span>
                <span className="role">You</span>
                <span className="turn-prompt-sep" aria-hidden>|</span>
                <span className="turn-prompt-text">{turn.prompt}</span>
              </span>
              <button
                type="button"
                className="copy-prompt-button"
                onKeyDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  void copyPrompt(turn)
                }}
              >
                {copiedTurnId === turn.id ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
          {!isTurnCollapsed ? (
            <div className="bubble assistant">
              <span className="role">Hermes · {turnRoleLabel(turn.status)}</span>
              <div className="md-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.response || '…'}</ReactMarkdown>
              </div>
              <div className="assistant-actions">
                <button
                  type="button"
                  className="ask-more-button"
                  disabled={!canAskMore}
                  onClick={() => {
                    setAskParentId(turn.id)
                    setAskDraft('')
                  }}
                >
                  Ask More
                </button>
              </div>
              {askParentId === turn.id ? (
                <form className="ask-more-form" onSubmit={(event) => submitAskMore(event, turn.id)}>
                  <textarea
                    value={askDraft}
                    onChange={(event) => setAskDraft(event.target.value)}
                    placeholder="Ask a follow-up from this reply…"
                    rows={2}
                    autoFocus
                  />
                  <div className="ask-more-controls">
                    <button
                      type="button"
                      className="ask-more-cancel"
                      onClick={() => {
                        setAskParentId(null)
                        setAskDraft('')
                      }}
                    >
                      Cancel
                    </button>
                    <button type="submit" className="send-button">
                      Send
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          ) : null}
        </article>
        {!isTurnCollapsed && children.length ? (
          <div className="turn-children">{children.map((child) => renderTurnNode(child, depth + 1))}</div>
        ) : null}
      </div>
    )
  }

  return (
    <article
      id={`conversation-${run.id}`}
      ref={cardRef}
      className={`conv-card ${collapsed ? 'collapsed' : ''} ${active ? 'active' : ''} ${dragging ? 'dragging' : ''} ${dragOver ? (dragOverAfter ? 'drag-over after' : 'drag-over') : ''}`}
      onMouseDown={(event) => {
        // Toggle draggable synchronously on the element so the browser's
        // drag-vs-select decision for THIS press is correct: off over inputs
        // (so they stay selectable), on everywhere else.
        const target = event.target as HTMLElement
        if (cardRef.current) cardRef.current.draggable = !target.closest(DRAG_EXCLUDE)
      }}
      onDragStart={(event) => {
        const target = event.target as HTMLElement
        if (target.closest(DRAG_EXCLUDE)) {
          event.preventDefault()
          return
        }
        beginElementDrag(event, cardRef.current, run.id)
        onDragStartCard()
      }}
      onDragEnd={() => {
        setDragOver(false)
        onDragEndCard()
      }}
      onDragOver={(event) => {
        if (!dragActive) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        const after = event.clientY > rect.top + rect.height / 2
        dragOverAfterRef.current = after
        if (!dragOver) setDragOver(true)
        if (after !== dragOverAfter) setDragOverAfter(after)
      }}
      onDragLeave={(event) => {
        // Ignore leaves into child elements.
        if (event.currentTarget.contains(event.relatedTarget as Node)) return
        setDragOver(false)
      }}
      onDrop={(event) => {
        if (!dragActive) return
        event.preventDefault()
        event.stopPropagation()
        setDragOver(false)
        // Use the position computed during dragover (the drop event's clientY
        // is unreliable across browsers) so it matches the indicator shown.
        onDropOnCard(dragOverAfterRef.current)
      }}
    >
      <div className="conv-card-head" onClick={onToggle}>
        <span
          className="conv-drag-handle"
          title="Drag anywhere on the card (except inputs) to reorder / move column"
          aria-hidden
          onClick={(event) => event.stopPropagation()}
        >
          ⠿
        </span>
        <div className="conv-card-titles">
          <span className="eyebrow">
            {timeLabel(run.createdAt)}
            {` · ${agentLabel(agentType)}`}
            {run.category ? ` · ${run.category}` : ''}
            {tui ? '' : isDraft ? ' · Draft' : ` · ${turns.length} ${turns.length === 1 ? 'turn' : 'turns'}`}
          </span>
          <input
            className="conv-title-input"
            value={run.task}
            onChange={(event) => onTitleChange(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            placeholder="Untitled conversation"
            aria-label="Conversation title"
          />
        </div>
        <div className="conv-card-status">
          {!isDraft && status === 'running' ? <span className="spinner" aria-label="Running" /> : null}
          {!isDraft && status === 'queued' ? <span className="chip">Queued</span> : null}
          {!isDraft && status === 'error' ? <span className="pill error">Error</span> : null}
          {isNewDone ? <span className="new-dot" title="New result" /> : null}
        </div>
        <span className={`conv-caret ${collapsed ? '' : 'open'}`} aria-hidden>▾</span>
        <button
          type="button"
          className="card-close"
          title="Close conversation card"
          aria-label="Close conversation card"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          ×
        </button>
      </div>

      {!collapsed ? (
        <div className="conv-card-body">
          <div className={`conv-meta ${metaCollapsed ? 'collapsed' : ''}`}>
            <button
              type="button"
              className="conv-meta-toggle"
              aria-expanded={!metaCollapsed}
              onClick={() => onMetaCollapsedChange(!metaCollapsed)}
            >
              <span className={`conv-meta-caret ${metaCollapsed ? '' : 'open'}`} aria-hidden>▾</span>
              <span className="conv-meta-toggle-label">Context</span>
              {metaCollapsed ? (
                <span className="conv-meta-summary">
                  {[run.category, run.project, agentLabel(agentType)].filter(Boolean).join(' · ') || 'Category · Project · Agent · Workspace'}
                </span>
              ) : null}
            </button>
            {metaCollapsed ? null : (
            <div className="conv-meta-fields">
            <div className="conv-meta-row">
              <span className="tree-label">Category</span>
              <input
                className="conv-input"
                list="known-categories"
                value={run.category}
                onChange={(event) => onCategoryChange(event.target.value)}
                placeholder="Auto from prompt — or type / pick"
              />
            </div>
            <div className="conv-meta-row">
              <span className="tree-label">Project</span>
              <input
                className="conv-input"
                list="known-projects"
                value={run.project}
                onChange={(event) => onProjectChange(event.target.value)}
                placeholder="Auto from prompt — or type / pick"
              />
            </div>
            <div className="conv-meta-row">
              <span className="tree-label">Agent</span>
              <select
                className="conv-input conv-agent-select"
                value={agentType}
                onChange={(event) => onAgentChange(event.target.value as AgentType)}
                aria-label="Conversation agent"
              >
                {AGENT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="conv-meta-row">
              <span className="tree-label">Workspace</span>
              <button type="button" className="conv-workspace-btn" onClick={onOpenPicker} title={run.workspacePath}>
                <span className="conv-workspace-path">{run.workspacePath}</span>
                <span className="conv-workspace-action">Change…</span>
              </button>
            </div>
            <FileBrowser rootPath={run.workspacePath} />
            </div>
            )}
          </div>

          {tui ? (
            <div className="conv-agent-terminal">
              <WebTerminal
                // Re-attach (not restart) on agent/workspace change — the tmux
                // session persists in the background, keyed by run + agent + cwd.
                key={`${agentType}:${run.workspacePath}`}
                agent={agentType}
                sessionKey={run.id}
                initialCwd={run.workspacePath}
                eyebrow={`Agent · ${agentLabel(agentType)} · persistent`}
                title={`${agentType} — interactive`}
                showClose={false}
                onClose={() => {}}
                collapsed={agentTerminalState?.collapsed}
                fullWindow={agentTerminalState?.fullWindow}
                onStateChange={onAgentTerminalStateChange}
              />
            </div>
          ) : (
            <>
              {turns.length ? (
                <div className="conversation-feed">
                  <div className="feed-toolbar">
                    <span className="feed-toolbar-label">
                      {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
                    </span>
                    <button
                      type="button"
                      className="hide-all-button"
                      onClick={hideAllTurns}
                      title="Collapse every turn in this conversation"
                    >
                      Hide All
                    </button>
                  </div>
                  {turnTree.map((node) => renderTurnNode(node))}
                </div>
              ) : null}

              <form className="composer conv-followup" onSubmit={submit}>
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={isDraft ? 'Describe the task to start this conversation…' : 'Reply in this conversation…'}
                  rows={2}
                />
                <div className="composer-meta">
                  <span>{run.workspacePath}</span>
                  <button type="submit" className="send-button">
                    Send
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      ) : null}
    </article>
  )
}

function ConversationTreeSidebar({
  tree,
  activeRunId,
  onSelect,
  onDeleteRequest,
}: {
  tree: ConversationTreeCategory[]
  activeRunId: string | null
  onSelect: (runId: string) => void
  onDeleteRequest: (runId: string) => void
}) {
  const total = tree.reduce((sum, category) => sum + category.projects.reduce((projectSum, project) => projectSum + project.runs.length, 0), 0)

  return (
    <nav className="conversation-sidebar card" aria-label="Conversation tree">
      <div className="sidebar-head">
        <div>
          <div className="eyebrow">Navigator</div>
          <h2>Conversation Tree</h2>
        </div>
        <span className="sidebar-count">{total}</span>
      </div>

      {tree.length ? (
        <div className="tree-nav">
          {tree.map((category) => (
            <section key={category.category} className="tree-nav-category">
              <h3>{category.category}</h3>
              {category.projects.map((project) => (
                <div key={`${category.category}-${project.project}`} className="tree-nav-project">
                  <div className="tree-nav-label">{project.project}</div>
                  <div className="tree-nav-runs">
                    {project.runs.map((run) => (
                      <div key={run.id} className="tree-nav-run-row">
                        <button
                          type="button"
                          className={`tree-nav-run ${activeRunId === run.id ? 'active' : ''}`}
                          onClick={() => onSelect(run.id)}
                          aria-current={activeRunId === run.id ? 'true' : undefined}
                        >
                          <span className="tree-run-title">{conversationTitle(run)}</span>
                          <span className={`tree-run-status ${run.jobStatus}`} aria-label={run.jobStatus} title={run.jobStatus} />
                        </button>
                        <button
                          type="button"
                          className="tree-run-delete card-close"
                          title="Delete conversation"
                          aria-label={`Delete ${conversationTitle(run)}`}
                          onClick={() => onDeleteRequest(run.id)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="tree-empty">No conversations</div>
      )}
    </nav>
  )
}

const EMPTY_APP_LISTING: AppListing = { apps: [], warnings: [], hash: '0' }

/**
 * Auto-discovers runtime Agent Apps from the store backend, polling every 5s and
 * on window focus. Uses the listing hash to skip no-op re-renders, so a launched
 * app's iframe is never disturbed by polling. Returns a `reorder` that persists a
 * new global order server-side.
 */
function useAgentApps(): {
  listing: AppListing
  reorder: (order: string[]) => void
  rename: (slug: string, label: string) => void
} {
  const [listing, setListing] = useState<AppListing>(EMPTY_APP_LISTING)
  const hashRef = useRef('0')

  useEffect(() => {
    let cancelled = false
    async function poll() {
      const next = await listApps()
      if (cancelled || next.hash === hashRef.current) return
      hashRef.current = next.hash
      setListing(next)
    }
    void poll()
    const id = window.setInterval(poll, 5000)
    const onFocus = () => void poll()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  function reorder(order: string[]) {
    void setAppOrder(order).then((next) => {
      hashRef.current = next.hash
      setListing(next)
    })
  }

  function rename(slug: string, label: string) {
    void renameApp(slug, label).then((next) => {
      hashRef.current = next.hash
      setListing(next)
    })
  }

  return { listing, reorder, rename }
}

function ResourceSidebar({
  terminalOpen,
  onLaunchTerminal,
  openPluginIds,
  onLaunchPlugin,
  apps,
  appWarnings,
  openAppSlugs,
  onLaunchApp,
  onReorderApps,
  onRenameApp,
}: {
  terminalOpen: boolean
  onLaunchTerminal: () => void
  openPluginIds: Set<string>
  onLaunchPlugin: (pluginId: string) => void
  apps: AgentApp[]
  appWarnings: AppWarning[]
  openAppSlugs: Set<string>
  onLaunchApp: (slug: string) => void
  onReorderApps: (order: string[]) => void
  onRenameApp: (slug: string, label: string) => void
}) {
  // Built-in tools plus every registered plugin, grouped by their sidebar heading.
  const groups = useMemo(() => {
    const byGroup = new Map<string, AgentRiderPlugin[]>()
    for (const plugin of plugins) {
      const group = plugin.group ?? 'Tools'
      const list = byGroup.get(group) ?? []
      list.push(plugin)
      byGroup.set(group, list)
    }
    return byGroup
  }, [])

  const pluginTools = groups.get('Tools') ?? []
  const extraGroups = [...groups.entries()].filter(([group]) => group !== 'Tools')

  return (
    <nav className="resource-sidebar card" aria-label="Resource view">
      <div className="sidebar-head">
        <div>
          <div className="eyebrow">Resource</div>
          <h2>Resources</h2>
        </div>
      </div>

      <div className="tree-nav">
        <section className="tree-nav-category">
          <h3>Tools</h3>
          <div className="tree-nav-runs">
            <button
              type="button"
              className={`tree-nav-run resource-tool ${terminalOpen ? 'active' : ''}`}
              onClick={onLaunchTerminal}
              title={terminalOpen ? 'Local Terminal is open' : 'Launch Local Terminal'}
            >
              <span className="tree-run-title">Local Terminal</span>
              <LaunchIcon open={terminalOpen} />
            </button>
            {pluginTools.map((plugin) => (
              <PluginTool
                key={plugin.id}
                plugin={plugin}
                open={openPluginIds.has(plugin.id)}
                onLaunch={() => onLaunchPlugin(plugin.id)}
              />
            ))}
          </div>
        </section>

        {extraGroups.map(([group, groupPlugins]) => (
          <section key={group} className="tree-nav-category">
            <h3>{group}</h3>
            <div className="tree-nav-runs">
              {groupPlugins.map((plugin) => (
                <PluginTool
                  key={plugin.id}
                  plugin={plugin}
                  open={openPluginIds.has(plugin.id)}
                  onLaunch={() => onLaunchPlugin(plugin.id)}
                />
              ))}
            </div>
          </section>
        ))}

        <section className="tree-nav-category">
          <h3>App</h3>
          <div className="tree-nav-runs">
            {apps.length ? (
              apps.map((app, index) => (
                <AppTool
                  key={app.id}
                  app={app}
                  open={openAppSlugs.has(app.id)}
                  canMoveUp={index > 0}
                  canMoveDown={index < apps.length - 1}
                  onLaunch={() => onLaunchApp(app.id)}
                  onMove={(delta) => onReorderApps(reorderSlugs(apps, index, delta))}
                  onRename={(label) => onRenameApp(app.id, label)}
                />
              ))
            ) : (
              <div className="tree-empty">No apps yet — ask an agent to build one.</div>
            )}
            {appWarnings.map((warning, index) => (
              <div key={`warn-${index}`} className="app-warning" role="alert">
                ⚠ {warning.id ?? warning.dir ?? 'plugin'}: {warning.error}
              </div>
            ))}
          </div>
        </section>
      </div>
    </nav>
  )
}

// Builds a new global slug order with the app at `index` moved by `delta` (±1).
function reorderSlugs(apps: AgentApp[], index: number, delta: number): string[] {
  const order = apps.map((app) => app.id)
  const target = index + delta
  if (target < 0 || target >= order.length) return order
  ;[order[index], order[target]] = [order[target], order[index]]
  return order
}

function AppTool({
  app,
  open,
  canMoveUp,
  canMoveDown,
  onLaunch,
  onMove,
  onRename,
}: {
  app: AgentApp
  open: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onLaunch: () => void
  onMove: (delta: number) => void
  onRename: (label: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(app.label)

  function startEdit() {
    setDraft(app.label)
    setEditing(true)
  }

  function commit() {
    const value = draft.trim()
    if (value && value !== app.label) onRename(value)
    setEditing(false)
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setEditing(false)
    }
  }

  return (
    <div className="app-tool">
      {editing ? (
        <input
          className="app-tool-rename-input"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          aria-label="App name"
        />
      ) : (
        <button
          type="button"
          className={`tree-nav-run resource-tool app-tool-launch ${open ? 'active' : ''}`}
          onClick={onLaunch}
          disabled={!app.hasDist}
          title={app.hasDist ? (open ? `${app.label} is open` : `Launch ${app.label}`) : `${app.label} is not built yet`}
        >
          <span className="tree-run-title">{app.label}</span>
          {app.hasDist ? <LaunchIcon open={open} /> : <span className="resource-tool-action">⏳</span>}
        </button>
      )}
      <span className="app-tool-actions">
        <button type="button" title="Rename" aria-label="Rename app" onClick={startEdit}>
          ✎
        </button>
        <button type="button" title="Move up" aria-label="Move up" disabled={!canMoveUp} onClick={() => onMove(-1)}>
          ↑
        </button>
        <button type="button" title="Move down" aria-label="Move down" disabled={!canMoveDown} onClick={() => onMove(1)}>
          ↓
        </button>
      </span>
    </div>
  )
}

// Compact launch indicator used across all Resource tools — a play glyph to
// launch, a filled dot once the panel is open. Saves the width of a text label.
function LaunchIcon({ open }: { open: boolean }) {
  return (
    <span className="resource-tool-action" aria-hidden>
      {open ? '●' : '▶'}
    </span>
  )
}

function PluginTool({ plugin, open, onLaunch }: { plugin: AgentRiderPlugin; open: boolean; onLaunch: () => void }) {
  return (
    <button
      type="button"
      className={`tree-nav-run resource-tool ${open ? 'active' : ''}`}
      onClick={onLaunch}
      title={open ? `${plugin.label} is open` : `Launch ${plugin.label}`}
    >
      <span className="tree-run-title">{plugin.label}</span>
      <LaunchIcon open={open} />
    </button>
  )
}

function WebTerminal({
  initialCwd,
  onClose,
  agent,
  sessionKey,
  eyebrow = 'Resource · Tools',
  title = 'Local Terminal',
  showClose = true,
  collapsed,
  fullWindow,
  onStateChange,
}: {
  initialCwd: string
  onClose: () => void
  /** When set, the PTY launches this TUI agent CLI instead of a login shell. */
  agent?: TuiAgentType
  /** Stable key for a persistent (tmux-backed) agent session that survives
   *  disconnects. Only meaningful together with `agent`. */
  sessionKey?: string
  eyebrow?: string
  title?: string
  showClose?: boolean
  collapsed?: boolean
  fullWindow?: boolean
  onStateChange?: (patch: WorkspacePanelState) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTermTerminal | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<() => void>(() => {})
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'closed' | 'error'>('connecting')
  const [terminalKey, setTerminalKey] = useState(0)
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const [internalFullWindow, setInternalFullWindow] = useState(false)
  const terminalCollapsed = collapsed ?? internalCollapsed
  const terminalFullWindow = fullWindow ?? internalFullWindow
  const agentTerminal = Boolean(agent)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new XTermTerminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      scrollback: 5000,
      theme: {
        background: '#050a12',
        foreground: '#d7e7f8',
        cursor: '#79b9ff',
        selectionBackground: '#1d4ed8',
      },
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)
    terminal.focus()
    terminalRef.current = terminal

    const fit = () => {
      try {
        fitAddon.fit()
        if (socketRef.current?.readyState === WebSocket.OPEN) {
          socketRef.current.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }))
        }
      } catch {
        // The terminal can be temporarily unmeasurable during layout changes.
      }
    }
    fitRef.current = fit

    window.requestAnimationFrame(fit)

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const agentParam = agent ? `&agent=${encodeURIComponent(agent)}` : ''
    const sessionParam = agent && sessionKey ? `&session=${encodeURIComponent(sessionKey)}` : ''
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/store/terminal/ws?cwd=${encodeURIComponent(initialCwd)}&cols=${terminal.cols}&rows=${terminal.rows}${agentParam}${sessionParam}`,
    )
    socketRef.current = socket
    setConnectionState('connecting')

    const inputDisposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }))
      }
    })

    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(container)
    window.addEventListener('resize', fit)

    socket.addEventListener('open', () => {
      setConnectionState('connected')
      fit()
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        terminal.write(event.data)
        return
      }
      if (event.data instanceof Blob) {
        void event.data.text().then((text) => terminal.write(text))
      }
    })
    socket.addEventListener('close', () => setConnectionState('closed'))
    socket.addEventListener('error', () => {
      setConnectionState('error')
      terminal.writeln('\r\n\x1b[31mTerminal connection error\x1b[0m')
    })

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', fit)
      inputDisposable.dispose()
      socket.close()
      terminal.dispose()
      if (socketRef.current === socket) socketRef.current = null
      if (terminalRef.current === terminal) terminalRef.current = null
    }
  }, [initialCwd, terminalKey, agent, sessionKey])

  useEffect(() => {
    if (!terminalCollapsed) window.requestAnimationFrame(() => fitRef.current())
  }, [terminalCollapsed, terminalFullWindow, terminalKey])

  function setTerminalCollapsedState(updater: boolean | ((current: boolean) => boolean)) {
    const next = typeof updater === 'function' ? updater(terminalCollapsed) : updater
    if (collapsed === undefined) setInternalCollapsed(next)
    onStateChange?.({ collapsed: next })
  }

  function setTerminalFullWindowState(updater: boolean | ((current: boolean) => boolean)) {
    const next = typeof updater === 'function' ? updater(terminalFullWindow) : updater
    if (fullWindow === undefined) setInternalFullWindow(next)
    onStateChange?.({ fullWindow: next })
  }

  function toggleTerminalFromKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    setTerminalCollapsedState((current) => !current)
  }

  return (
    <section className={`web-terminal ${terminalCollapsed ? 'collapsed' : ''} ${terminalFullWindow ? 'full-window' : ''}`} aria-label="Local Terminal">
      <div
        className="terminal-head"
        role="button"
        tabIndex={0}
        aria-expanded={!terminalCollapsed}
        onClick={() => setTerminalCollapsedState((current) => !current)}
        onKeyDown={toggleTerminalFromKey}
      >
        <span className={`terminal-caret ${terminalCollapsed ? '' : 'open'}`} aria-hidden>
          ▾
        </span>
        <div>
          <div className="eyebrow">{eyebrow}</div>
          <h2>{title}</h2>
        </div>
        <div className="terminal-actions">
          <span className={`terminal-state ${connectionState}`}>{connectionState}</span>
          <button
            type="button"
            className="terminal-icon-button"
            title={terminalFullWindow ? 'Exit full window' : 'Expand to full window'}
            aria-label={terminalFullWindow ? 'Exit full window' : 'Expand to full window'}
            onClick={(event) => {
              event.stopPropagation()
              setTerminalFullWindowState((current) => !current)
            }}
          >
            {terminalFullWindow ? '↙' : '⛶'}
          </button>
          {!agentTerminal ? (
            <button
              type="button"
              className="terminal-clear"
              onClick={(event) => {
                event.stopPropagation()
                setTerminalKey((current) => current + 1)
              }}
            >
              Restart
            </button>
          ) : null}
          {showClose ? (
            <button
              type="button"
              className="card-close"
              title="Close Local Terminal"
              aria-label="Close Local Terminal"
              onClick={(event) => {
                event.stopPropagation()
                onClose()
              }}
            >
              ×
            </button>
          ) : null}
        </div>
      </div>

      <div className="terminal-body" aria-hidden={terminalCollapsed}>
        <div
          className="terminal-screen"
          ref={containerRef}
          role="application"
          aria-label="Interactive shell terminal"
          onClick={() => terminalRef.current?.focus()}
        />

        <div className="terminal-footer">
          <span>{initialCwd === DEFAULT_TERMINAL_CWD ? '~/' : initialCwd}</span>
          <button
            type="button"
            className="terminal-clear"
            onClick={() => {
              if (agentTerminal) setTerminalKey((current) => current + 1)
              else terminalRef.current?.clear()
            }}
          >
            {agentTerminal ? 'Restart' : 'Clear'}
          </button>
        </div>
      </div>
    </section>
  )
}

function isBusyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /session busy|subagent still running|busy/i.test(message)
}

function WorkspacePicker({
  initialPath,
  onSelect,
  onClose,
}: {
  initialPath: string
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const [listing, setListing] = useState<FsListing | null>(null)
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function navigate(path?: string) {
    setLoading(true)
    setError(null)
    const result = await listDir(path)
    if (!result) {
      setError('Unable to read this folder.')
      setLoading(false)
      return
    }
    setListing(result)
    setLoading(false)
  }

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setError(null)
      // Fall back to the allowed root if the starting path doesn't exist yet.
      const result = (await listDir(initialPath)) ?? (await listDir(''))
      if (!result) {
        setError('Unable to read this folder.')
        setLoading(false)
        return
      }
      setListing(result)
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function createFolder() {
    if (!listing || !newName.trim()) return
    const result = await makeDir(listing.path, newName.trim())
    if ('error' in result) {
      setError(result.error)
      return
    }
    setNewName('')
    await navigate(result.path)
  }

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker" onClick={(event) => event.stopPropagation()}>
        <div className="picker-head">
          <div>
            <div className="eyebrow">Select workspace folder</div>
            <h3>{listing?.path ?? initialPath}</h3>
          </div>
          <button type="button" className="picker-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {error ? <p className="error-text">{error}</p> : null}

        <div className="picker-list">
          {listing?.parent ? (
            <button type="button" className="picker-row up" onClick={() => navigate(listing.parent!)}>
              ↑ ..
            </button>
          ) : null}
          {loading ? (
            <div className="picker-empty">Loading…</div>
          ) : listing && listing.dirs.length ? (
            listing.dirs.map((dir) => (
              <button type="button" key={dir.path} className="picker-row" onClick={() => navigate(dir.path)}>
                📁 {dir.name}
              </button>
            ))
          ) : (
            <div className="picker-empty">No subfolders here.</div>
          )}
        </div>

        <div className="picker-newfolder">
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="New folder name…"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void createFolder()
              }
            }}
          />
          <button type="button" className="picker-mkdir" onClick={createFolder} disabled={!newName.trim()}>
            Create
          </button>
        </div>

        <div className="picker-actions">
          <button type="button" className="picker-cancel" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="send-button"
            onClick={() => listing && onSelect(listing.path)}
            disabled={!listing}
          >
            Use this folder
          </button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const bridgeRef = useRef<HermesBridge | null>(null)
  const activeTurnRef = useRef<string | null>(null)
  const activeRunRef = useRef<string | null>(null)
  const hydratedRef = useRef(false)
  const queuedPromptsRef = useRef<QueuedPromptEntry[]>([])
  const assistantBufferRef = useRef('')
  // Each conversation (run) keeps its own Hermes session for multi-turn context.
  const sessionByRunRef = useRef<Map<string, string>>(new Map())

  const [initialized, setInitialized] = useState(false)
  const [turns, setTurns] = useState<TurnItem[]>([])
  const [runs, setRuns] = useState<RunNode[]>([])
  const [resources, setResources] = useState<ResourceItem[]>([])
  const [connectionState, setConnectionState] = useState<HermesConnectionState>('disconnected')
  const [connectionDetail, setConnectionDetail] = useState('Disconnected')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionInfoText, setSessionInfoText] = useState('No Hermes session yet')
  const [queuedCount, setQueuedCount] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // Per-conversation UI state.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [metaCollapsedIds, setMetaCollapsedIds] = useState<Set<string>>(new Set())
  const [newDoneIds, setNewDoneIds] = useState<Set<string>>(new Set())
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [workspaceColumns, setWorkspaceColumns] = useState<1 | 2>(1)
  // Key of the block (card or panel) currently being dragged. Block keys: a
  // run id (`run-…`) for a card, or a panel id ('terminal' | 'plugin:…' |
  // 'app:…'). One drag system so cards and panels can be freely interleaved.
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  // Unified display order of all blocks (cards + panels) across both columns.
  // Persisted in layout.layoutOrder; column membership is per-block (run.column
  // for cards, panelColumns for panels). New blocks append at the end.
  const [layoutOrder, setLayoutOrder] = useState<string[]>([])
  // Which conversation's workspace picker is open (null = closed).
  const [pickerRunId, setPickerRunId] = useState<string | null>(null)
  const [deletePromptRunId, setDeletePromptRunId] = useState<string | null>(null)
  // Closed (hidden) conversation cards — re-launchable from the Navigator.
  const [closedRunIds, setClosedRunIds] = useState<Set<string>>(new Set())
  // Whether the Local Terminal window is open — re-launchable from Resources.
  // Single source of truth for which workspace panels are open AND their order.
  // Panel ids: 'terminal', `plugin:<id>`, `app:<slug>`. The conversation cards
  // column renders after these. Persisted as layout.panelOrder so the whole
  // arrangement survives a reload.
  const [panelOrder, setPanelOrder] = useState<string[]>([])
  // Which column (0 = left, 1 = right) each panel sits in, so panels can be
  // dragged to sit side-by-side with conversation cards in two-column mode.
  const [panelColumns, setPanelColumns] = useState<Record<string, number>>({})
  // Collapsed/full-window chrome state for Tools and Apps, keyed by panel id.
  const [panelStates, setPanelStates] = useState<Record<string, WorkspacePanelState>>({})
  // Runtime Agent Apps (auto-discovered from the store backend).
  const { listing: appListing, reorder: reorderApps, rename: renameAppLabel } = useAgentApps()

  const terminalOpen = panelOrder.includes('terminal')
  const openPluginIds = useMemo(
    () => new Set(panelOrder.filter((p) => p.startsWith('plugin:')).map((p) => p.slice('plugin:'.length))),
    [panelOrder],
  )
  const openAppSlugs = useMemo(
    () => new Set(panelOrder.filter((p) => p.startsWith('app:')).map((p) => p.slice('app:'.length))),
    [panelOrder],
  )

  function openPanel(panelId: string) {
    setPanelOrder((current) => (current.includes(panelId) ? current : [...current, panelId]))
    setPanelStates((current) => {
      const state = current[panelId]
      if (!state || (!state.collapsed && !state.fullWindow)) return current
      return { ...current, [panelId]: { ...state, collapsed: false, fullWindow: false } }
    })
  }
  function closePanel(panelId: string) {
    setPanelOrder((current) => current.filter((p) => p !== panelId))
  }
  const launchPlugin = (pluginId: string) => openPanel(`plugin:${pluginId}`)
  const closePlugin = (pluginId: string) => closePanel(`plugin:${pluginId}`)
  const launchApp = (slug: string) => openPanel(`app:${slug}`)
  const closeApp = (slug: string) => closePanel(`app:${slug}`)

  function setPanelColumn(panelId: string, column: number) {
    setPanelColumns((current) => ({ ...current, [panelId]: column }))
  }

  function updatePanelState(panelId: string, patch: WorkspacePanelState) {
    setPanelStates((current) => {
      const nextState = { ...(current[panelId] ?? {}), ...patch }
      const normalized: WorkspacePanelState = {}
      if (typeof nextState.collapsed === 'boolean') normalized.collapsed = nextState.collapsed
      if (typeof nextState.fullWindow === 'boolean') normalized.fullWindow = nextState.fullWindow
      return { ...current, [panelId]: normalized }
    })
  }

  function setMetaCollapsed(runId: string, collapsed: boolean) {
    setMetaCollapsedIds((current) => {
      const next = new Set(current)
      if (collapsed) next.add(runId)
      else next.delete(runId)
      return next
    })
  }

  const hasContent = runs.length > 0
  // Cards hidden via their close button drop out of the stack but stay in the tree.
  const visibleRuns = useMemo(() => runs.filter((run) => !closedRunIds.has(run.id)), [runs, closedRunIds])

  function toggleCollapse(runId: string) {
    setActiveRunId(runId)
    setCollapsedIds((current) => {
      const next = new Set(current)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
    // Expanding (or interacting with) a card clears its "new result" dot.
    setNewDoneIds((current) => {
      if (!current.has(runId)) return current
      const next = new Set(current)
      next.delete(runId)
      return next
    })
  }

  // Open a new, empty (draft) Conversation Card at the top of the stack.
  function startNewConversation() {
    const run: RunNode = {
      id: makeId('run'),
      prompt: '',
      category: '',
      categoryTags: [],
      project: '',
      workspace: '',
      workspacePath: DEFAULT_CWD,
      task: '',
      job: 'Draft',
      jobStatus: 'queued',
      resourceIds: [],
      sessionId: null,
      agentType: 'hermes',
      column: 0,
      createdAt: new Date().toISOString(),
    }
    setRuns((current) => [run, ...current])
    setActiveRunId(run.id)
  }

  // Edit a conversation's Category / Project / Workspace in place.
  function updateRunContext(runId: string, patch: Partial<RunNode>) {
    setRuns((current) => current.map((run) => (run.id === runId ? { ...run, ...patch } : run)))
  }

  function updateRunProject(runId: string, project: string) {
    setRuns((current) =>
      current.map((run) => {
        if (run.id !== runId) return run
        const titleFollowsProject = !run.task.trim() || run.task.trim() === run.project.trim()
        return { ...run, project, task: titleFollowsProject ? project : run.task }
      }),
    )
  }

  function changeRunWorkspace(runId: string, path: string) {
    // Hermes can't move a live session's cwd, so reset this conversation's
    // session — the next turn runs in the newly chosen folder.
    sessionByRunRef.current.delete(runId)
    updateRunContext(runId, { workspacePath: path, sessionId: null })
  }

  // ── Unified block ordering (cards + panels) ────────────────────────────────
  const isCardKey = (key: string) => key.startsWith('run-')
  const columnOf = (key: string) =>
    isCardKey(key) ? runs.find((run) => run.id === key)?.column ?? 0 : panelColumns[key] ?? 0
  const setColumnOf = (key: string, column: number) => {
    if (isCardKey(key)) updateRunContext(key, { column })
    else setPanelColumn(key, column)
  }

  // The display order of every visible block. Honors layoutOrder, then appends
  // any newly-added block (card/panel) not yet placed.
  const orderedKeys = useMemo(() => {
    const live = [...panelOrder, ...visibleRuns.map((run) => run.id)]
    const liveSet = new Set(live)
    const placed = layoutOrder.filter((key) => liveSet.has(key))
    const placedSet = new Set(placed)
    const missing = live.filter((key) => !placedSet.has(key))
    return [...placed, ...missing]
  }, [panelOrder, visibleRuns, layoutOrder])

  function reorderKeys(keys: string[], draggedKey: string, targetKey: string | null, after: boolean) {
    const without = keys.filter((k) => k !== draggedKey)
    if (!targetKey) return [...without, draggedKey]
    let idx = without.indexOf(targetKey)
    if (idx < 0) return [...without, draggedKey]
    if (after) idx += 1
    return [...without.slice(0, idx), draggedKey, ...without.slice(idx)]
  }

  // Drop the dragged block before/after a target block (any mix of card/panel),
  // inheriting the target's column in two-column mode.
  function handleDropOnBlock(targetKey: string, after: boolean) {
    if (!draggingKey || draggingKey === targetKey) return
    if (workspaceColumns === 2) setColumnOf(draggingKey, columnOf(targetKey))
    setLayoutOrder(reorderKeys(orderedKeys, draggingKey, targetKey, after))
    setDraggingKey(null)
  }

  // Drop onto a column's empty space → append to the end of that column.
  function handleDropToColumn(column: number) {
    if (!draggingKey) return
    if (workspaceColumns === 2) setColumnOf(draggingKey, column)
    setLayoutOrder(reorderKeys(orderedKeys, draggingKey, null, false))
    setDraggingKey(null)
  }

  // Known values for the Category/Project comboboxes: built-ins + anything seen in history.
  const knownCategories = useMemo(() => {
    const set = new Set<string>(categoryRules.map((rule) => rule.name))
    for (const run of runs) if (run.category) set.add(run.category)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [runs])

  // Group turns by conversation, oldest first within each card.
  const turnsByRun = useMemo(() => {
    const map = new Map<string, TurnItem[]>()
    for (const turn of turns) {
      const list = map.get(turn.runId) ?? []
      list.push(turn)
      map.set(turn.runId, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return map
  }, [turns])

  const knownProjects = useMemo(() => {
    const set = new Set<string>()
    for (const run of runs) if (run.project) set.add(run.project)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [runs])

  const deleteTargetRun = useMemo(
    () => (deletePromptRunId ? runs.find((run) => run.id === deletePromptRunId) ?? null : null),
    [deletePromptRunId, runs],
  )

  const conversationTree = useMemo<ConversationTreeCategory[]>(() => {
    const categoryMap = new Map<string, Map<string, RunNode[]>>()

    for (const run of runs) {
      const category = run.category.trim() || 'Uncategorized'
      const project = run.project.trim() || 'No project'
      let projectMap = categoryMap.get(category)
      if (!projectMap) {
        projectMap = new Map()
        categoryMap.set(category, projectMap)
      }
      const projectRuns = projectMap.get(project) ?? []
      projectRuns.push(run)
      projectMap.set(project, projectRuns)
    }

    return Array.from(categoryMap, ([category, projectMap]) => ({
      category,
      projects: Array.from(projectMap, ([project, projectRuns]) => ({ project, runs: projectRuns })),
    }))
  }, [runs])

  function closeConversation(runId: string) {
    setClosedRunIds((current) => {
      const next = new Set(current)
      next.add(runId)
      return next
    })
  }

  function requestDeleteConversation(runId: string) {
    setDeletePromptRunId(runId)
  }

  function deleteConversation(runId: string) {
    if (activeRunRef.current === runId) {
      activeRunRef.current = null
      activeTurnRef.current = null
      assistantBufferRef.current = ''
    }

    if (pickerRunId === runId) {
      setPickerRunId(null)
    }

    if (activeRunId === runId) {
      setActiveRunId(null)
    }

    sessionByRunRef.current.delete(runId)
    queuedPromptsRef.current = queuedPromptsRef.current.filter((entry) => entry.runId !== runId)
    setQueuedCount(queuedPromptsRef.current.length)

    setRuns((current) => current.filter((run) => run.id !== runId))
    setTurns((current) => current.filter((turn) => turn.runId !== runId))
    setClosedRunIds((current) => {
      if (!current.has(runId)) return current
      const next = new Set(current)
      next.delete(runId)
      return next
    })
    setCollapsedIds((current) => {
      if (!current.has(runId)) return current
      const next = new Set(current)
      next.delete(runId)
      return next
    })
    setMetaCollapsedIds((current) => {
      if (!current.has(runId)) return current
      const next = new Set(current)
      next.delete(runId)
      return next
    })
    setNewDoneIds((current) => {
      if (!current.has(runId)) return current
      const next = new Set(current)
      next.delete(runId)
      return next
    })
    setLayoutOrder((current) => current.filter((key) => key !== runId))
    setPanelStates((current) => {
      const key = agentTerminalStateKey(runId)
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
  }

  function selectConversation(runId: string) {
    setActiveRunId(runId)
    // Clicking a card in the Navigator re-launches it if it was closed.
    setClosedRunIds((current) => {
      if (!current.has(runId)) return current
      const next = new Set(current)
      next.delete(runId)
      return next
    })
    setCollapsedIds((current) => {
      if (!current.has(runId)) return current
      const next = new Set(current)
      next.delete(runId)
      return next
    })
    setNewDoneIds((current) => {
      if (!current.has(runId)) return current
      const next = new Set(current)
      next.delete(runId)
      return next
    })
    window.requestAnimationFrame(() => {
      document.getElementById(`conversation-${runId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  useEffect(() => {
    const bridge = new HermesBridge({ title: DEFAULT_TITLE, cwd: DEFAULT_CWD, source: 'web' })
    bridgeRef.current = bridge

    const removeStatus = bridge.onStatus((state, detail) => {
      setConnectionState(state)
      setConnectionDetail(detail)
    })

    const removeEvent = bridge.onEvent((event) => {
      if (event.type === 'gateway.ready') {
        const skin = String(event.payload?.skin ?? '').trim()
        if (skin) setSessionInfoText(`Hermes gateway ready · skin ${skin}`)
        return
      }

      if (event.type === 'session.info') {
        const info = event.payload ?? {}
        const infoParts = [
          String(info.model ?? '').trim(),
          String(info.cwd ?? '').trim(),
          String(info.branch ?? '').trim(),
        ].filter(Boolean)
        if (infoParts.length) setSessionInfoText(infoParts.join(' · '))
        const maybeSessionId = String(info.session_id ?? event.session_id ?? '').trim()
        if (maybeSessionId) setSessionId(maybeSessionId)
        return
      }

      if (event.type === 'status.update') {
        const text = String(event.payload?.text ?? '').trim()
        if (text) setConnectionDetail(text)
        return
      }

      if (event.type === 'message.delta') {
        const delta = String(event.payload?.text ?? '')
        if (!delta) return
        assistantBufferRef.current += delta
        const turnId = activeTurnRef.current
        if (!turnId) return
        setTurns((current) =>
          current.map((turn) => (turn.id === turnId ? { ...turn, response: assistantBufferRef.current, status: 'running' } : turn)),
        )
        return
      }

      if (event.type === 'message.complete') {
        const turnId = activeTurnRef.current
        if (turnId) {
          setTurns((current) =>
            current.map((turn) =>
              turn.id === turnId
                ? { ...turn, response: assistantBufferRef.current.trim() || turn.response, status: 'done' }
                : turn,
            ),
          )
        }

        const runId = activeRunRef.current
        if (runId) {
          setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'done' } : item)))
          // Flag a "new result" dot on the card (cleared when the user opens it).
          setNewDoneIds((current) => {
            const next = new Set(current)
            next.add(runId)
            return next
          })
        }

        activeTurnRef.current = null
        activeRunRef.current = null
        assistantBufferRef.current = ''
        setConnectionState('ready')
        setConnectionDetail('Assistant response complete')
        void flushQueue()
      }

      if (event.type === 'message.error') {
        const message = String(event.payload?.error ?? 'Hermes stream error')
        const turnId = activeTurnRef.current
        const runId = activeRunRef.current
        if (turnId) {
          setTurns((current) =>
            current.map((turn) =>
              turn.id === turnId
                ? { ...turn, response: assistantBufferRef.current.trim() || message, status: 'error' }
                : turn,
            ),
          )
        }
        if (runId) {
          setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'error' } : item)))
        }
        setError(message)
        activeTurnRef.current = null
        activeRunRef.current = null
        assistantBufferRef.current = ''
        void flushQueue()
      }
    })

    void bridge.connect().catch((error) => {
      setError(error instanceof Error ? error.message : String(error))
    })

    setInitialized(true)

    return () => {
      removeEvent()
      removeStatus()
      bridge.close()
    }
  }, [])

  // Hydrate persisted interaction data from the local SQLite backend on mount.
  useEffect(() => {
    let cancelled = false
    void loadPersistedState().then((state) => {
      if (cancelled) return
      if (state) {
        const layout = state.layout
        // Merge defensively: never clobber content the user already created this session.
        if (state.runs.length) {
          // Default agentType for runs persisted before the field existed.
          const restored = (state.runs as RunNode[]).map((run) => ({
            ...run,
            agentType: run.agentType ?? 'hermes',
            column: Number.isFinite(run.column) ? run.column : 0,
          }))
          const restoredRunIds = new Set(restored.map((run) => run.id))
          setRuns((current) => (current.length ? current : restored))
          const restoredClosedRunIds = layoutRunIdSet(layout?.closedRunIds, restoredRunIds)
          if (restoredClosedRunIds) {
            setClosedRunIds((current) => (current.size ? current : restoredClosedRunIds))
          } else {
            // Legacy default for saves made before card visibility was persisted.
            setClosedRunIds((current) =>
              current.size ? current : new Set(restored.slice(1).map((run) => run.id)),
            )
          }
          const restoredCollapsedRunIds = layoutRunIdSet(layout?.collapsedRunIds, restoredRunIds)
          if (restoredCollapsedRunIds) {
            setCollapsedIds((current) => (current.size ? current : restoredCollapsedRunIds))
          }
          const restoredMetaCollapsedRunIds = layoutRunIdSet(layout?.cardMetaCollapsedIds, restoredRunIds)
          if (restoredMetaCollapsedRunIds) {
            setMetaCollapsedIds((current) => (current.size ? current : restoredMetaCollapsedRunIds))
          }
          // Restore each conversation's Hermes session so follow-ups continue the same thread.
          for (const run of restored) {
            if (run.sessionId) sessionByRunRef.current.set(run.id, run.sessionId)
          }
        }
        if (state.turns.length) setTurns((current) => (current.length ? current : (state.turns as TurnItem[])))
        // Restore the workspace layout: which tool/app panels were open, their
        // order, and the column count.
        if (layout) {
          if (Array.isArray(layout.panelOrder)) {
            setPanelOrder((current) => (current.length ? current : (layout.panelOrder as string[])))
          }
          if (layout.panelColumns && typeof layout.panelColumns === 'object') {
            setPanelColumns((current) => (Object.keys(current).length ? current : (layout.panelColumns as Record<string, number>)))
          }
          if (Array.isArray(layout.layoutOrder)) {
            setLayoutOrder((current) => (current.length ? current : (layout.layoutOrder as string[])))
          }
          if (layout.workspaceColumns === 1 || layout.workspaceColumns === 2) {
            setWorkspaceColumns(layout.workspaceColumns)
          }
          if (layout.panelStates && typeof layout.panelStates === 'object') {
            setPanelStates((current) => (Object.keys(current).length ? current : normalizePanelStates(layout.panelStates)))
          }
        }
      }
      hydratedRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Debounced auto-save of runs/turns + layout to the local SQLite backend.
  useEffect(() => {
    if (!hydratedRef.current) return
    const handle = setTimeout(() => {
      void persistState(runs, turns, sessionId, {
        panelOrder,
        panelColumns,
        layoutOrder,
        workspaceColumns,
        closedRunIds: [...closedRunIds],
        collapsedRunIds: [...collapsedIds],
        cardMetaCollapsedIds: [...metaCollapsedIds],
        panelStates,
      })
    }, 700)
    return () => clearTimeout(handle)
  }, [runs, turns, sessionId, panelOrder, panelColumns, layoutOrder, workspaceColumns, closedRunIds, collapsedIds, metaCollapsedIds, panelStates])

  const summaryLine = useMemo(() => {
    if (!initialized) return 'Preparing Hermes bridge…'
    if (sessionId) return `Session ${sessionId}`
    return 'Waiting for first chat to create a Hermes session'
  }, [initialized, sessionId])

  async function flushQueue() {
    if (activeTurnRef.current) return
    const nextEntry = queuedPromptsRef.current.shift()
    setQueuedCount(queuedPromptsRef.current.length)
    if (!nextEntry) return
    await startTurn(nextEntry)
  }

  async function startTurn(entry: QueuedPromptEntry) {
    const bridge = bridgeRef.current
    if (!bridge) return

    const { turnId, runId, prompt, workspace } = entry

    activeTurnRef.current = turnId
    activeRunRef.current = runId
    assistantBufferRef.current = ''
    try {
      // Reuse this conversation's session, or create one rooted at its workspace.
      let session = sessionByRunRef.current.get(runId)
      if (!session) {
        session = await bridge.createSession(workspace)
        sessionByRunRef.current.set(runId, session)
        setRuns((current) => current.map((item) => (item.id === runId ? { ...item, sessionId: session ?? null } : item)))
      }
      setSessionId(session)
      setSessionInfoText(`Hermes session ${session}`)
      await bridge.submitPrompt(session, prompt, workspace)
      setConnectionState('busy')
      setConnectionDetail('Hermes is running…')
      setTurns((current) => current.map((item) => (item.id === turnId ? { ...item, status: 'running', response: 'Thinking…' } : item)))
      setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'running' } : item)))
    } catch (error) {
      if (isBusyError(error)) {
        queuedPromptsRef.current.push(entry)
        setQueuedCount(queuedPromptsRef.current.length)
        setTurns((current) => current.map((item) => (item.id === turnId ? { ...item, status: 'queued', response: 'Queued until Hermes finishes the current turn…' } : item)))
        setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'queued' } : item)))
        activeTurnRef.current = null
        activeRunRef.current = null
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      setError(message)
      setConnectionState('error')
      setConnectionDetail(message)
      activeTurnRef.current = null
      activeRunRef.current = null
      setTurns((current) => current.map((item) => (item.id === turnId ? { ...item, status: 'error', response: message } : item)))
      setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'error' } : item)))
    }
  }

  // Queue a turn if Hermes is busy, otherwise start it immediately.
  function enqueueOrStart(entry: QueuedPromptEntry) {
    const busy = connectionState === 'busy' || activeTurnRef.current !== null
    if (busy) {
      queuedPromptsRef.current.push(entry)
      setQueuedCount(queuedPromptsRef.current.length)
      setTurns((current) => current.map((item) => (item.id === entry.turnId ? { ...item, status: 'queued', response: 'Queued until Hermes is ready…' } : item)))
      setRuns((current) => current.map((item) => (item.id === entry.runId ? { ...item, jobStatus: 'queued' } : item)))
      return
    }
    void startTurn(entry)
  }

  function newTurn(runId: string, prompt: string, parentTurnId: string | null = null): { turn: TurnItem; turnId: string } {
    const turnId = makeId('turn')
    return {
      turnId,
      turn: {
        id: turnId,
        prompt,
        response: 'Thinking…',
        status: 'running',
        runId,
        parentTurnId,
        createdAt: new Date().toISOString(),
      },
    }
  }

  // Send a message inside a conversation card. The first turn derives the
  // card's metadata from the prompt (honoring any context the user set).
  function sendInConversation(runId: string, prompt: string, parentTurnId: string | null = null) {
    if (!bridgeRef.current) {
      setError('Hermes bridge is not ready yet.')
      return
    }
    const run = runs.find((item) => item.id === runId)
    if (!run) return

    setActiveRunId(runId)
    const hasTurns = turns.some((turn) => turn.runId === runId)
    let workspace = run.workspacePath
    if (!hasTurns) {
      const fields = deriveRunFields(prompt, {
        category: run.category,
        project: run.project,
        workspace: run.workspacePath,
      })
      workspace = fields.workspacePath
      setRuns((current) =>
        current.map((item) =>
          item.id === runId ? { ...item, ...fields, task: item.task.trim() || fields.project, jobStatus: 'running' } : item,
        ),
      )
    } else {
      setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'running' } : item)))
    }

    const { turn, turnId } = newTurn(runId, prompt, parentTurnId)
    setTurns((current) => [turn, ...current])
    setError(null)
    enqueueOrStart({ turnId, runId, prompt, workspace })
  }

  const renderRunCard = (run: RunNode) => (
    <ConversationCard
      key={run.id}
      run={run}
      turns={turnsByRun.get(run.id) ?? []}
      collapsed={collapsedIds.has(run.id)}
      metaCollapsed={metaCollapsedIds.has(run.id)}
      active={activeRunId === run.id}
      isNewDone={newDoneIds.has(run.id)}
      dragging={draggingKey === run.id}
      dragActive={draggingKey !== null && draggingKey !== run.id}
      onDragStartCard={() => setDraggingKey(run.id)}
      onDragEndCard={() => setDraggingKey(null)}
      onDropOnCard={(after) => handleDropOnBlock(run.id, after)}
      onToggle={() => toggleCollapse(run.id)}
      onMetaCollapsedChange={(collapsed) => setMetaCollapsed(run.id, collapsed)}
      onSend={(text, parentTurnId) => sendInConversation(run.id, text, parentTurnId ?? null)}
      onTitleChange={(value) => updateRunContext(run.id, { task: value })}
      onCategoryChange={(value) => updateRunContext(run.id, { category: value, categoryTags: tagsForCategory(value) })}
      onProjectChange={(value) => updateRunProject(run.id, value)}
      onAgentChange={(value) => updateRunContext(run.id, { agentType: value })}
      onOpenPicker={() => setPickerRunId(run.id)}
      onClose={() => closeConversation(run.id)}
      agentTerminalState={panelStates[agentTerminalStateKey(run.id)]}
      onAgentTerminalStateChange={(patch) => updatePanelState(agentTerminalStateKey(run.id), patch)}
    />
  )

  // Resolve a panel id to its content + draggable wrapper (null if the
  // referenced plugin/app no longer exists).
  const renderPanelBlock = (panelId: string) => {
    let content: ReactNode = null
    if (panelId === 'terminal') {
      content = (
        <WebTerminal
          initialCwd={DEFAULT_TERMINAL_CWD}
          onClose={() => closePanel('terminal')}
          collapsed={panelStates[panelId]?.collapsed}
          fullWindow={panelStates[panelId]?.fullWindow}
          onStateChange={(patch) => updatePanelState(panelId, patch)}
        />
      )
    } else if (panelId.startsWith('plugin:')) {
      const plugin = plugins.find((p) => p.id === panelId.slice('plugin:'.length))
      if (plugin) {
        content = plugin.renderPanel({
          onClose: () => closePanel(panelId),
          panelState: panelStates[panelId],
          onPanelStateChange: (patch) => updatePanelState(panelId, patch),
        })
      }
    } else if (panelId.startsWith('app:')) {
      const app = appListing.apps.find((a) => a.id === panelId.slice('app:'.length))
      if (app) {
        content = (
          <WebView
            title={app.label}
            src={app.entry}
            onClose={() => closePanel(panelId)}
            collapsed={panelStates[panelId]?.collapsed}
            fullWindow={panelStates[panelId]?.fullWindow}
            onStateChange={(patch) => updatePanelState(panelId, patch)}
          />
        )
      }
    }
    if (!content) return null
    return (
      <DraggablePanel
        key={panelId}
        panelId={panelId}
        dragging={draggingKey === panelId}
        dragActive={draggingKey !== null && draggingKey !== panelId}
        onDragStartPanel={() => setDraggingKey(panelId)}
        onDragEndPanel={() => setDraggingKey(null)}
        onDropOnPanel={(after) => handleDropOnBlock(panelId, after)}
      >
        {content}
      </DraggablePanel>
    )
  }

  // Render one block (card or panel) by key.
  const renderBlock = (key: string) => {
    if (isCardKey(key)) {
      const run = visibleRuns.find((r) => r.id === key)
      return run ? renderRunCard(run) : null
    }
    return renderPanelBlock(key)
  }

  // One workspace column: its blocks (cards + panels interleaved) in display
  // order. `col` filters by column in two-column mode; pass null for the
  // single-column layout. The column is a drop zone that reassigns a dropped
  // block to this column and moves it to the end.
  const renderWorkspaceColumn = (col: number | null) => {
    const keys = col === null ? orderedKeys : orderedKeys.filter((key) => columnOf(key) === col)
    const dragActive = draggingKey !== null
    return (
      <div
        key={col ?? 'single'}
        className={`ws-column ${dragActive ? 'drag-active' : ''}`}
        onDragOver={(event) => {
          if (dragActive) event.preventDefault()
        }}
        onDrop={(event) => {
          if (!dragActive) return
          event.preventDefault()
          handleDropToColumn(col ?? 0)
        }}
      >
        {keys.map(renderBlock)}
      </div>
    )
  }

  return (
    <div className={`app-shell ${hasContent ? 'has-content' : 'blank'} ${workspaceColumns === 2 ? 'full-width' : ''}`}>
      <header className="topbar card">
        <div>
          <div className="eyebrow">Hermes chat bridge</div>
          <h1>Agent Rider</h1>
          <p>{summaryLine}</p>
        </div>
        <div className="status-stack">
          <StatusPill state={connectionState} detail={connectionDetail} />
          <span className="chip">{queuedCount ? `${queuedCount} queued` : 'No queue'}</span>
          <span className="chip">Read only gateway</span>
        </div>
      </header>

      <main className="main-stage">
        <div className="main-layout">
          <div className="left-rail">
            <ConversationTreeSidebar
              tree={conversationTree}
              activeRunId={activeRunId}
              onSelect={selectConversation}
              onDeleteRequest={requestDeleteConversation}
            />
            <ResourceSidebar
              terminalOpen={terminalOpen}
              onLaunchTerminal={() => openPanel('terminal')}
              openPluginIds={openPluginIds}
              onLaunchPlugin={launchPlugin}
              apps={appListing.apps}
              appWarnings={appListing.warnings}
              openAppSlugs={openAppSlugs}
              onLaunchApp={launchApp}
              onReorderApps={reorderApps}
              onRenameApp={renameAppLabel}
            />
          </div>

          <section className="conversation-workspace" aria-label="Conversation cards">
            <div className="stack-toolbar">
              <button type="button" className="send-button new-conversation-btn" onClick={startNewConversation}>
                + New conversation
              </button>
              <button
                type="button"
                className="layout-toggle-button"
                title={workspaceColumns === 1 ? 'Switch to two columns' : 'Switch to one column'}
                aria-label={workspaceColumns === 1 ? 'Switch to two columns' : 'Switch to one column'}
                onClick={() => setWorkspaceColumns((current) => (current === 1 ? 2 : 1))}
              >
                {workspaceColumns === 1 ? '▥' : '▤'}
              </button>
              {error ? <span className="error-text inline">{error}</span> : null}
            </div>

            {/* Datalists shared by every card's Category / Project comboboxes. */}
            <datalist id="known-categories">
              {knownCategories.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <datalist id="known-projects">
              {knownProjects.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>

            <div className={`workspace-panels columns-${workspaceColumns}`}>
              {panelOrder.length === 0 && visibleRuns.length === 0 ? (
                <div className="conv-empty">
                  {hasContent ? 'All cards closed — reopen one from the Navigator.' : 'Click “New conversation” to begin.'}
                </div>
              ) : workspaceColumns === 2 ? (
                // Unified two-column canvas: panels and cards each carry a
                // column, so a tool/app can sit left-right beside a card.
                <div className="ws-columns">{[0, 1].map((col) => renderWorkspaceColumn(col))}</div>
              ) : (
                renderWorkspaceColumn(null)
              )}
            </div>
          </section>
        </div>
      </main>

      {deleteTargetRun ? (
        <div className="confirm-overlay" onClick={() => setDeletePromptRunId(null)}>
          <div className="confirm-dialog card" onClick={(event) => event.stopPropagation()}>
            <div className="picker-head">
              <div>
                <div className="eyebrow">Confirm delete</div>
                <h3>{conversationTitle(deleteTargetRun)}</h3>
              </div>
              <button type="button" className="picker-close" onClick={() => setDeletePromptRunId(null)} aria-label="Close">
                ×
              </button>
            </div>

            <p className="confirm-copy">
              Delete this conversation and all {turnsByRun.get(deleteTargetRun.id)?.length ?? 0} turn(s)? This cannot be undone.
            </p>

            <div className="picker-actions confirm-actions">
              <button type="button" className="picker-cancel" onClick={() => setDeletePromptRunId(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="send-button danger-button"
                onClick={() => {
                  deleteConversation(deleteTargetRun.id)
                  setDeletePromptRunId(null)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pickerRunId ? (
        <WorkspacePicker
          initialPath={runs.find((run) => run.id === pickerRunId)?.workspacePath ?? DEFAULT_CWD}
          onSelect={(path) => {
            changeRunWorkspace(pickerRunId, path)
            setPickerRunId(null)
          }}
          onClose={() => setPickerRunId(null)}
        />
      ) : null}
    </div>
  )
}
