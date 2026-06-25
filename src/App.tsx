import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { HermesBridge, type HermesConnectionState } from './hermesBridge'
import { loadPersistedState, persistState, listDir, makeDir, type FsListing } from './store'

type JobStatus = 'queued' | 'running' | 'done' | 'error'
type ResourceHealth = 'Ready' | 'Needs setup' | 'Draft'

type ChatRole = 'user' | 'assistant'

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
  createdAt: string
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

const DEFAULT_CWD = '/root/agent-work/DEV/agent-rider'
const DEFAULT_TITLE = 'Agent Workspace'

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
    task: compactText(prompt, 72),
    job: 'Hermes run',
  }
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

function ConversationCard({
  run,
  turns,
  collapsed,
  isNewDone,
  dragging,
  dragOver,
  onToggle,
  onSend,
  onCategoryChange,
  onProjectChange,
  onOpenPicker,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  run: RunNode
  turns: TurnItem[]
  collapsed: boolean
  isNewDone: boolean
  dragging: boolean
  dragOver: boolean
  onToggle: () => void
  onSend: (text: string) => void
  onCategoryChange: (value: string) => void
  onProjectChange: (value: string) => void
  onOpenPicker: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onDragOver: () => void
  onDrop: () => void
}) {
  const [draft, setDraft] = useState('')
  const status = run.jobStatus
  const isDraft = turns.length === 0

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    onSend(text)
  }

  return (
    <article
      className={`conv-card ${dragging ? 'dragging' : ''} ${dragOver ? 'drag-over' : ''} ${collapsed ? 'collapsed' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        onDragOver()
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDrop()
      }}
    >
      <div className="conv-card-head" onClick={onToggle}>
        <span
          className="conv-drag"
          draggable
          onClick={(event) => event.stopPropagation()}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          title="Drag to reorder"
        >
          ⠿
        </span>
        <div className="conv-card-titles">
          <span className="eyebrow">
            {timeLabel(run.createdAt)}
            {run.category ? ` · ${run.category}` : ''}
            {isDraft ? ' · Draft' : ` · ${turns.length} ${turns.length === 1 ? 'turn' : 'turns'}`}
          </span>
          <h3>{isDraft ? 'New conversation' : run.task}</h3>
        </div>
        <div className="conv-card-status">
          {!isDraft && status === 'running' ? <span className="spinner" aria-label="Running" /> : null}
          {!isDraft && status === 'queued' ? <span className="chip">Queued</span> : null}
          {!isDraft && status === 'error' ? <span className="pill error">Error</span> : null}
          {isNewDone ? <span className="new-dot" title="New result" /> : null}
        </div>
        <span className={`conv-caret ${collapsed ? '' : 'open'}`} aria-hidden>▾</span>
      </div>

      {!collapsed ? (
        <div className="conv-card-body">
          <div className="conv-meta">
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
              <span className="tree-label">Workspace</span>
              <button type="button" className="conv-workspace-btn" onClick={onOpenPicker} title={run.workspacePath}>
                <span className="conv-workspace-path">{run.workspacePath}</span>
                <span className="conv-workspace-action">Change…</span>
              </button>
            </div>
          </div>

          {turns.length ? (
            <div className="conversation-feed">
              {turns.map((turn) => (
                <article key={turn.id} className={`turn ${turn.status}`}>
                  <div className="bubble user">
                    <span className="role">You</span>
                    <p>{turn.prompt}</p>
                  </div>
                  <div className="bubble assistant">
                    <span className="role">Hermes · {turnRoleLabel(turn.status)}</span>
                    <div className="md-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.response || '…'}</ReactMarkdown>
                    </div>
                  </div>
                </article>
              ))}
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
        </div>
      ) : null}
    </article>
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
  const [newDoneIds, setNewDoneIds] = useState<Set<string>>(new Set())
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  // Which conversation's workspace picker is open (null = closed).
  const [pickerRunId, setPickerRunId] = useState<string | null>(null)

  const hasContent = runs.length > 0

  function toggleCollapse(runId: string) {
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

  function reorderRuns(draggedId: string, targetId: string) {
    if (draggedId === targetId) return
    setRuns((current) => {
      const from = current.findIndex((run) => run.id === draggedId)
      const to = current.findIndex((run) => run.id === targetId)
      if (from === -1 || to === -1) return current
      const next = [...current]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
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
      task: 'New conversation',
      job: 'Draft',
      jobStatus: 'queued',
      resourceIds: [],
      sessionId: null,
      createdAt: new Date().toISOString(),
    }
    setRuns((current) => [run, ...current])
  }

  // Edit a conversation's Category / Project / Workspace in place.
  function updateRunContext(runId: string, patch: Partial<RunNode>) {
    setRuns((current) => current.map((run) => (run.id === runId ? { ...run, ...patch } : run)))
  }

  function changeRunWorkspace(runId: string, path: string) {
    // Hermes can't move a live session's cwd, so reset this conversation's
    // session — the next turn runs in the newly chosen folder.
    sessionByRunRef.current.delete(runId)
    updateRunContext(runId, { workspacePath: path, sessionId: null })
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
        // Merge defensively: never clobber content the user already created this session.
        if (state.runs.length) {
          const restored = state.runs as RunNode[]
          setRuns((current) => (current.length ? current : restored))
          // Restore each conversation's Hermes session so follow-ups continue the same thread.
          for (const run of restored) {
            if (run.sessionId) sessionByRunRef.current.set(run.id, run.sessionId)
          }
        }
        if (state.turns.length) setTurns((current) => (current.length ? current : (state.turns as TurnItem[])))
      }
      hydratedRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Debounced auto-save of runs/turns to the local SQLite backend.
  useEffect(() => {
    if (!hydratedRef.current) return
    const handle = setTimeout(() => {
      void persistState(runs, turns, sessionId)
    }, 700)
    return () => clearTimeout(handle)
  }, [runs, turns, sessionId])

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

  function newTurn(runId: string, prompt: string): { turn: TurnItem; turnId: string } {
    const turnId = makeId('turn')
    return {
      turnId,
      turn: {
        id: turnId,
        prompt,
        response: 'Thinking…',
        status: 'running',
        runId,
        createdAt: new Date().toISOString(),
      },
    }
  }

  // Send a message inside a conversation card. The first turn derives the
  // card's metadata from the prompt (honoring any context the user set).
  function sendInConversation(runId: string, prompt: string) {
    if (!bridgeRef.current) {
      setError('Hermes bridge is not ready yet.')
      return
    }
    const run = runs.find((item) => item.id === runId)
    if (!run) return

    const hasTurns = turns.some((turn) => turn.runId === runId)
    let workspace = run.workspacePath
    if (!hasTurns) {
      const fields = deriveRunFields(prompt, {
        category: run.category,
        project: run.project,
        workspace: run.workspacePath,
      })
      workspace = fields.workspacePath
      setRuns((current) => current.map((item) => (item.id === runId ? { ...item, ...fields, jobStatus: 'running' } : item)))
    } else {
      setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'running' } : item)))
    }

    const { turn, turnId } = newTurn(runId, prompt)
    setTurns((current) => [turn, ...current])
    setError(null)
    enqueueOrStart({ turnId, runId, prompt, workspace })
  }

  return (
    <div className={`app-shell ${hasContent ? 'has-content' : 'blank'}`}>
      <header className="topbar card">
        <div>
          <div className="eyebrow">Hermes chat bridge</div>
          <h1>Agent Workspace / Mission Control</h1>
          <p>{summaryLine}</p>
        </div>
        <div className="status-stack">
          <StatusPill state={connectionState} detail={connectionDetail} />
          <span className="chip">{queuedCount ? `${queuedCount} queued` : 'No queue'}</span>
          <span className="chip">Read only gateway</span>
        </div>
      </header>

      <main className="main-stage">
        <div className="stack-toolbar">
          <button type="button" className="send-button new-conversation-btn" onClick={startNewConversation}>
            + New conversation
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

        {hasContent ? (
          <div className="conv-stack">
            {runs.map((run) => (
              <ConversationCard
                key={run.id}
                run={run}
                turns={turnsByRun.get(run.id) ?? []}
                collapsed={collapsedIds.has(run.id)}
                isNewDone={newDoneIds.has(run.id)}
                dragging={dragId === run.id}
                dragOver={dragOverId === run.id && dragId !== run.id}
                onToggle={() => toggleCollapse(run.id)}
                onSend={(text) => sendInConversation(run.id, text)}
                onCategoryChange={(value) =>
                  updateRunContext(run.id, { category: value, categoryTags: tagsForCategory(value) })
                }
                onProjectChange={(value) => updateRunContext(run.id, { project: value })}
                onOpenPicker={() => setPickerRunId(run.id)}
                onDragStart={() => setDragId(run.id)}
                onDragEnd={() => {
                  setDragId(null)
                  setDragOverId(null)
                }}
                onDragOver={() => setDragOverId(run.id)}
                onDrop={() => {
                  if (dragId) reorderRuns(dragId, run.id)
                  setDragId(null)
                  setDragOverId(null)
                }}
              />
            ))}
          </div>
        ) : (
          <div className="conv-empty">Click “New conversation” to begin.</div>
        )}
      </main>

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
