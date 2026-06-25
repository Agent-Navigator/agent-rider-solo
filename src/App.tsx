import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { HermesBridge, type HermesConnectionState } from './hermesBridge'
import { loadPersistedState, persistState } from './store'

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

function buildRun(prompt: string, index: number) {
  const category = inferCategory(prompt)
  const words = importantWords(prompt)
  const label = titleCase(words.slice(0, 3)) || `${category.name} Flow`
  const project = `${label} Project`
  const workspacePath = `${DEFAULT_CWD}/${slugify(project || category.name)}`
  const resourceTemplatesMatched = deriveResources(prompt)

  return {
    run: {
      id: makeId('run'),
      prompt,
      category: category.name,
      categoryTags: category.tags,
      project,
      workspace: `${project} workspace`,
      workspacePath,
      task: compactText(prompt, 72),
      job: index === 0 ? 'Draft automation run' : `Hermes run #${index + 1}`,
      jobStatus: 'queued' as JobStatus,
      resourceIds: resourceTemplatesMatched.map((template) => template.id),
      createdAt: new Date().toISOString(),
    },
    resources: resourceTemplatesMatched,
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

function ResourceCard({ resource }: { resource: ResourceItem }) {
  return (
    <article className="resource-card">
      <div className="resource-head">
        <div>
          <h4>{resource.kind}</h4>
          <span>{resource.name}</span>
        </div>
        <StatusPill state="ready" detail={resource.health} />
      </div>
      <p>{resource.detail}</p>
      <div className="tag-row">
        {resource.assignedRunIds.length ? (
          resource.assignedRunIds.map((runId) => <span key={runId} className="tag">{runId}</span>)
        ) : (
          <span className="tag muted">Unassigned</span>
        )}
      </div>
    </article>
  )
}

function RunCard({
  run,
  response,
  expanded,
  onToggle,
}: {
  run: RunNode
  response: string
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <article className={`run-card ${expanded ? 'expanded' : ''}`}>
      <button className="run-card-top" type="button" onClick={onToggle}>
        <div>
          <span className="eyebrow">{timeLabel(run.createdAt)} · {run.category}</span>
          <h3>{run.task}</h3>
        </div>
        <StatusPill state={run.jobStatus} detail={run.jobStatus === 'running' ? 'Running' : run.jobStatus === 'queued' ? 'Queued' : run.jobStatus === 'done' ? 'Done' : 'Error'} />
      </button>

      <div className="run-tree">
        <TreeRow label="Category" value={`${run.category} · ${run.categoryTags.join(' / ')}`} depth={0} />
        <TreeRow label="Project" value={run.project} depth={1} />
        <TreeRow label="Workspace" value={run.workspacePath} depth={2} />
        <TreeRow label="Task" value={run.task} depth={3} />
        <TreeRow label="Job" value={run.job} depth={4} />
      </div>

      {expanded && (
        <div className="run-extra">
          <div>
            <span className="micro-label">Hermes reply</span>
            <div className="assistant-copy md-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{response || 'Waiting for Hermes…'}</ReactMarkdown>
            </div>
          </div>
          <div>
            <span className="micro-label">Assigned resources</span>
            <div className="tag-row">
              {run.resourceIds.length ? run.resourceIds.map((id) => <span key={id} className="tag">{id}</span>) : <span className="tag muted">None</span>}
            </div>
          </div>
        </div>
      )}
    </article>
  )
}

function TaskJobCard({ run }: { run: RunNode }) {
  return (
    <article className="taskjob-card">
      <div className="taskjob-head">
        <span className="eyebrow">{timeLabel(run.createdAt)} · {run.category}</span>
        <StatusPill state={run.jobStatus} detail={run.jobStatus === 'running' ? 'Running' : run.jobStatus === 'queued' ? 'Queued' : run.jobStatus === 'done' ? 'Done' : 'Error'} />
      </div>
      <div className="taskjob-row">
        <span className="tree-label">Task</span>
        <strong className="tree-value">{run.task}</strong>
      </div>
      <div className="taskjob-row">
        <span className="tree-label">Job</span>
        <strong className="tree-value">{run.job}</strong>
      </div>
    </article>
  )
}

function isBusyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /session busy|subagent still running|busy/i.test(message)
}

export default function App() {
  const bridgeRef = useRef<HermesBridge | null>(null)
  const activeTurnRef = useRef<string | null>(null)
  const activeRunRef = useRef<string | null>(null)
  const hydratedRef = useRef(false)
  const queuedPromptsRef = useRef<QueuedPromptEntry[]>([])
  const assistantBufferRef = useRef('')

  const [initialized, setInitialized] = useState(false)
  const [input, setInput] = useState('')
  const [turns, setTurns] = useState<TurnItem[]>([])
  const [runs, setRuns] = useState<RunNode[]>([])
  const [resources, setResources] = useState<ResourceItem[]>([])
  const [connectionState, setConnectionState] = useState<HermesConnectionState>('disconnected')
  const [connectionDetail, setConnectionDetail] = useState('Disconnected')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionInfoText, setSessionInfoText] = useState('No Hermes session yet')
  const [queuedCount, setQueuedCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)

  const hasContent = runs.length > 0

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
        if (state.runs.length) setRuns((current) => (current.length ? current : (state.runs as RunNode[])))
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

    const { turnId, runId, prompt } = entry

    activeTurnRef.current = turnId
    activeRunRef.current = runId
    assistantBufferRef.current = ''
    try {
      const session = await bridge.ensureSession()
      setSessionId(session)
      setSessionInfoText(`Hermes session ${session}`)
      await bridge.submitPrompt(prompt)
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

  async function dispatchPrompt(prompt: string, fromQueue = false) {
    const bridge = bridgeRef.current
    if (!bridge) return

    const existingIndex = turns.length
    const { run, resources: matchedTemplates } = buildRun(prompt, existingIndex)

    const turnId = makeId('turn')
    const turn: TurnItem = {
      id: turnId,
      prompt,
      response: fromQueue ? 'Queued…' : 'Thinking…',
      status: fromQueue ? 'queued' : 'running',
      runId: run.id,
      createdAt: new Date().toISOString(),
    }

    setTurns((current) => [...current, turn])
    setRuns((current) => [...current, run])
    setExpandedRunId(run.id)
    setError(null)

    setResources((current) => {
      const next = new Map(current.map((resource) => [resource.id, { ...resource }]))
      for (const template of matchedTemplates) {
        const existing = next.get(template.id)
        if (existing) {
          if (!existing.assignedRunIds.includes(run.id)) existing.assignedRunIds = [...existing.assignedRunIds, run.id]
          if (!existing.assignedTaskIds.includes(run.id)) existing.assignedTaskIds = [...existing.assignedTaskIds, run.id]
          continue
        }

        next.set(template.id, {
          id: template.id,
          kind: template.kind,
          name: template.name,
          detail: template.detail,
          health: template.always ? 'Ready' : 'Draft',
          assignedRunIds: [run.id],
          assignedTaskIds: [run.id],
        })
      }
      return Array.from(next.values())
    })

    const isCurrentlyBusy = connectionState === 'busy' || activeTurnRef.current !== null
    if (isCurrentlyBusy && !fromQueue) {
      queuedPromptsRef.current.push({ turnId, runId: run.id, prompt })
      setQueuedCount(queuedPromptsRef.current.length)
      setTurns((current) => current.map((item) => (item.id === turnId ? { ...item, status: 'queued', response: 'Queued until Hermes is ready…' } : item)))
      setRuns((current) => current.map((item) => (item.id === run.id ? { ...item, jobStatus: 'queued' } : item)))
      return
    }

    await startTurn({ turnId, runId: run.id, prompt })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const prompt = input.trim()
    if (!prompt) return
    setInput('')

    const bridge = bridgeRef.current
    if (!bridge) {
      setError('Hermes bridge is not ready yet.')
      return
    }

    await dispatchPrompt(prompt)
  }

  const conversation = turns
  const latestRun = runs[runs.length - 1] ?? null

  return (
    <div className={`app-shell ${hasContent ? 'has-content' : 'blank'}`}>
      {hasContent ? (
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
      ) : null}

      <main className={`main-stage ${hasContent ? 'expanded' : 'empty'}`}>
        {!hasContent ? (
          <section className="blank-canvas card">
            <div className="blank-copy">
              <div className="eyebrow">Blank canvas</div>
              <h1>Start with a chat, and the workspace will grow.</h1>
              <p>
                The first message creates a Hermes session, forwards your prompt to the agent, and then grows the
                Category → Project → Workspace → Task → Job tree plus the resource view.
              </p>
            </div>
          </section>
        ) : (
          <div className="workspace-grid">
            <section className="main-column">
              <section className="card conversation-card">
                <div className="section-head">
                  <div>
                    <div className="eyebrow">Conversation</div>
                    <h2>Live Hermes transcript</h2>
                  </div>
                  <StatusPill state={connectionState} detail={connectionDetail} />
                </div>

                {latestRun ? (
                  <div className="conv-meta">
                    <div className="conv-meta-row">
                      <span className="tree-label">Category</span>
                      <strong className="tree-value">{latestRun.category}</strong>
                    </div>
                    <div className="conv-meta-row">
                      <span className="tree-label">Project</span>
                      <strong className="tree-value">{latestRun.project}</strong>
                    </div>
                    <div className="conv-meta-row">
                      <span className="tree-label">Workspace</span>
                      <strong className="tree-value">{latestRun.workspacePath}</strong>
                    </div>
                  </div>
                ) : null}

                <div className="conversation-feed">
                  {conversation.map((turn) => (
                    <article key={turn.id} className={`turn ${turn.status}`}>
                      <div className="bubble user">
                        <span className="role">You</span>
                        <p>{turn.prompt}</p>
                      </div>
                      <div className="bubble assistant">
                        <span className="role">
                          Hermes · {turn.status === 'queued' ? 'Queued' : turn.status === 'error' ? 'Error' : turn.status === 'done' ? 'Done' : 'Running'}
                        </span>
                        <div className="md-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{turn.response || '…'}</ReactMarkdown>
                        </div>
                      </div>
                    </article>
                  ))}
                  {!conversation.length ? <div className="empty-feed">No turns yet.</div> : null}
                </div>

                <form className="composer conv-composer" onSubmit={handleSubmit}>
                  <textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder="Ask Hermes to create, analyze, or automate…"
                    rows={2}
                  />
                  <div className="composer-meta">
                    <span>{summaryLine}</span>
                    <button type="submit" className="send-button">
                      Send
                    </button>
                  </div>
                </form>

                {error ? <p className="error-text">{error}</p> : null}
              </section>
            </section>

            <aside className="side-column">
              <section className="card runs-panel">
                <div className="section-head">
                  <div>
                    <div className="eyebrow">Board</div>
                    <h2>Tasks &amp; Jobs</h2>
                  </div>
                  <span className="chip">{runs.length} runs</span>
                </div>
                <div className="run-list">
                  {runs.length ? (
                    runs.map((run) => <TaskJobCard key={run.id} run={run} />)
                  ) : (
                    <div className="empty-state compact">Tasks and jobs will appear after the first chat.</div>
                  )}
                </div>
              </section>

              <section className="card inspector-panel subtle">
                <div className="section-head compact-head">
                  <div>
                    <div className="eyebrow">Session status</div>
                    <h2>Hermes bridge</h2>
                  </div>
                  <StatusPill state={connectionState} detail={connectionState === 'ready' ? 'Ready' : connectionState === 'busy' ? 'Busy' : connectionState === 'connecting' ? 'Connecting' : connectionState === 'error' ? 'Error' : 'Disconnected'} />
                </div>
                <div className="kv-list">
                  <div>
                    <span>Session</span>
                    <strong>{sessionId ?? 'Not created yet'}</strong>
                  </div>
                  <div>
                    <span>Status</span>
                    <strong>{connectionDetail}</strong>
                  </div>
                  <div>
                    <span>Context</span>
                    <strong>{sessionInfoText}</strong>
                  </div>
                </div>
              </section>
            </aside>
          </div>
        )}
      </main>

      {!hasContent ? (
        <footer className="composer-bar card">
          <form className="composer" onSubmit={handleSubmit}>
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask Hermes to create, analyze, or automate…"
              rows={3}
            />
            <div className="composer-meta">
              <span>{connectionDetail}</span>
              <button type="submit" className="send-button">
                Send
              </button>
            </div>
          </form>
        </footer>
      ) : null}
    </div>
  )
}
