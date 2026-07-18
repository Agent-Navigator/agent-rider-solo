import { type ChangeEvent, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTermTerminal } from '@xterm/xterm'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import r from 'highlight.js/lib/languages/r'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import '@xterm/xterm/css/xterm.css'
import {
  loadPersistedState,
  persistState,
  listDir,
  readFilePreview,
  searchFiles,
  makeDir,
  fileDownloadUrl,
  deleteFile,
  uploadFile,
  listApps,
  setAppOrder,
  renameApp,
  loadPasswordStatus,
  loginPagePassword,
  setPagePassword,
  logoutPagePassword,
  type FsListing,
  type FsEntry,
  type FsFileEntry,
  type FsFilePreview,
  type FsSearchResultEntry,
  type AgentApp,
  type AppListing,
  type AppWarning,
  type WorkspacePanelState,
  type PasswordStatus,
  type LayoutPreset,
} from './store'
import { plugins, type AgentRiderPlugin } from '../plugins'
import { WebView } from '../plugins/WebView'

type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'
type ResourceHealth = 'Ready' | 'Needs setup' | 'Draft'

type ChatRole = 'user' | 'assistant'

// Conversation cards run an interactive TUI CLI in an embedded terminal.
type AgentType = 'claude' | 'codex' | 'agy' | 'devin' | 'custom'
type TuiAgentType = AgentType
type RunCardKind = 'conversation' | 'app-builder'

const AGENT_OPTIONS: { value: AgentType; label: string }[] = [
  { value: 'claude', label: 'Claude (CLI)' },
  { value: 'codex', label: 'Codex (CLI)' },
  { value: 'agy', label: 'Agy (CLI)' },
  { value: 'devin', label: 'Devin (CLI)' },
  { value: 'custom', label: 'Custom command' },
]

function isTuiAgent(agent: AgentType): agent is TuiAgentType {
  return agent === 'claude' || agent === 'codex' || agent === 'agy' || agent === 'devin' || agent === 'custom'
}

function agentLabel(agent: AgentType) {
  return AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent
}

// Agents whose quota can be read back by typing their slash command into the
// live tmux session and scraping the render (see /store/terminal/usage).
// devin isn't wired up (no CLI available to verify its output against).
const USAGE_SUPPORTED_AGENTS = new Set<AgentType>(['claude', 'codex', 'agy'])

interface UsageMeter {
  label: string
  percentUsed: number
  resets: string
  kind?: '5h' | 'week'
}

type UsageResult =
  | { available: true; meters: UsageMeter[]; fetchedAt: number }
  | { available: false; reason: 'no-session' | 'busy' | 'unparsed' | 'unsupported' | 'error' }

// The worst (highest %used) meter of each kind, so a provider that reports
// both a 5h and a weekly limit shows both instead of just the max of either.
function usageByKind(meters: UsageMeter[]) {
  const worstOf = (kind: UsageMeter['kind']) => {
    const matching = meters.filter((meter) => meter.kind === kind)
    return matching.length ? Math.max(...matching.map((meter) => meter.percentUsed)) : null
  }
  return { fiveH: worstOf('5h'), week: worstOf('week') }
}

/** Compact label for a usage button: "5h 62% / wk 18%" when both limits are
 *  known, otherwise whichever single percentage is available. */
function usageSummaryLabel(meters: UsageMeter[]) {
  const { fiveH, week } = usageByKind(meters)
  if (fiveH != null && week != null) return `5h ${fiveH}% / wk ${week}%`
  if (fiveH != null) return `5h ${fiveH}%`
  if (week != null) return `wk ${week}%`
  return `${Math.max(...meters.map((meter) => meter.percentUsed))}%`
}

// CLI status screens report resets as a relative duration ("4h 12m", "in 3h",
// "2d 4h"). Convert that to a plain hh:mm countdown for the tooltip; returns
// null for anything that isn't a parseable duration (e.g. a weekday name),
// so callers can fall back to the raw text instead of showing something wrong.
function formatResetCountdown(resets: string): string | null {
  const match = /\D*(?:(\d+)\s*d[a-z]*)?\D*(?:(\d+)\s*h[a-z]*)?\D*(?:(\d+)\s*m[a-z]*)?/i.exec(resets)
  if (!match) return null
  const days = Number(match[1] || 0)
  const hours = Number(match[2] || 0)
  const minutes = Number(match[3] || 0)
  if (!days && !hours && !minutes) return null
  const totalHours = days * 24 + hours
  return `${String(totalHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function usageMeterTooltipLine(meter: UsageMeter) {
  const countdown = formatResetCountdown(meter.resets)
  return `${meter.label}: ${meter.percentUsed}% used (${meter.resets}${countdown ? ` — ${countdown} remaining` : ''})`
}

async function fetchAgentUsage(agent: AgentType, cwd: string, session: string): Promise<UsageResult> {
  try {
    const res = await fetch('/store/terminal/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, cwd, session }),
    })
    if (!res.ok) return { available: false, reason: 'error' }
    return await res.json()
  } catch {
    return { available: false, reason: 'error' }
  }
}

function usageTone(percentUsed: number) {
  if (percentUsed >= 90) return '#ff9d9d'
  if (percentUsed >= 70) return '#e6b25a'
  return '#5fd39b'
}

const USAGE_UNAVAILABLE_LABEL: Record<Exclude<UsageResult, { available: true }>['reason'], string> = {
  'no-session': 'Open the session first',
  busy: 'Agent looks busy — try again shortly',
  unparsed: "Couldn't read the usage screen (CLI output may have changed)",
  unsupported: 'Not supported for this agent',
  error: 'Refresh failed',
}

const AGENT_SHORT_LABEL: Record<AgentType, string> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Agy',
  devin: 'Devin',
  custom: 'Custom',
}

/** Global toolbar button checking quota for one agent type, against its
 *  most recently created conversation (see `usageAgentRuns` in App). */
function AgentUsageToolbarButton({ agent, cwd, session }: { agent: AgentType; cwd: string; session: string }) {
  const [usage, setUsage] = useState<UsageResult | null>(null)
  const [loading, setLoading] = useState(false)
  const refresh = useCallback(() => {
    if (loading) return
    setLoading(true)
    void fetchAgentUsage(agent, cwd, session).then(setUsage).finally(() => setLoading(false))
  }, [agent, cwd, session, loading])
  const label = AGENT_SHORT_LABEL[agent]
  return (
    <button
      type="button"
      className="win-btn win-usage-btn"
      title={
        loading
          ? 'Checking usage…'
          : !usage
            ? `Check ${label} usage (types its status command into the most recent ${label} session and reads the reply)`
            : usage.available
              ? usage.meters.map(usageMeterTooltipLine).join('\n')
              : USAGE_UNAVAILABLE_LABEL[usage.reason]
      }
      aria-label={`Refresh ${label} usage`}
      style={{ color: usage?.available ? usageTone(Math.max(...usage.meters.map((meter) => meter.percentUsed))) : undefined }}
      onClick={(event) => {
        event.stopPropagation()
        refresh()
      }}
    >
      {label} ·{' '}
      {loading
        ? '…'
        : !usage
          ? 'usage'
          : usage.available
            ? usageSummaryLabel(usage.meters)
            : '—'}
    </button>
  )
}

// Which TUI agent CLIs are installed on the host (from /store/agents), so the
// Agent dropdown can grey out the ones that aren't. Cached module-wide: every
// card shares one fetch. Fails open — if the endpoint is unavailable nothing
// gets disabled.
let agentAvailabilityCache: Record<string, boolean> | null = null
let agentAvailabilityPromise: Promise<Record<string, boolean> | null> | null = null
function useAgentAvailability(): Record<string, boolean> | null {
  const [availability, setAvailability] = useState(agentAvailabilityCache)
  useEffect(() => {
    if (agentAvailabilityCache) return
    const availabilityPromise = agentAvailabilityPromise ??= fetch('/store/agents')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => ((data as { agents?: Record<string, boolean> } | null)?.agents ?? null))
      .catch(() => null)
    let cancelled = false
    void availabilityPromise.then((agents) => {
      if (!agents) {
        // Failed (e.g. fetched while the page was still locked) — don't cache,
        // so a later mount retries instead of never disabling anything.
        agentAvailabilityPromise = null
        return
      }
      agentAvailabilityCache = agents
      if (!cancelled) setAvailability(agents)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return availability
}

function renderAgentOptions(
  availability: Record<string, boolean> | null,
  options = AGENT_OPTIONS,
) {
  return options.map((option) => {
    // Only explicit false disables: custom isn't in the map, and a
    // missing/failed endpoint must not lock the dropdown.
    const notInstalled = availability?.[option.value] === false
    return (
      <option key={option.value} value={option.value} disabled={notInstalled}>
        {option.label}
        {notInstalled ? ' — not installed' : ''}
      </option>
    )
  })
}

function scrollToFocusTarget(target: HTMLElement | null) {
  if (!target) return
  target.scrollIntoView({ behavior: 'smooth', block: 'end', inline: 'nearest' })
}

function assistantBubbleBottomId(turnId: string) {
  return `assistant-bubble-bottom-${turnId}`
}

function hasTextSelectionInside(element: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.toString()) return false
  return Boolean(
    (selection.anchorNode && element.contains(selection.anchorNode)) ||
    (selection.focusNode && element.contains(selection.focusNode)),
  )
}

const richMarkdownComponents: Components = {
  a({ node: _node, href, children, ...props }) {
    const external = href?.startsWith('http://') || href?.startsWith('https://')
    return (
      <a {...props} href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>
        {children}
      </a>
    )
  },
  img({ node: _node, alt, ...props }) {
    return <img {...props} alt={alt ?? ''} loading="lazy" decoding="async" />
  },
  table({ node: _node, children, ...props }) {
    return (
      <div className="md-table-scroll">
        <table {...props}>{children}</table>
      </div>
    )
  },
}

const richMarkdownPlugins = {
  remark: [remarkGfm],
  rehype: [rehypeRaw, rehypeSanitize],
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
  agentType: AgentType
  agentCommand?: string
  cardKind?: RunCardKind
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
// Default workspace folder for new Conversation Cards (~/).
const DEFAULT_WORKSPACE_CWD = '/root'
const DEFAULT_TERMINAL_CWD = '/root'
const DEFAULT_TITLE = 'Agent Rider'
const AGENT_TERMINAL_STATE_PREFIX = 'agent-terminal:'
const TUI_WHEEL_PAGE_DELTA = 80
const TUI_PAGE_UP = '\x1b[5~'
const TUI_PAGE_DOWN = '\x1b[6~'
const LEGACY_APP_BUILDER_PANEL_ID = 'app-builder'
const LEGACY_APP_BUILDER_PANEL_PREFIX = 'app-builder:'
const LEGACY_APP_BUILDER_RUN_ID = 'run-app-builder'
const LEGACY_APP_BUILDER_RUN_PREFIX = 'run-app-builder:'
const RETIRED_PLUGIN_PANEL_IDS = new Set([
  'plugin:hermes-webui',
  'plugin:local-desktop-guacamole',
])

function timeLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function windowStatusTone(status: JobStatus, draft: boolean) {
  if (draft || status === 'queued') return { dot: '#e6b25a' }
  if (status === 'running') return { dot: '#68a8ff' }
  if (status === 'done') return { dot: '#5fd39b' }
  if (status === 'error') return { dot: '#ff7777' }
  return { dot: '#a0a0a0' }
}

function connectionStatusTone(state: 'connecting' | 'connected' | 'closed' | 'error') {
  if (state === 'connected') return { dot: '#5fd39b', color: '#5fd39b', label: 'connected' }
  if (state === 'connecting') return { dot: '#e6b25a', color: '#e6b25a', label: 'connecting' }
  if (state === 'error') return { dot: '#ff7777', color: '#ff7777', label: 'error' }
  return { dot: '#a0a0a0', color: '#a0a0a0', label: 'disconnected' }
}

// cardKind is not a persisted run column, so retired builder runs are still
// recognized by id and kept hidden rather than resurfacing as conversations.
function isAppBuilderRunId(runId: string) {
  return runId === LEGACY_APP_BUILDER_RUN_ID || runId.startsWith(LEGACY_APP_BUILDER_RUN_PREFIX)
}

// App Builder is retired for now, but apps created by older installations stay
// available as plain WebView panels. Drop the old empty builder panel and map
// per-app builder panels back to their stable `app:<slug>` ids.
function migrateAppPanelId(panelId: string): string | null {
  if (panelId === LEGACY_APP_BUILDER_PANEL_ID) return null
  return panelId.startsWith(LEGACY_APP_BUILDER_PANEL_PREFIX)
    ? `app:${panelId.slice(LEGACY_APP_BUILDER_PANEL_PREFIX.length)}`
    : panelId
}

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('c', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('csharp', csharp)
hljs.registerLanguage('css', css)
hljs.registerLanguage('go', go)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('java', java)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('php', php)
hljs.registerLanguage('python', python)
hljs.registerLanguage('r', r)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('yaml', yaml)

const CODE_LANGUAGE_BY_EXT: Record<string, string> = {
  '.bash': 'bash',
  '.c': 'c',
  '.cc': 'cpp',
  '.conf': 'ini',
  '.config': 'ini',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.css': 'css',
  '.cxx': 'cpp',
  '.env': 'ini',
  '.fish': 'bash',
  '.go': 'go',
  '.h': 'c',
  '.hpp': 'cpp',
  '.htm': 'xml',
  '.html': 'xml',
  '.ini': 'ini',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.jsx': 'javascript',
  '.kt': 'kotlin',
  '.less': 'css',
  '.mjs': 'javascript',
  '.php': 'php',
  '.py': 'python',
  '.r': 'r',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.sass': 'css',
  '.scss': 'css',
  '.sh': 'bash',
  '.sql': 'sql',
  '.swift': 'swift',
  '.toml': 'ini',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.zsh': 'bash',
}

const CODE_LANGUAGE_BY_NAME: Record<string, string> = {
  Containerfile: 'bash',
  Dockerfile: 'bash',
  Gemfile: 'ruby',
  Makefile: 'bash',
  Rakefile: 'ruby',
}

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
    if (RETIRED_PLUGIN_PANEL_IDS.has(key)) continue
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const source = raw as Record<string, unknown>
    const state: WorkspacePanelState = {}
    if (typeof source.collapsed === 'boolean') state.collapsed = source.collapsed
    if (typeof source.fullWindow === 'boolean') state.fullWindow = source.fullWindow
    if (typeof source.notepad === 'string') state.notepad = source.notepad
    const migratedKey = migrateAppPanelId(key)
    if (!migratedKey) continue
    if (Object.keys(state).length) states[migratedKey] = state
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
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      // Fall through to the DOM copy path when clipboard permission is denied.
    }
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

function decodeBase64Text(value: string) {
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function parseOsc52Clipboard(data: string) {
  const separator = data.indexOf(';')
  if (separator === -1) return null
  const payload = data.slice(separator + 1)
  if (!payload || payload === '?') return null
  return decodeBase64Text(payload)
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
function deriveRunFields(prompt: string, overrides: RunOverrides = {}, defaultWorkspacePath = DEFAULT_WORKSPACE_CWD) {
  const inferred = inferCategory(prompt)
  const categoryName = (overrides.category ?? '').trim() || inferred.name
  const categoryTags = (overrides.category ?? '').trim() ? tagsForCategory(categoryName) : inferred.tags

  const words = importantWords(prompt)
  const label = titleCase(words.slice(0, 3)) || `${categoryName} Flow`
  const project = (overrides.project ?? '').trim() || `${label} Project`
  const workspacePath = (overrides.workspace ?? '').trim() || defaultWorkspacePath

  return {
    prompt,
    category: categoryName,
    categoryTags,
    project,
    workspace: `${project} workspace`,
    workspacePath,
    job: 'Agent run',
  }
}

function conversationTitle(run: RunNode) {
  return run.task.trim() || run.project.trim() || compactText(run.prompt, 48) || 'Untitled conversation'
}

// Chronological order: oldest at the top, newest at the bottom (like a chat
// log), so it reads top-to-bottom with the prompt bar pinned below it. Within a
// thread the parent comes before its follow-ups.
function WinGrip() {
  return (
    <span className="win-grip" aria-hidden>
      <svg width="8" height="14" viewBox="0 0 8 14">
        <circle cx="2" cy="2" r="1.3" fill="currentColor" />
        <circle cx="6" cy="2" r="1.3" fill="currentColor" />
        <circle cx="2" cy="7" r="1.3" fill="currentColor" />
        <circle cx="6" cy="7" r="1.3" fill="currentColor" />
        <circle cx="2" cy="12" r="1.3" fill="currentColor" />
        <circle cx="6" cy="12" r="1.3" fill="currentColor" />
      </svg>
    </span>
  )
}

function WinFilesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5H12.5A1.5 1.5 0 0114 6v6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12V4.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function WinImageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5.5" cy="6.5" r="1.25" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.8 11.5l3.4-3.4a1 1 0 011.4 0l1.9 1.9M9.8 9.5l1-1a1 1 0 011.4 0l1.6 1.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function WinFullscreenIcon({ active }: { active?: boolean }) {
  return active ? (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function WinConversationCollapseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path d="M3 10.5h10L8 5z" fill="currentColor" />
    </svg>
  )
}

function WinConversationExpandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
      <path d="M3 5.5h10L8 11z" fill="currentColor" />
    </svg>
  )
}

function WinMaximizeIcon({ active }: { active?: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      {active ? (
        <>
          <rect x="2.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M5.5 3h6.5a1.5 1.5 0 011.5 1.5V11" stroke="currentColor" strokeWidth="1.3" />
        </>
      ) : (
        <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      )}
    </svg>
  )
}

function WinCloseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function WinContextIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 4.5h8M12.5 4.5H14M2 11.5h3M7.5 11.5H14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="11" cy="4.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5.8" cy="11.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
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

function pathWithinRoot(path: string, root: string) {
  return path === root || root === '/' || path.startsWith(`${root}/`)
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function fileExtension(name: string) {
  const index = name.lastIndexOf('.')
  return index > 0 ? name.slice(index).toLowerCase() : ''
}

function fileTypeIcon(name: string) {
  const lowerName = name.toLowerCase()
  const ext = fileExtension(lowerName)
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp', '.ico'].includes(ext)) return 'IMG'
  if (['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'].includes(ext)) return 'VID'
  if (['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac'].includes(ext)) return 'AUD'
  if (['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar'].includes(ext)) return 'ZIP'
  if (['.pdf'].includes(ext)) return 'PDF'
  if (['.md', '.markdown', '.mdx'].includes(ext)) return 'MD'
  if (['.html', '.htm'].includes(ext)) return 'HTML'
  if (['.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml', '.csv'].includes(ext)) return 'DATA'
  if (['.lock', '.conf', '.config', '.ini'].includes(ext) || ['.gitignore', '.dockerignore', '.npmrc'].includes(lowerName) || lowerName.startsWith('.env')) return 'CFG'
  if (languageForFile(lowerName)) return 'CODE'
  if (['.txt', '.log', '.text'].includes(ext)) return 'TXT'
  return 'FILE'
}

const FILE_TYPE_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'CODE', label: 'Code' },
  { value: 'DATA', label: 'Data' },
  { value: 'MD', label: 'Markdown' },
  { value: 'HTML', label: 'HTML' },
  { value: 'TXT', label: 'Text' },
  { value: 'CFG', label: 'Config' },
  { value: 'IMG', label: 'Images' },
  { value: 'VID', label: 'Video' },
  { value: 'AUD', label: 'Audio' },
  { value: 'PDF', label: 'PDF' },
  { value: 'ZIP', label: 'Archives' },
  { value: 'FILE', label: 'Other' },
]

function languageForFile(path: string) {
  const name = fileNameFromPath(path)
  return CODE_LANGUAGE_BY_NAME[name] ?? CODE_LANGUAGE_BY_EXT[fileExtension(name)] ?? null
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

function CodeFilePreview({ preview }: { preview: FsFilePreview }) {
  const highlighted = useMemo(() => {
    const content = preview.content ?? ''
    const language = languageForFile(preview.path || preview.name)
    if (language && hljs.getLanguage(language)) {
      return {
        html: hljs.highlight(content, { language, ignoreIllegals: true }).value,
        language,
      }
    }
    const result = hljs.highlightAuto(content)
    return {
      html: result.value,
      language: result.language ?? null,
    }
  }, [preview.content, preview.name, preview.path])

  return (
    <pre className={`file-preview-code ${preview.kind}`}>
      <code
        className={highlighted.language ? `hljs language-${highlighted.language}` : 'hljs'}
        dangerouslySetInnerHTML={{ __html: highlighted.html }}
      />
    </pre>
  )
}

// ── Floating file preview ────────────────────────────────────────────────

interface FloatingPreviewProps {
  preview: FsFilePreview
  onClose: () => void
}

/**
 * A draggable, resizable floating window that portals to the document body so
 * it always renders on top of other UI. Drag by the titlebar; resize via the
 * right, bottom, and bottom-right corner grab handles; expand to full screen
 * via the titlebar button.
 */
function FloatingPreview({ preview, onClose }: FloatingPreviewProps) {
  const [position, setPosition] = useState({ x: 160, y: 80 })
  const [size, setSize] = useState({ width: 640, height: 520 })
  const [fullScreen, setFullScreen] = useState(false)
  const savedGeom = useRef({ x: 160, y: 80, w: 640, h: 520 })
  const draggingRef = useRef(false)
  const resizingRef = useRef<'e' | 's' | 'se' | null>(null)
  const dragOffset = useRef({ x: 0, y: 0 })
  const minW = 320, minH = 240

  const onPointerDownTitle = useCallback((event: ReactPointerEvent) => {
    const target = event.target as HTMLElement
    if (target.closest('button')) return
    event.preventDefault()
    draggingRef.current = true
    dragOffset.current = { x: event.clientX - position.x, y: event.clientY - position.y }
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  }, [position])

  const onPointerDownResize = useCallback((dir: 'e' | 's' | 'se') => (event: ReactPointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    resizingRef.current = dir
    dragOffset.current = { x: event.clientX - size.width, y: event.clientY - size.height }
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  }, [size])

  const onPointerMove = useCallback((event: ReactPointerEvent) => {
    if (draggingRef.current) {
      setPosition({ x: event.clientX - dragOffset.current.x, y: event.clientY - dragOffset.current.y })
    } else if (resizingRef.current) {
      const dir = resizingRef.current
      setSize({
        width: dir === 's' ? size.width : Math.max(minW, event.clientX - dragOffset.current.x),
        height: dir === 'e' ? size.height : Math.max(minH, event.clientY - dragOffset.current.y),
      })
    }
  }, [size])

  const onPointerUp = useCallback(() => {
    draggingRef.current = false
    resizingRef.current = null
  }, [])

  const toggleFullScreen = useCallback(() => {
    setFullScreen((prev) => {
      if (prev) {
        // Restore previous geometry.
        const g = savedGeom.current
        setPosition({ x: g.x, y: g.y })
        setSize({ width: g.w, height: g.h })
      } else {
        // Save current geometry, then fill viewport with small inset.
        savedGeom.current = { x: position.x, y: position.y, w: size.width, h: size.height }
        setPosition({ x: 8, y: 8 })
        setSize({ width: window.innerWidth - 16, height: window.innerHeight - 16 })
      }
      return !prev
    })
  }, [position, size])

  return createPortal(
    <div
      className={`floating-preview ${fullScreen ? 'full-screen' : ''}`}
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="floating-preview-titlebar" onPointerDown={onPointerDownTitle}>
        <div className="floating-preview-title">
          <strong>{preview.name}</strong>
          <span>{preview.kind} · {formatBytes(preview.size)}</span>
        </div>
        <button
          type="button"
          className="floating-preview-icon-btn"
          onClick={toggleFullScreen}
          title={fullScreen ? 'Exit full screen' : 'Expand to full screen'}
          aria-label={fullScreen ? 'Exit full screen' : 'Expand to full screen'}
        >
          {fullScreen ? '↙' : '⛶'}
        </button>
        <button
          type="button"
          className="floating-preview-close"
          onClick={onClose}
          aria-label="Close file preview"
        >
          ×
        </button>
      </div>
      <div className="floating-preview-body">
        {preview.kind === 'image' ? (
          <div className="floating-preview-media">
            <img src={preview.dataUrl} alt={preview.name} />
          </div>
        ) : preview.kind === 'html' ? (
          <iframe
            className="floating-preview-html"
            title={preview.name}
            sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals"
            referrerPolicy="no-referrer"
            src={preview.viewUrl}
            srcDoc={preview.viewUrl ? undefined : preview.content ?? ''}
          />
        ) : preview.kind === 'markdown' ? (
          <div className="floating-preview-markdown md-body">
            <ReactMarkdown
              remarkPlugins={richMarkdownPlugins.remark}
              rehypePlugins={richMarkdownPlugins.rehype}
              components={richMarkdownComponents}
            >
              {preview.content ?? ''}
            </ReactMarkdown>
          </div>
        ) : (
          <CodeFilePreview preview={preview} />
        )}
      </div>
      <div className="floating-preview-resize-right" onPointerDown={onPointerDownResize('e')} />
      <div className="floating-preview-resize-bottom" onPointerDown={onPointerDownResize('s')} />
      <div className="floating-preview-resize-corner" onPointerDown={onPointerDownResize('se')} />
    </div>,
    document.body,
  )
}

/**
 * File browser opened at a conversation's workspace. Collapsed by default and
 * lazy-loaded on first expand. Users can navigate above the workspace, while the
 * backend still sandboxes every filesystem operation to BROWSE_ROOT.
 */
function FileBrowser({
  rootPath,
  open,
  onToggle,
  showOwnToggle = true,
}: {
  rootPath: string
  /** Controlled from the parent so a card can also trigger it from elsewhere
   *  (e.g. a compact button in the TUI terminal's own header). */
  open: boolean
  onToggle: () => void
  /** When false, this component renders only the dropdown panel (when open)
   *  and skips its own floating toggle pill — the parent renders a toggle
   *  trigger elsewhere instead. */
  showOwnToggle?: boolean
}) {
  const [path, setPath] = useState(rootPath)
  const [effectiveRootPath, setEffectiveRootPath] = useState(rootPath)
  const [listing, setListing] = useState<FsListing | null>(null)
  const [preview, setPreview] = useState<FsFilePreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<FsFileEntry | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const [typeFilter, setTypeFilter] = useState('all')
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FsSearchResultEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  // Debounce the search box before hitting the backend.
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(searchInput.trim()), 250)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    if (!searchQuery) {
      setSearchResults(null)
      setSearchTruncated(false)
      setSearchError(null)
      return
    }
    let cancelled = false
    setSearching(true)
    setSearchError(null)
    void searchFiles(path, searchQuery).then((result) => {
      if (cancelled) return
      if ('error' in result) {
        setSearchError(result.error)
        setSearchResults(null)
        setSearchTruncated(false)
      } else {
        setSearchResults(result.results)
        setSearchTruncated(Boolean(result.truncated))
      }
      setSearching(false)
    })
    return () => {
      cancelled = true
    }
  }, [path, searchQuery])

  async function confirmDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    setError(null)
    const result = await deleteFile(pendingDelete.path)
    setDeleting(false)
    if ('error' in result) {
      setError(result.error)
      setPendingDelete(null)
      return
    }
    // Close a preview of the file we just removed, then refresh the listing.
    if (preview?.path === pendingDelete.path) {
      setPreview(null)
    }
    setPendingDelete(null)
    void load(path)
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Reset the input so picking the same file again still fires onChange.
    event.target.value = ''
    if (!file) return
    setUploading(true)
    setError(null)
    const result = await uploadFile(path, file)
    setUploading(false)
    if ('error' in result) {
      setError(result.error)
      return
    }
    void load(path)
  }

  async function load(target: string) {
    setLoading(true)
    setError(null)
    setPreview(null)
    setPreviewError(null)
    setSearchInput('')
    setSearchQuery('')
    // Fall back to the workspace root, then the backend's allowed root, if a
    // persisted card still points at an unreadable or disallowed path.
    const attempts = Array.from(new Set([target, rootPath, '']))
    let result: FsListing | null = null
    for (const attempt of attempts) {
      result = await listDir(attempt)
      if (result) break
    }
    if (!result) {
      setError('Unable to read this folder.')
      setListing(null)
      setLoading(false)
      return
    }
    setEffectiveRootPath(pathWithinRoot(result.path, rootPath) ? rootPath : result.root)
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
      setPreviewError(result.error)
    } else {
      setPreview(result)
    }
    setPreviewLoading(false)
  }

  // When the conversation's workspace changes, reset to its root (reload if open).
  useEffect(() => {
    setPath(rootPath)
    setEffectiveRootPath(rootPath)
    setListing(null)
    setPreview(null)
    setPreviewError(null)
    setSearchInput('')
    setSearchQuery('')
    if (open) void load(rootPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath])

  // Refresh the listing every time the panel opens (not just the first time),
  // so files created/changed while it was closed show up without a manual reload.
  useEffect(() => {
    if (open) void load(path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Nothing to render — the parent owns the toggle trigger and the panel is
  // closed. But if a floating preview is open, keep the component alive so the
  // preview stays visible (it portals to document.body, so it doesn't need the
  // browser panel to be rendered).
  if (!open && !showOwnToggle && !preview) return null

  // The backend supplies a parent only while it remains inside BROWSE_ROOT.
  const canGoUp = Boolean(listing?.parent)
  const isAtWorkspace = path === rootPath
  const relLabel = path === effectiveRootPath
    ? '.'
    : path.startsWith(`${effectiveRootPath}/`)
      ? path.slice(effectiveRootPath.length + 1)
      : path

  const matchesTypeFilter = (name: string) => typeFilter === 'all' || fileTypeIcon(name) === typeFilter
  const isSearching = Boolean(searchQuery)
  const visibleDirs = isSearching ? [] : (listing?.dirs ?? [])
  const visibleFiles = (isSearching ? [] : listing?.files ?? []).filter((file) => matchesTypeFilter(file.name))
  const visibleSearchResults = (searchResults ?? []).filter((entry) => entry.type === 'dir' || matchesTypeFilter(entry.name))
  const dirsToShow: FsEntry[] = isSearching ? visibleSearchResults.filter((entry) => entry.type === 'dir') : visibleDirs
  const filesToShow: FsFileEntry[] = isSearching
    ? visibleSearchResults
        .filter((entry) => entry.type === 'file')
        .map((entry) => ({ name: entry.name, path: entry.path, size: entry.size ?? null }))
    : visibleFiles
  const previewNode = preview ? (
    <FloatingPreview
      preview={preview}
      onClose={() => setPreview(null)}
    />
  ) : null

  return (
    <div className={`file-browser ${open ? 'open' : ''} list-only`}>
      {showOwnToggle ? (
        <button type="button" className="file-browser-toggle" onClick={onToggle} aria-expanded={open}>
          <span className={`file-browser-caret ${open ? 'open' : ''}`} aria-hidden>▾</span>
          <span className="tree-label">Files</span>
          {open ? <span className="file-browser-cwd" title={path}>{relLabel}</span> : null}
          <span className="file-browser-action">{open ? 'Hide' : 'Browse'}</span>
        </button>
      ) : null}

      {open ? (
        <div className="file-browser-body">
          <div className="file-browser-path-row">
            <div className="file-browser-path" title={path}>{path}</div>
            {!showOwnToggle ? (
              // Without its own toggle pill (the TUI header button lives
              // underneath this floating panel once it's open, so it can't be
              // clicked to close), the panel needs its own close control.
              <button
                type="button"
                className="file-browser-close-inline"
                onClick={onToggle}
                aria-label="Close file browser"
                title="Close file browser"
              >
                ×
              </button>
            ) : null}
          </div>
          <div className="file-browser-bar">
            <button
              type="button"
              className="file-browser-up"
              disabled={!canGoUp || loading}
              onClick={() => listing?.parent && void load(listing.parent)}
              title={canGoUp ? 'Up one folder' : 'At server browse root'}
            >
              ↑ ..
            </button>
            <button
              type="button"
              className="file-browser-home"
              disabled={isAtWorkspace || loading}
              onClick={() => void load(rootPath)}
              title="Return to workspace"
              aria-label="Return to workspace"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3.5 10.5 12 3.75l8.5 6.75" />
                <path d="M5.75 9.25v10h12.5v-10M9.5 19.25v-6h5v6" />
              </svg>
            </button>
            <button
              type="button"
              className="file-browser-refresh"
              disabled={loading}
              onClick={() => void load(path)}
              title="Refresh"
              aria-label="Refresh folder"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19.25 8.25V3.75m0 0h-4.5m4.5 0-3.1 3.1a7.5 7.5 0 1 0 2.65 7.4" />
              </svg>
            </button>
            <button
              type="button"
              className="file-browser-upload"
              disabled={loading || uploading || isSearching}
              onClick={() => uploadInputRef.current?.click()}
              title={isSearching ? 'Clear search to upload' : `Upload a file to this folder`}
            >
              {uploading ? '↑ …' : '↑ Upload'}
            </button>
            <input
              ref={uploadInputRef}
              type="file"
              hidden
              onChange={(event) => void handleUpload(event)}
            />
          </div>

          <div className="file-browser-filters">
            <input
              type="search"
              className="file-browser-search"
              placeholder="Search files in this folder…"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => event.stopPropagation()}
            />
            <select
              className="file-browser-type-filter"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
              title="Filter by file type"
            >
              {FILE_TYPE_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {error ? <p className="error-text">{error}</p> : null}
          {searchError ? <p className="error-text">{searchError}</p> : null}
          {isSearching && searchTruncated ? (
            <p className="file-browser-hint">Showing first matches only — refine your search.</p>
          ) : null}

          <div className="file-browser-list">
            {loading || (isSearching && searching) ? (
              <div className="file-browser-empty">{isSearching ? 'Searching…' : 'Loading…'}</div>
            ) : (isSearching ? searchResults !== null : Boolean(listing)) && (dirsToShow.length || filesToShow.length) ? (
              <>
                {dirsToShow.map((dir) => (
                  <div
                    role="button"
                    tabIndex={0}
                    key={dir.path}
                    className="file-row dir"
                    title={dir.name}
                    draggable
                    onDragStart={(event) => {
                      event.stopPropagation()
                      event.dataTransfer.effectAllowed = 'copy'
                      event.dataTransfer.setData('application/x-agent-rider-file-path', dir.path)
                      event.dataTransfer.setData('text/plain', dir.path)
                    }}
                    onClick={() => void load(dir.path)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      void load(dir.path)
                    }}
                  >
                    <span className="file-row-name">
                      <span className="file-row-icon dir" aria-hidden>DIR</span>
                      <span className="file-row-label">{dir.name}</span>
                    </span>
                  </div>
                ))}
                {filesToShow.map((file) => (
                  <div
                    role="button"
                    tabIndex={0}
                    key={file.path}
                    className={`file-row file ${preview?.path === file.path ? 'active' : ''}`}
                    title={file.path}
                    draggable
                    onDragStart={(event) => {
                      event.stopPropagation()
                      event.dataTransfer.effectAllowed = 'copy'
                      event.dataTransfer.setData('application/x-agent-rider-file-path', file.path)
                      event.dataTransfer.setData('text/plain', file.path)
                    }}
                    onClick={() => void openFile(file.path)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      void openFile(file.path)
                    }}
                  >
                    <span className="file-row-name">
                      <span className="file-row-icon file" aria-hidden>{fileTypeIcon(file.name)}</span>
                      <span className="file-row-label">{file.name}</span>
                    </span>
                    <span className="file-row-size">{formatBytes(file.size)}</span>
                    <span className="file-row-actions">
                      <a
                        className="file-row-action download"
                        href={fileDownloadUrl(file.path)}
                        download={file.name}
                        title={`Download ${file.name}`}
                        onClick={(event) => event.stopPropagation()}
                        onDragStart={(event) => event.stopPropagation()}
                        draggable={false}
                      >
                        Download
                      </a>
                      <button
                        type="button"
                        className="file-row-action delete"
                        title={`Delete ${file.name}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          setPendingDelete(file)
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  </div>
                ))}
              </>
            ) : (
              <div className="file-browser-empty">{isSearching ? 'No matches found.' : 'Empty folder.'}</div>
            )}
          </div>

          {previewLoading ? <div className="file-browser-empty">Opening file…</div> : null}
          {previewError ? <p className="error-text">{previewError}</p> : null}
        </div>
      ) : null}

      {/* The floating preview portals to document.body, so it lives outside
          the file browser's open/close toggle — closing the browser panel
          no longer kills an open preview. */}
      {previewNode}

      {pendingDelete ? (
        <div className="confirm-overlay" onClick={() => !deleting && setPendingDelete(null)}>
          <div className="confirm-dialog card" onClick={(event) => event.stopPropagation()}>
            <div className="picker-head">
              <div>
                <div className="eyebrow">Confirm delete</div>
                <h3>{pendingDelete.name}</h3>
              </div>
              <button
                type="button"
                className="picker-close"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <p className="confirm-copy">
              Permanently delete this file from the workspace? This cannot be undone.
            </p>

            <div className="picker-actions confirm-actions">
              <button
                type="button"
                className="picker-cancel"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="send-button danger-button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// Interactive areas that should keep their own mouse behaviour rather than
// starting a drag (shared by cards and workspace panels).
const DRAG_EXCLUDE = 'input, textarea, select, button, a, iframe, [contenteditable="true"], .win-body, .win-promptbar, .conv-agent-terminal, .terminal-screen, .file-browser, .file-preview'

// Layout preset picker shown in the workspace toolbar. Icons are tiny inline
// bars mirroring each grid shape (single / 2-up / quad / 3-col / master+stack
// / free grid) rather than importing an icon set.
const LAYOUT_PRESETS: { id: LayoutPreset; title: string; icon: ReactNode }[] = [
  {
    id: 'single', title: 'Single column',
    icon: <div className="preset-icon-block" style={{ width: 15, height: 12 }} />,
  },
  {
    id: 'two-up', title: '2-up columns',
    icon: (
      <div style={{ display: 'flex', gap: 2 }}>
        <div className="preset-icon-block" style={{ width: 6.5, height: 12 }} />
        <div className="preset-icon-block" style={{ width: 6.5, height: 12 }} />
      </div>
    ),
  },
  {
    id: 'quad', title: '2×2 quad',
    icon: (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 2 }}>
        <div className="preset-icon-block" style={{ width: 6.5, height: 5.5 }} />
        <div className="preset-icon-block" style={{ width: 6.5, height: 5.5 }} />
        <div className="preset-icon-block" style={{ width: 6.5, height: 5.5 }} />
        <div className="preset-icon-block" style={{ width: 6.5, height: 5.5 }} />
      </div>
    ),
  },
  {
    id: 'three-col', title: '3-column dense',
    icon: (
      <div style={{ display: 'flex', gap: 2 }}>
        <div className="preset-icon-block" style={{ width: 4, height: 12 }} />
        <div className="preset-icon-block" style={{ width: 4, height: 12 }} />
        <div className="preset-icon-block" style={{ width: 4, height: 12 }} />
      </div>
    ),
  },
  {
    id: 'master-stack', title: 'Master + stack',
    icon: (
      <div style={{ display: 'flex', gap: 2 }}>
        <div className="preset-icon-block" style={{ width: 9, height: 12 }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div className="preset-icon-block" style={{ width: 5, height: 3.3 }} />
          <div className="preset-icon-block" style={{ width: 5, height: 3.3 }} />
          <div className="preset-icon-block" style={{ width: 5, height: 3.3 }} />
        </div>
      </div>
    ),
  },
  {
    id: 'free', title: 'Free grid',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.3" />
        <line x1="6" y1="1.5" x2="6" y2="14.5" stroke="currentColor" strokeWidth="1.1" />
        <line x1="10.5" y1="1.5" x2="10.5" y2="14.5" stroke="currentColor" strokeWidth="1.1" />
        <line x1="1.5" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.1" />
      </svg>
    ),
  },
]

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

function resetDraggableAfterPointerSettles(element: HTMLElement) {
  const reset = () => {
    element.draggable = false
    window.removeEventListener('mouseup', reset, true)
    window.removeEventListener('dragend', reset, true)
    window.removeEventListener('blur', reset)
  }
  window.addEventListener('mouseup', reset, true)
  window.addEventListener('dragend', reset, true)
  window.addEventListener('blur', reset)
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
        if (!ref.current) return
        const canDrag = !target.closest(DRAG_EXCLUDE)
        ref.current.draggable = canDrag
        if (canDrag) resetDraggableAfterPointerSettles(ref.current)
      }}
      onMouseUp={() => {
        if (ref.current) ref.current.draggable = false
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
        if (ref.current) ref.current.draggable = false
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
  collapsed,
  metaCollapsed,
  active,
  isNewDone,
  onToggle,
  onMetaCollapsedChange,
  onTitleChange,
  onCategoryChange,
  onProjectChange,
  onAgentChange,
  onAgentCommandChange,
  onOpenPicker,
  onClose,
  dragging,
  dragActive,
  onDragStartCard,
  onDragEndCard,
  onDropOnCard,
  agentTerminalState,
  onAgentTerminalStateChange,
  maximized = false,
  onToggleMaximize,
}: {
  run: RunNode
  collapsed: boolean
  metaCollapsed: boolean
  active: boolean
  isNewDone: boolean
  onToggle: () => void
  onMetaCollapsedChange: (collapsed: boolean) => void
  onTitleChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onProjectChange: (value: string) => void
  onAgentChange: (value: AgentType) => void
  onAgentCommandChange: (value: string) => void
  onOpenPicker: () => void
  onClose: () => void
  dragging: boolean
  dragActive: boolean
  onDragStartCard: () => void
  onDragEndCard: () => void
  onDropOnCard: (after: boolean) => void
  agentTerminalState?: WorkspacePanelState
  onAgentTerminalStateChange: (patch: WorkspacePanelState) => void
  maximized?: boolean
  onToggleMaximize?: () => void
}) {
  const agentAvailability = useAgentAvailability()
  const customAgentCommand = (run.agentCommand ?? '').trim()
  const cardRef = useRef<HTMLElement | null>(null)
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [dragOverAfter, setDragOverAfter] = useState(false)
  const dragOverAfterRef = useRef(false)
  const [customCommandDraft, setCustomCommandDraft] = useState(run.agentCommand ?? '')
  const tone = windowStatusTone(run.jobStatus, false)

  useEffect(() => setCustomCommandDraft(run.agentCommand ?? ''), [run.id, run.agentCommand])

  function commitCustomAgentCommand() {
    const next = customCommandDraft.trim()
    if (next !== (run.agentCommand ?? '').trim()) onAgentCommandChange(next)
  }

  return (
    <article
      id={`conversation-${run.id}`}
      ref={cardRef}
      className={`conv-card ${collapsed ? 'collapsed' : ''} ${active ? 'active' : ''} ${dragging ? 'dragging' : ''} ${dragOver ? (dragOverAfter ? 'drag-over after' : 'drag-over') : ''}`}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement
        if (!cardRef.current) return
        const canDrag = !target.closest(DRAG_EXCLUDE)
        cardRef.current.draggable = canDrag
        if (canDrag) resetDraggableAfterPointerSettles(cardRef.current)
      }}
      onMouseUp={() => { if (cardRef.current) cardRef.current.draggable = false }}
      onDragStart={(event) => {
        const target = event.target as HTMLElement
        if (target.closest(DRAG_EXCLUDE)) return event.preventDefault()
        beginElementDrag(event, cardRef.current, run.id)
        onDragStartCard()
      }}
      onDragEnd={() => {
        if (cardRef.current) cardRef.current.draggable = false
        setDragOver(false)
        onDragEndCard()
      }}
      onDragOver={(event) => {
        if (!dragActive) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        const after = event.clientY > rect.top + rect.height / 2
        dragOverAfterRef.current = after
        setDragOver(true)
        setDragOverAfter(after)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(false)
      }}
      onDrop={(event) => {
        if (!dragActive) return
        event.preventDefault()
        setDragOver(false)
        onDropOnCard(dragOverAfterRef.current)
      }}
    >
      <div className="win-titlebar" onDoubleClick={onToggle} title="Drag to reorder · double-click to collapse">
        <WinGrip />
        <span className="win-dot" style={{ background: tone.dot }} aria-hidden />
        <input className="win-title-input" value={run.task} onChange={(event) => onTitleChange(event.target.value)} onClick={(event) => event.stopPropagation()} placeholder="untitled" aria-label="Conversation title" />
        <span className="win-meta" title={timeLabel(run.createdAt)}>{run.category || '···'} | {run.project || '···'}</span>
        <div className="win-spacer" />
        {isNewDone ? <span className="new-dot" title="New result" /> : null}
        <button type="button" className={`win-btn ${fileBrowserOpen ? 'active' : ''}`} title={fileBrowserOpen ? 'Hide file browser' : 'Browse files'} onClick={(event) => { event.stopPropagation(); setFileBrowserOpen((current) => !current) }}><WinFilesIcon /></button>
        <button type="button" className={`win-btn ${metaCollapsed ? '' : 'active'}`} title={metaCollapsed ? 'Show context' : 'Hide context'} onClick={(event) => { event.stopPropagation(); onMetaCollapsedChange(!metaCollapsed) }}><WinContextIcon /></button>
        <button type="button" className="win-btn" title={collapsed ? 'Expand window' : 'Collapse window'} onClick={(event) => { event.stopPropagation(); onToggle() }}>{collapsed ? <WinConversationExpandIcon /> : <WinConversationCollapseIcon />}</button>
        {onToggleMaximize ? <button type="button" className="win-btn" title={maximized ? 'Restore' : 'Full window'} onClick={(event) => { event.stopPropagation(); onToggleMaximize() }}><WinFullscreenIcon active={Boolean(agentTerminalState?.fullWindow)} /></button> : null}
        <button type="button" className="win-btn win-btn-close" title="Close window" onClick={(event) => { event.stopPropagation(); onClose() }}><WinCloseIcon /></button>
      </div>

      {!collapsed ? (
        <div className="conv-card-body">
          {!metaCollapsed ? (
            <div className="conv-meta">
              <div className="conv-meta-fields">
                <div className="conv-meta-row"><span className="tree-label">Category</span><input className="conv-input" list="known-categories" value={run.category} onChange={(event) => onCategoryChange(event.target.value)} /></div>
                <div className="conv-meta-row"><span className="tree-label">Project</span><input className="conv-input" list="known-projects" value={run.project} onChange={(event) => onProjectChange(event.target.value)} /></div>
                <div className="conv-meta-row"><span className="tree-label">Agent</span><select className="conv-input conv-agent-select" value={run.agentType} onChange={(event) => onAgentChange(event.target.value as AgentType)}>{renderAgentOptions(agentAvailability)}</select></div>
                {run.agentType === 'custom' ? <div className="conv-meta-row"><span className="tree-label">Command</span><input className="conv-input conv-agent-command" value={customCommandDraft} onChange={(event) => setCustomCommandDraft(event.target.value)} onBlur={commitCustomAgentCommand} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitCustomAgentCommand(); event.currentTarget.blur() } }} placeholder="bash command" /></div> : null}
                <div className="conv-meta-row"><span className="tree-label">Workspace</span><button type="button" className="conv-workspace-btn" onClick={onOpenPicker} title={run.workspacePath}><span className="conv-workspace-path">{run.workspacePath}</span><span className="conv-workspace-action">Change…</span></button></div>
              </div>
            </div>
          ) : null}
          <div className={`conv-content-shell tui-content-shell ${agentTerminalState?.fullWindow ? 'file-browser-full-window' : ''}`}>
            <FileBrowser rootPath={run.workspacePath} open={fileBrowserOpen} onToggle={() => setFileBrowserOpen((current) => !current)} showOwnToggle={false} />
            {run.agentType !== 'custom' || customAgentCommand ? (
              <div className="conv-agent-terminal"><WebTerminal key={`${run.agentType}:${customAgentCommand}:${run.workspacePath}`} agent={run.agentType} customCommand={run.agentType === 'custom' ? customAgentCommand : undefined} sessionKey={run.id} initialCwd={run.workspacePath} eyebrow={`Agent · ${agentLabel(run.agentType)} · persistent`} title={run.agentType === 'custom' ? customAgentCommand : `${run.agentType} — interactive`} showClose={false} onClose={() => {}} collapsible={false} frameless fullWindow={agentTerminalState?.fullWindow} onStateChange={onAgentTerminalStateChange} notepad={agentTerminalState?.notepad} onNotepadChange={(text) => onAgentTerminalStateChange({ notepad: text })} /></div>
            ) : <div className="conv-agent-command-empty">Enter a bash command to launch the custom TUI agent.</div>}
          </div>
        </div>
      ) : null}
    </article>
  )
}

function ConversationTreeSidebar({
  tree,
  activeRunId,
  unreadRunIds,
  onSelect,
  onDeleteRequest,
}: {
  tree: ConversationTreeCategory[]
  activeRunId: string | null
  unreadRunIds: Set<string>
  onSelect: (runId: string) => void
  onDeleteRequest: (runId: string) => void
}) {
  const total = tree.reduce((sum, category) => sum + category.projects.reduce((projectSum, project) => projectSum + project.runs.length, 0), 0)
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())

  function toggleCategory(key: string) {
    setCollapsedCategories((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleProject(key: string) {
    setCollapsedProjects((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <nav className="conversation-sidebar sidebar-panel card" aria-label="Conversation tree">
      <div className="sidebar-head">
        <div>
          <div className="eyebrow">Navigator</div>
          <h2>Conversation Tree</h2>
        </div>
        <span className="sidebar-count">{total}</span>
      </div>

      <div className="sidebar-body">
        {tree.length ? (
          <div className="tree-nav">
            {tree.map((category) => {
              const categoryCollapsed = collapsedCategories.has(category.category)

              return (
                <section key={category.category} className="tree-nav-category">
                  <h3>
                    <button
                      type="button"
                      className="tree-collapse-button tree-category-toggle"
                      aria-expanded={!categoryCollapsed}
                      onClick={() => toggleCategory(category.category)}
                    >
                      <span className="tree-toggle-icon" aria-hidden>
                        {categoryCollapsed ? '▸' : '▾'}
                      </span>
                      <span className="tree-toggle-text">{category.category}</span>
                    </button>
                  </h3>
                  {categoryCollapsed
                    ? null
                    : category.projects.map((project) => {
                      const projectKey = `${category.category}-${project.project}`
                      const projectCollapsed = collapsedProjects.has(projectKey)

                      return (
                        <div key={projectKey} className="tree-nav-project">
                          <button
                            type="button"
                            className="tree-nav-label tree-collapse-button tree-project-toggle"
                            aria-expanded={!projectCollapsed}
                            onClick={() => toggleProject(projectKey)}
                          >
                            <span className="tree-toggle-icon" aria-hidden>
                              {projectCollapsed ? '▸' : '▾'}
                            </span>
                            <span className="tree-toggle-text">{project.project}</span>
                          </button>
                          {projectCollapsed ? null : (
                            <div className="tree-nav-runs">
                              {project.runs.map((run) => (
                                <div key={run.id} className="tree-nav-run-row">
                                  <button
                                    type="button"
                                    className={`tree-nav-run ${activeRunId === run.id ? 'active' : ''} ${unreadRunIds.has(run.id) ? 'unread' : ''}`}
                                    onClick={() => onSelect(run.id)}
                                    aria-current={activeRunId === run.id ? 'true' : undefined}
                                  >
                                    <span className="tree-run-main">
                                      {unreadRunIds.has(run.id) ? (
                                        <span className="tree-run-unread" title="New unread result" aria-label="New unread result" />
                                      ) : null}
                                      <span className="tree-run-title">{conversationTitle(run)}</span>
                                    </span>
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
                          )}
                        </div>
                      )
                    })}
                </section>
              )
            })}
          </div>
        ) : (
          <div className="tree-empty">No conversations</div>
        )}
      </div>
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
function useAgentApps(enabled: boolean): {
  listing: AppListing
  reorder: (order: string[]) => void
  rename: (slug: string, label: string) => void
} {
  const [listing, setListing] = useState<AppListing>(EMPTY_APP_LISTING)
  const hashRef = useRef('0')

  useEffect(() => {
    if (!enabled) return
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
  }, [enabled])

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
  openPluginIds,
  onLaunchPlugin,
  apps,
  appWarnings,
  openAppSlugs,
  onLaunchApp,
  onReorderApps,
  onRenameApp,
}: {
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
  const appGroups = useMemo(() => {
    const byGroup = new Map<string, AgentApp[]>()
    for (const app of apps) {
      const group = app.group.trim() || 'Built Apps'
      const groupApps = byGroup.get(group) ?? []
      groupApps.push(app)
      byGroup.set(group, groupApps)
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [apps])

  return (
    <nav className="resource-sidebar sidebar-panel card" aria-label="Resource view">
      <div className="sidebar-head">
        <div>
          <div className="eyebrow">Resource</div>
          <h2>Resources</h2>
        </div>
      </div>

      <div className="sidebar-body">
        <div className="tree-nav">
          {/* Local Terminal now lives in the icon rail, so Tools only lists
              plugins — and disappears entirely when there are none. */}
          {pluginTools.length > 0 ? (
            <section className="tree-nav-category">
              <h3>Tools</h3>
              <div className="tree-nav-runs">
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
          ) : null}

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
            {appGroups.map(([group, groupApps]) => (
              <div key={group} className="tree-nav-project resource-app-tree">
                <div className="tree-nav-label">{group}</div>
                <div className="tree-nav-runs">
                  {groupApps.map((app) => {
                    const index = apps.findIndex((item) => item.id === app.id)
                    return (
                      <AppTool
                        key={app.id}
                        app={app}
                        open={openAppSlugs.has(app.id)}
                        canMoveUp={index > 0}
                        canMoveDown={index >= 0 && index < apps.length - 1}
                        onLaunch={() => onLaunchApp(app.id)}
                        onMove={(delta) => {
                          if (index >= 0) onReorderApps(reorderSlugs(apps, index, delta))
                        }}
                        onRename={(label) => onRenameApp(app.id, label)}
                      />
                    )
                  })}
                </div>
              </div>
            ))}
            <div className="tree-nav-runs">
              {appWarnings.map((warning, index) => (
                <div key={`warn-${index}`} className="app-warning" role="alert">
                  ⚠ {warning.id ?? warning.dir ?? 'plugin'}: {warning.error}
                </div>
              ))}
            </div>
          </section>
        </div>
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
          title={open ? `${app.label} is open` : `Open ${app.label}`}
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
  customCommand,
  sessionKey,
  eyebrow = 'Resource · Tools',
  title = 'Local Terminal',
  showClose = true,
  collapsible = true,
  collapsed,
  fullWindow,
  onStateChange,
  headerLeading,
  frameless = false,
  titleBar,
  notepad,
  onNotepadChange,
}: {
  initialCwd: string
  onClose: () => void
  /** When set, the PTY launches this TUI agent CLI instead of a login shell. */
  agent?: TuiAgentType
  /** Bash command used when `agent` is the custom TUI option. */
  customCommand?: string
  /** Stable key for a persistent (tmux-backed) terminal session that survives
   *  disconnects, panel close/reopen, and layout changes. */
  sessionKey?: string
  eyebrow?: string
  title?: string
  showClose?: boolean
  /** When false, the terminal always stays expanded and its header isn't collapsible. */
  collapsible?: boolean
  collapsed?: boolean
  fullWindow?: boolean
  onStateChange?: (patch: WorkspacePanelState) => void
  /** Rendered in the header's action row before the connection state/expand
   *  button — lets the card slot in extra controls (e.g. the File Browser
   *  toggle) that stay visible in both small and full-window modes. */
  headerLeading?: ReactNode
  /** Embedded inside another window (e.g. a TUI conversation window): the
   *  terminal skips its own titlebar. In full-window mode the host card's
   *  titlebar is rendered inside the overlay via the `titleBar` prop so
   *  the two stay visually connected. */
  frameless?: boolean
  /** Host card's titlebar rendered inside the full-window overlay. */
  titleBar?: ReactNode
  /** Persisted scratch draft (see WorkspacePanelState.notepad). */
  notepad?: string
  onNotepadChange?: (text: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTermTerminal | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<() => void>(() => {})
  const resetOnNextConnectRef = useRef(false)
  const wheelPageAccumulatorRef = useRef(0)
  const [connectionState, setConnectionState] = useState<'connecting' | 'connected' | 'closed' | 'error'>('connecting')
  const [terminalKey, setTerminalKey] = useState(0)
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const [internalFullWindow, setInternalFullWindow] = useState(false)
  const terminalCollapsed = collapsible ? (collapsed ?? internalCollapsed) : false
  const terminalFullWindow = fullWindow ?? internalFullWindow
  const agentTerminal = Boolean(agent)
  const notepadEnabled = typeof onNotepadChange === 'function'
  const [notepadOpen, setNotepadOpen] = useState(false)
  const [notepadCopied, setNotepadCopied] = useState(false)
  const usageSupported = Boolean(agent && USAGE_SUPPORTED_AGENTS.has(agent))
  const [usage, setUsage] = useState<UsageResult | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const refreshUsage = useCallback(() => {
    if (!agent || !usageSupported || usageLoading) return
    setUsageLoading(true)
    void fetchAgentUsage(agent, initialCwd, sessionKey ?? '')
      .then(setUsage)
      .finally(() => setUsageLoading(false))
  }, [agent, usageSupported, usageLoading, initialCwd, sessionKey])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const terminal = new XTermTerminal({
      cursorBlink: true,
      // Must be false for a PTY-backed terminal: the PTY already emits proper CRLF.
      // With it true, every LF gets an extra CR, which corrupts cursor positioning
      // in full-screen TUIs that render in the main buffer (e.g. the codex agent),
      // making some redraws (like the approval menu → feedback view) blank out.
      convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.3,
      macOptionClickForcesSelection: true,
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
    terminal.attachCustomKeyEventHandler((event) => {
      const wantsCopy = event.type === 'keydown' && event.key.toLowerCase() === 'c' && (event.metaKey || event.ctrlKey)
      if (!wantsCopy || !terminal.hasSelection()) return true
      event.preventDefault()
      event.stopPropagation()
      void copyToClipboard(terminal.getSelection()).catch(() => {})
      return false
    })
    const osc52Disposable = terminal.parser.registerOscHandler(52, (data) => {
      const value = parseOsc52Clipboard(data)
      if (value === null) return false
      return copyToClipboard(value).then(() => true).catch(() => false)
    })
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
    const commandParam = agent === 'custom' && customCommand ? `&command=${encodeURIComponent(customCommand)}` : ''
    const sessionParam = sessionKey ? `&session=${encodeURIComponent(sessionKey)}` : ''
    const resetParam = resetOnNextConnectRef.current ? '&reset=1' : ''
    resetOnNextConnectRef.current = false
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/store/terminal/ws?cwd=${encodeURIComponent(initialCwd)}&cols=${terminal.cols}&rows=${terminal.rows}${agentParam}${commandParam}${sessionParam}${resetParam}`,
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
      osc52Disposable.dispose()
      inputDisposable.dispose()
      socket.close()
      terminal.dispose()
      if (socketRef.current === socket) socketRef.current = null
      if (terminalRef.current === terminal) terminalRef.current = null
    }
  }, [initialCwd, terminalKey, agent, customCommand, sessionKey])

  useEffect(() => {
    if (!terminalCollapsed) window.requestAnimationFrame(() => fitRef.current())
  }, [terminalCollapsed, terminalFullWindow, terminalKey])

  // Full-screen TUI agents (codex/claude/…) don't always repaint cleanly after
  // a viewport change, so a plain refit can leave the terminal garbled when
  // entering/leaving full window. Re-attach the tmux-backed session on those
  // toggles to force a fresh redraw at the new size — the same thing the
  // Refresh button does. Skipped on the initial mount and for non-agent shells.
  const didInitFullWindowRef = useRef(false)
  useEffect(() => {
    if (!didInitFullWindowRef.current) {
      didInitFullWindowRef.current = true
      return
    }
    if (!agentTerminal || terminalCollapsed) return
    setTerminalKey((current) => current + 1)
  }, [terminalFullWindow])

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

  function toggleTerminalCollapsedState() {
    const next = !terminalCollapsed
    // A hidden terminal cannot meaningfully remain full-window. Keep these
    // states mutually exclusive so expanding it later never reveals an empty
    // full-window shell.
    if (next && terminalFullWindow) setTerminalFullWindowState(false)
    setTerminalCollapsedState(next)
  }

  function toggleTerminalFullWindowState() {
    if (terminalCollapsed) {
      // Clicking Full Window on a collapsed terminal means expand and enter
      // full-window in one transition, matching conversation-card behavior.
      setTerminalCollapsedState(false)
      setTerminalFullWindowState(true)
      return
    }
    setTerminalFullWindowState((current) => !current)
  }

  function pasteIntoTerminal(value: string) {
    terminalRef.current?.focus()
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'input', data: value }))
    }
  }

  function pageThroughTuiFromWheel(event: WheelEvent) {
    if (!agentTerminal || terminalCollapsed) return

    // tmux runs with `mouse on` (see server/store.mjs), which enables mouse
    // reporting on this outer xterm. Let xterm translate the wheel into mouse
    // sequences for tmux: tmux then scrolls its own history for normal-buffer
    // TUIs (agy), forwards to mouse-aware apps (claude), or pages alt-screen
    // apps via its WheelUpPane binding. Hijacking the wheel here instead is
    // what made agy unable to scroll back. The PageUp/PageDown fallback below
    // only remains for the no-mouse-reporting case (e.g. tmux mouse off).
    const terminal = terminalRef.current
    if (terminal && terminal.modes.mouseTrackingMode !== 'none') return

    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    terminalRef.current?.focus()
    if (socketRef.current?.readyState !== WebSocket.OPEN) return

    const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? window.innerHeight : 1
    wheelPageAccumulatorRef.current += event.deltaY * unit
    const pages = Math.trunc(wheelPageAccumulatorRef.current / TUI_WHEEL_PAGE_DELTA)
    if (!pages) return

    wheelPageAccumulatorRef.current -= pages * TUI_WHEEL_PAGE_DELTA
    const sequence = pages < 0 ? TUI_PAGE_UP : TUI_PAGE_DOWN
    const repeat = Math.min(3, Math.abs(pages))
    socketRef.current.send(JSON.stringify({ type: 'input', data: sequence.repeat(repeat) }))
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container || !agentTerminal) return undefined
    // React's delegated wheel handlers can still allow page-level scrolling in
    // some browsers. Use a native non-passive capture listener so wheel events
    // over a TUI terminal never bubble up to the Agent Rider workspace scroller.
    const handleWheel = (event: WheelEvent) => pageThroughTuiFromWheel(event)
    container.addEventListener('wheel', handleWheel, { capture: true, passive: false })
    return () => container.removeEventListener('wheel', handleWheel, { capture: true })
  }, [agentTerminal, terminalCollapsed])

  const stateTone = connectionStatusTone(connectionState)

  return (
    <section className={`web-terminal ${terminalCollapsed ? 'collapsed' : ''} ${terminalFullWindow ? 'full-window' : ''} ${frameless ? 'frameless' : ''}`} aria-label="Local Terminal">
      {frameless && terminalFullWindow && titleBar ? (
        titleBar
      ) : frameless ? null : (
      <div className="win-titlebar">
        <WinGrip />
        <span className="win-dot" style={{ background: stateTone.dot }} aria-hidden />
        <span className="win-title">{title}</span>
        <span className="win-meta">{eyebrow}</span>
        <div className="win-spacer" />
        <span className="win-status" style={{ color: stateTone.color }}>{stateTone.label}</span>
        {usageSupported ? (
          <button
            type="button"
            className="win-btn win-usage-btn"
            title={
              usageLoading
                ? 'Checking usage…'
                : !usage
                  ? 'Check usage (types the agent\'s status command into its session and reads the reply)'
                  : usage.available
                    ? usage.meters.map(usageMeterTooltipLine).join('\n')
                    : USAGE_UNAVAILABLE_LABEL[usage.reason]
            }
            aria-label="Refresh usage"
            style={{ color: usage?.available ? usageTone(Math.max(...usage.meters.map((meter) => meter.percentUsed))) : undefined }}
            onClick={(event) => {
              event.stopPropagation()
              refreshUsage()
            }}
          >
            {usageLoading
              ? '…'
              : !usage
                ? 'Usage'
                : usage.available
                  ? usageSummaryLabel(usage.meters)
                  : '—'}
          </button>
        ) : null}
        {headerLeading}
        {collapsible ? (
          <button
            type="button"
            className="win-btn"
            title={terminalCollapsed ? 'Expand window' : 'Collapse window'}
            aria-label={terminalCollapsed ? 'Expand window' : 'Collapse window'}
            aria-expanded={!terminalCollapsed}
            onClick={toggleTerminalCollapsedState}
          >
            {terminalCollapsed ? <WinConversationExpandIcon /> : <WinConversationCollapseIcon />}
          </button>
        ) : null}
        <button
          type="button"
          className="win-btn"
          title={terminalFullWindow ? 'Exit full window' : 'Expand to full window'}
          aria-label={terminalFullWindow ? 'Exit full window' : 'Expand to full window'}
          onClick={(event) => {
            event.stopPropagation()
            toggleTerminalFullWindowState()
          }}
        >
          <WinFullscreenIcon active={terminalFullWindow} />
        </button>
        {showClose ? (
          <button
            type="button"
            className="win-btn win-btn-close"
            title="Close Local Terminal"
            aria-label="Close Local Terminal"
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
          >
            <WinCloseIcon />
          </button>
        ) : null}
      </div>
      )}

      <div className="terminal-body" aria-hidden={terminalCollapsed}>
        <div
          className="terminal-screen"
          ref={containerRef}
          role="application"
          aria-label="Interactive shell terminal"
          onClick={() => terminalRef.current?.focus()}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('application/x-agent-rider-file-path')) event.preventDefault()
          }}
          onDrop={(event) => {
            const filePath = filePathFromDrag(event)
            if (!filePath) return
            event.preventDefault()
            event.stopPropagation()
            pasteIntoTerminal(filePath)
          }}
        />

        {notepadEnabled && notepadOpen ? (
          <div className="terminal-notepad">
            <div className="terminal-notepad-head">
              <span className="terminal-notepad-title">Notepad</span>
              <span className="terminal-notepad-hint">Draft safely — Enter adds a line, nothing is sent until you Insert.</span>
            </div>
            <textarea
              className="terminal-notepad-input"
              value={notepad ?? ''}
              onChange={(event) => onNotepadChange?.(event.target.value)}
              // Keep every keystroke (Enter, IME composition, shortcuts) inside the
              // textarea so it never reaches the TUI until the user explicitly inserts.
              onKeyDown={(event) => event.stopPropagation()}
              placeholder="Compose a prompt or jot notes here, then Insert into the terminal…"
              spellCheck={false}
              rows={4}
            />
            <div className="terminal-notepad-actions">
              <button
                type="button"
                className="terminal-clear accent"
                disabled={!(notepad ?? '').length}
                title="Type this text into the terminal (without pressing Enter — you review, then send)"
                onClick={() => {
                  if (notepad) pasteIntoTerminal(notepad)
                }}
              >
                Insert to terminal
              </button>
              <button
                type="button"
                className="terminal-clear"
                disabled={!(notepad ?? '').length}
                title="Copy the draft to the clipboard"
                onClick={() => {
                  if (!notepad) return
                  void navigator.clipboard?.writeText(notepad).then(() => {
                    setNotepadCopied(true)
                    window.setTimeout(() => setNotepadCopied(false), 1200)
                  })
                }}
              >
                {notepadCopied ? 'Copied' : 'Copy'}
              </button>
              <div className="terminal-notepad-spacer" />
              <button
                type="button"
                className="terminal-clear"
                disabled={!(notepad ?? '').length}
                title="Clear the draft"
                onClick={() => onNotepadChange?.('')}
              >
                Clear
              </button>
            </div>
          </div>
        ) : null}

        <div className="terminal-footer">
          <button
            type="button"
            className="terminal-clear"
            title={agentTerminal ? 'Reset the stuck TUI agent session' : 'Reset the persistent terminal session'}
            onClick={() => {
              resetOnNextConnectRef.current = true
              setTerminalKey((current) => current + 1)
            }}
          >
            Reset
          </button>
          {notepadEnabled ? (
            <button
              type="button"
              className={`terminal-clear ${notepadOpen ? 'active' : ''}`}
              title={notepadOpen ? 'Hide the notepad' : 'Open a notepad to draft prompts safely (IME-friendly, no accidental Enter)'}
              aria-expanded={notepadOpen}
              onClick={() => setNotepadOpen((current) => !current)}
            >
              Notepad{(notepad ?? '').trim().length ? ' •' : ''}
            </button>
          ) : null}
          {agentTerminal ? (
            <span className="terminal-cwd">{initialCwd === DEFAULT_TERMINAL_CWD ? '~/' : initialCwd}</span>
          ) : null}
          <button
            type="button"
            className="terminal-clear"
            onClick={() => {
              setTerminalKey((current) => current + 1)
            }}
          >
            Refresh
          </button>
        </div>
      </div>
    </section>
  )
}

function PasswordUnlock({ onUnlocked }: { onUnlocked: (status: PasswordStatus) => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!password || busy) return
    setBusy(true)
    setError(null)
    const result = await loginPagePassword(password)
    setBusy(false)
    if ('error' in result) {
      setError(result.error)
      return
    }
    setPassword('')
    onUnlocked(result)
  }

  return (
    <div className="password-overlay">
      <form className="password-panel" onSubmit={submit}>
        <div>
          <div className="eyebrow">Agent Rider</div>
          <h2>Page Locked</h2>
        </div>
        <label className="password-field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            autoFocus
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error ? <div className="password-error">{error}</div> : null}
        <button type="submit" className="send-button password-submit" disabled={!password || busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}

function PasswordDialog({
  status,
  onClose,
  onStatusChange,
}: {
  status: PasswordStatus
  onClose: () => void
  onStatusChange: (status: PasswordStatus) => void
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [nextPassword, setNextPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = status.enabled ? 'Change Password' : 'Set Password'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    if (nextPassword !== confirmPassword) {
      setError('New passwords do not match')
      return
    }
    setBusy(true)
    setError(null)
    const result = await setPagePassword(status.enabled ? currentPassword : '', nextPassword)
    setBusy(false)
    if ('error' in result) {
      setError(result.error)
      return
    }
    onStatusChange(result)
    onClose()
  }

  async function lockPage() {
    if (!status.enabled || busy) return
    setBusy(true)
    await logoutPagePassword()
    setBusy(false)
    onStatusChange({ ...status, authenticated: false })
    onClose()
  }

  return (
    <div className="password-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <form className="password-panel" onSubmit={submit}>
        <div className="password-head">
          <div>
            <div className="eyebrow">Security</div>
            <h2>{title}</h2>
          </div>
          <button type="button" className="card-close" onClick={onClose} aria-label="Close password dialog">
            ×
          </button>
        </div>

        {status.enabled ? (
          <label className="password-field">
            <span>Current password</span>
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
            />
          </label>
        ) : null}

        <label className="password-field">
          <span>New password</span>
          <input
            type="password"
            value={nextPassword}
            onChange={(event) => setNextPassword(event.target.value)}
            autoComplete="new-password"
          />
        </label>

        <label className="password-field">
          <span>Confirm password</span>
          <input
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
          />
        </label>

        {error ? <div className="password-error">{error}</div> : null}

        <div className="password-actions">
          {status.enabled ? (
            <button type="button" className="password-secondary" onClick={lockPage} disabled={busy}>
              Lock page
            </button>
          ) : null}
          <button
            type="submit"
            className="send-button password-submit"
            disabled={busy || !nextPassword || !confirmPassword || (status.enabled && !currentPassword)}
          >
            {busy ? 'Saving…' : status.enabled ? 'Change password' : 'Set password'}
          </button>
        </div>
      </form>
    </div>
  )
}

function isBusyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /session busy|subagent still running|busy|active stream/i.test(message)
}

function isThinkingPlaceholder(response: string) {
  return response === 'Thinking…' || response === 'Thinking...'
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
  const hydratedRef = useRef(false)
  const runsRef = useRef<RunNode[]>([])

  const [runs, setRuns] = useState<RunNode[]>([])
  const [resources, setResources] = useState<ResourceItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [workspaceRoot, setWorkspaceRoot] = useState(DEFAULT_WORKSPACE_CWD)
  const [passwordStatus, setPasswordStatus] = useState<PasswordStatus | null>(null)
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)

  // Per-conversation UI state.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [metaCollapsedIds, setMetaCollapsedIds] = useState<Set<string>>(new Set())
  const [newDoneIds, setNewDoneIds] = useState<Set<string>>(new Set())
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  // Tiling layout preset for the workspace canvas. 'single'/'two-up' behave like
  // the original independent-column stacks; the rest are auto-growing CSS grids.
  const [layoutPreset, setLayoutPreset] = useState<LayoutPreset>('single')
  const [freeRows, setFreeRows] = useState(2)
  const [freeCols, setFreeCols] = useState(3)
  // Key of a single block (card or panel) temporarily blown up to fill the
  // whole workspace canvas. Transient view state — not persisted.
  const [maximizedKey, setMaximizedKey] = useState<string | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // Hovering the collapsed rail temporarily reveals it as a floating overlay
  // without reflowing the workspace. Transient — not persisted.
  const [sidebarPeek, setSidebarPeek] = useState(false)
  // Which menu the rail's content panel shows. The icon rail is an activity bar
  // now: one icon per menu, and only the selected one is mounted (so it gets the
  // panel's full height instead of a 50/50 split).
  const [railPanel, setRailPanel] = useState<'navigator' | 'resources'>('navigator')
  // Hovering a rail icon previews its menu: switches the panel, and (while
  // collapsed) floats it out on peek.
  const showRailPanel = useCallback(
    (panel: 'navigator' | 'resources') => {
      setRailPanel(panel)
      if (sidebarCollapsed) setSidebarPeek(true)
    },
    [sidebarCollapsed],
  )
  // Clicking pins the menu open — or collapses the rail if it's already the
  // pinned menu, so the same icon toggles.
  const openRailPanel = useCallback(
    (panel: 'navigator' | 'resources') => {
      setRailPanel(panel)
      setSidebarPeek(false)
      setSidebarCollapsed((current) => (current ? false : railPanel === panel))
    },
    [railPanel],
  )
  // Bottom-left settings gear popover (Password, for now).
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Empty tile placeholder → conversation picker overlay. Transient view state.
  const [openWindowPickerOpen, setOpenWindowPickerOpen] = useState(false)
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
  const { listing: appListing, reorder: reorderApps, rename: renameAppLabel } = useAgentApps(Boolean(passwordStatus?.authenticated))

  useEffect(() => {
    runsRef.current = runs
  }, [runs])

  const terminalOpen = panelOrder.includes('terminal')
  const openPluginIds = useMemo(
    () => new Set(panelOrder.filter((p) => p.startsWith('plugin:')).map((p) => p.slice('plugin:'.length))),
    [panelOrder],
  )
  const openAppSlugs = useMemo(
    () =>
      new Set(
        panelOrder
          .filter((panelId) => panelId.startsWith('app:'))
          .map((panelId) => panelId.slice('app:'.length)),
      ),
    [panelOrder],
  )

  function openPanel(panelId: string) {
    if (!panelOrder.includes(panelId)) placeNewBlock(panelId)
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

  function setPanelColumn(panelId: string, column: number) {
    setPanelColumns((current) => ({ ...current, [panelId]: column }))
  }

  function updatePanelState(panelId: string, patch: WorkspacePanelState) {
    setPanelStates((current) => {
      const nextState = { ...(current[panelId] ?? {}), ...patch }
      const normalized: WorkspacePanelState = {}
      if (typeof nextState.collapsed === 'boolean') normalized.collapsed = nextState.collapsed
      if (typeof nextState.fullWindow === 'boolean') normalized.fullWindow = nextState.fullWindow
      if (typeof nextState.notepad === 'string') normalized.notepad = nextState.notepad
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

  const hasContent = runs.some((run) => run.cardKind !== 'app-builder') || panelOrder.length > 0
  // Cards hidden via their close button drop out of the stack but stay in the tree.
  const visibleRuns = useMemo(() => runs.filter((run) => run.cardKind !== 'app-builder' && !closedRunIds.has(run.id)), [runs, closedRunIds])
  // One toolbar usage button per distinct agent type in use, checked against
  // that agent's most recently created conversation.
  const usageAgentRuns = useMemo(() => {
    const byAgent = new Map<AgentType, RunNode>()
    for (const run of visibleRuns) {
      if (!USAGE_SUPPORTED_AGENTS.has(run.agentType)) continue
      const existing = byAgent.get(run.agentType)
      if (!existing || run.createdAt > existing.createdAt) byAgent.set(run.agentType, run)
    }
    return Array.from(byAgent.values())
  }, [visibleRuns])
  const hasLegacyDefaultWorkspace = useMemo(
    () => runs.some((run) => run.workspacePath === DEFAULT_WORKSPACE_CWD),
    [runs],
  )

  function toggleCollapse(runId: string) {
    setActiveRunId(runId)
    const willCollapse = !collapsedIds.has(runId)

    // Keep collapse and leaving either maximize mode in the same event. A
    // deferred cleanup effect can race with the next full-window click and
    // clear the state that click just enabled.
    if (willCollapse) {
      setMaximizedKey((current) => (current === runId ? null : current))
      setPanelStates((current) => {
        const key = agentTerminalStateKey(runId)
        if (!current[key]?.fullWindow) return current
        return { ...current, [key]: { ...current[key], fullWindow: false } }
      })
    }

    setCollapsedIds((current) => {
      const next = new Set(current)
      if (willCollapse) next.add(runId)
      else next.delete(runId)
      return next
    })
    // Note: the unread dot is NOT cleared here. It clears only once the new
    // reply actually scrolls into view (see the card's IntersectionObserver).
  }

  // A full-window card must have a body to render. Expanding here also keeps
  // the TUI overlay from hiding its ordinary titlebar while the terminal is
  // still unmounted because the card was collapsed.
  function expandConversation(runId: string) {
    setCollapsedIds((current) => {
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
      workspacePath: workspaceRoot,
      task: '',
      job: 'Draft',
      jobStatus: 'queued',
      resourceIds: [],
      agentType: 'codex',
      agentCommand: '',
      cardKind: 'conversation',
      column: 0,
      createdAt: new Date().toISOString(),
    }
    setRuns((current) => [run, ...current])
    placeNewBlock(run.id)
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
    updateRunContext(runId, { workspacePath: path })
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

  // If a maximized block closes (or the layout preset changes), fall back to
  // the normal grid instead of showing a stale maximize state.
  useEffect(() => {
    if (maximizedKey && !orderedKeys.includes(maximizedKey)) setMaximizedKey(null)
  }, [maximizedKey, orderedKeys])

  // Where a block that's just been opened (new card, re-launched card, Tool or
  // App panel) lands. Blocks fill the grid densely in layoutOrder, so the first
  // pane without a window is always the slot right after the last live block.
  // Rewriting layoutOrder to "the blocks on screen now, then this one" is what
  // keeps the newcomer from shoving anyone aside: a block that was open before
  // still has a stale layoutOrder entry, and honoring it would re-insert the
  // block mid-grid and push every later window one slot along.
  function placeNewBlock(key: string) {
    const live = orderedKeys.filter((k) => k !== key)
    setLayoutOrder([...live, key])
    // The stack presets have no implicit slots, so the emptier column stands in
    // for "the pane with no window".
    if (layoutPreset === 'two-up') {
      const left = live.filter((k) => columnOf(k) === 0).length
      const right = live.filter((k) => columnOf(k) === 1).length
      setColumnOf(key, right < left ? 1 : 0)
    }
    // Free grid is the one preset with a fixed capacity — a full grid grows a
    // row so the newcomer opens its own pane at the bottom instead of
    // overflowing an unslotted one. The rest auto-grow rows on their own.
    if (layoutPreset === 'free') {
      const count = live.length + 1
      if (count > freeRows * freeCols) setFreeRows(Math.ceil(count / freeCols))
    }
  }

  function reorderKeys(keys: string[], draggedKey: string, targetKey: string | null, after: boolean) {
    const without = keys.filter((k) => k !== draggedKey)
    if (!targetKey) return [...without, draggedKey]
    let idx = without.indexOf(targetKey)
    if (idx < 0) return [...without, draggedKey]
    if (after) idx += 1
    return [...without.slice(0, idx), draggedKey, ...without.slice(idx)]
  }

  // Drop the dragged block before/after a target block (any mix of card/panel),
  // inheriting the target's column in two-column mode. Tile presets ignore
  // per-block columns — grid position is implicit from layoutOrder.
  function handleDropOnBlock(targetKey: string, after: boolean) {
    if (!draggingKey || draggingKey === targetKey) return
    if (layoutPreset === 'two-up') setColumnOf(draggingKey, columnOf(targetKey))
    setLayoutOrder(reorderKeys(orderedKeys, draggingKey, targetKey, after))
    setDraggingKey(null)
  }

  // Drop onto a column's empty space → append to the end of that column.
  function handleDropToColumn(column: number) {
    if (!draggingKey) return
    if (layoutPreset === 'two-up') setColumnOf(draggingKey, column)
    setLayoutOrder(reorderKeys(orderedKeys, draggingKey, null, false))
    setDraggingKey(null)
  }

  // Drop onto the tile grid's empty space (not on a specific block) → append
  // to the end of the shared order.
  function handleDropToEnd() {
    if (!draggingKey) return
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
      if (run.cardKind === 'app-builder') continue
      // Blank drafts (category, project AND title all unfilled) stay out of the
      // tree — they'd pile up as "Uncategorized / No project" noise. They join
      // it as soon as the user fills any of the three fields, or sends the
      // first prompt (which auto-derives them). The card itself still lives in
      // the workspace and is persisted as usual.
      if (!run.category.trim() && !run.project.trim() && !run.task.trim()) continue
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
    if (pickerRunId === runId) {
      setPickerRunId(null)
    }

    if (activeRunId === runId) {
      setActiveRunId(null)
    }

    setRuns((current) => current.filter((run) => run.id !== runId))
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

  // Clear a conversation's unread "new result" dot. Driven by the card's
  // IntersectionObserver once the new reply is actually visible on screen.
  const markConversationRead = useCallback((runId: string) => {
    setNewDoneIds((current) => {
      if (!current.has(runId)) return current
      const next = new Set(current)
      next.delete(runId)
      return next
    })
  }, [])

  function selectConversation(runId: string) {
    setActiveRunId(runId)
    // Re-launching a closed card gives it the first free pane; a card that's
    // already on screen keeps its slot and is only focused.
    if (closedRunIds.has(runId)) placeNewBlock(runId)
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
    // The unread dot is not cleared on select; it clears only once the new
    // reply scrolls into view (see the card's IntersectionObserver).
    window.requestAnimationFrame(() => {
      scrollToFocusTarget(document.getElementById(`conversation-${runId}`))
    })
  }

  useEffect(() => {
    let cancelled = false
    void loadPasswordStatus().then((status) => {
      if (!cancelled) setPasswordStatus(status)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void listDir('').then((listing) => {
      if (!cancelled && listing?.path) setWorkspaceRoot(listing.path)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (workspaceRoot === DEFAULT_WORKSPACE_CWD || !hasLegacyDefaultWorkspace) return
    setRuns((current) => {
      let changed = false
      const next = current.map((run) => {
        if (run.workspacePath !== DEFAULT_WORKSPACE_CWD) return run
        changed = true
        return { ...run, workspacePath: workspaceRoot }
      })
      return changed ? next : current
    })
  }, [workspaceRoot, hasLegacyDefaultWorkspace])

  // Hydrate persisted interaction data from the local SQLite backend on mount.
  useEffect(() => {
    if (!passwordStatus?.authenticated || hydratedRef.current) return
    let cancelled = false
    void loadPersistedState().then((state) => {
      if (cancelled) return
      if (state) {
        const layout = state.layout
        // Merge defensively: never clobber content the user already created this session.
        if (state.runs.length) {
          // Legacy Hermes cards are migrated to the default Codex CLI card.
          const restored = (state.runs as RunNode[]).map((run) => {
            const cardKind = isAppBuilderRunId(run.id) ? 'app-builder' : run.cardKind ?? 'conversation'
            const storedAgent = (run.agentType as string | undefined) === 'hermes' ? 'codex' : run.agentType ?? 'codex'
            return {
              ...run,
              agentType: storedAgent,
              column: Number.isFinite(run.column) ? run.column : 0,
              agentCommand: typeof run.agentCommand === 'string' ? run.agentCommand : '',
              cardKind,
            }
          })
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
          const restoredUnreadRunIds = layoutRunIdSet(layout?.unreadRunIds, restoredRunIds)
          if (restoredUnreadRunIds) {
            setNewDoneIds((current) => (current.size ? current : restoredUnreadRunIds))
          }
        }
        // Restore the workspace layout: which tool/app panels were open, their
        // order, and the column count.
        if (layout) {
          if (Array.isArray(layout.panelOrder)) {
            const migratedOrder = [...new Set(
              (layout.panelOrder as string[])
                .filter((panelId) => !RETIRED_PLUGIN_PANEL_IDS.has(panelId))
                .map(migrateAppPanelId)
                .filter((panelId): panelId is string => Boolean(panelId)),
            )]
            setPanelOrder((current) => (current.length ? current : migratedOrder))
          }
          if (layout.panelColumns && typeof layout.panelColumns === 'object') {
            const migratedColumns = Object.fromEntries(
              Object.entries(layout.panelColumns as Record<string, number>)
                .filter(([key]) => !RETIRED_PLUGIN_PANEL_IDS.has(key))
                .flatMap(([key, column]) => {
                  const migratedKey = migrateAppPanelId(key)
                  return migratedKey ? [[migratedKey, column]] : []
                }),
            )
            setPanelColumns((current) => (Object.keys(current).length ? current : migratedColumns))
          }
          if (Array.isArray(layout.layoutOrder)) {
            const migratedLayout = [...new Set(
              (layout.layoutOrder as string[])
                .filter((panelId) => !RETIRED_PLUGIN_PANEL_IDS.has(panelId))
                .map(migrateAppPanelId)
                .filter((panelId): panelId is string => Boolean(panelId)),
            )]
            setLayoutOrder((current) => (current.length ? current : migratedLayout))
          }
          const validPresets: LayoutPreset[] = ['single', 'two-up', 'quad', 'three-col', 'master-stack', 'free']
          if (typeof layout.layoutPreset === 'string' && validPresets.includes(layout.layoutPreset)) {
            setLayoutPreset(layout.layoutPreset)
          } else if (layout.workspaceColumns === 2) {
            setLayoutPreset('two-up')
          } else if (layout.workspaceColumns === 1) {
            setLayoutPreset('single')
          }
          if (typeof layout.freeRows === 'number' && layout.freeRows > 0) setFreeRows(layout.freeRows)
          if (typeof layout.freeCols === 'number' && layout.freeCols > 0) setFreeCols(layout.freeCols)
          if (typeof layout.sidebarCollapsed === 'boolean') {
            setSidebarCollapsed(layout.sidebarCollapsed)
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
  }, [passwordStatus?.authenticated])

  // Debounced auto-save of cards and layout to the local SQLite backend.
  useEffect(() => {
    if (!hydratedRef.current || !passwordStatus?.authenticated) return
    const handle = setTimeout(() => {
      void persistState(runs, [], null, {
        panelOrder,
        panelColumns,
        layoutOrder,
        layoutPreset,
        freeRows,
        freeCols,
        sidebarCollapsed,
        closedRunIds: [...closedRunIds],
        collapsedRunIds: [...collapsedIds],
        cardMetaCollapsedIds: [...metaCollapsedIds],
        unreadRunIds: [...newDoneIds],
        panelStates,
      })
    }, 700)
    return () => clearTimeout(handle)
  }, [runs, panelOrder, panelColumns, layoutOrder, layoutPreset, freeRows, freeCols, sidebarCollapsed, closedRunIds, collapsedIds, metaCollapsedIds, newDoneIds, panelStates, passwordStatus?.authenticated])

  const renderRunCard = (run: RunNode) => (
    <ConversationCard
      key={run.id}
      run={run}
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
      onTitleChange={(value) => updateRunContext(run.id, { task: value })}
      onCategoryChange={(value) => updateRunContext(run.id, { category: value, categoryTags: tagsForCategory(value) })}
      onProjectChange={(value) => updateRunProject(run.id, value)}
      onAgentChange={(value) => updateRunContext(run.id, { agentType: value })}
      onAgentCommandChange={(value) => updateRunContext(run.id, { agentCommand: value })}
      onOpenPicker={() => setPickerRunId(run.id)}
      onClose={() => closeConversation(run.id)}
      agentTerminalState={panelStates[agentTerminalStateKey(run.id)]}
      onAgentTerminalStateChange={(patch) => updatePanelState(agentTerminalStateKey(run.id), patch)}
      maximized={maximizedKey === run.id}
      onToggleMaximize={isTuiAgent(run.agentType)
        ? () => {
            const wasCollapsed = collapsedIds.has(run.id)
            expandConversation(run.id)
            const key = agentTerminalStateKey(run.id)
            const current = panelStates[key]?.fullWindow ?? false
            // A click from a collapsed card always means "enter full window".
            // Do not toggle a stale persisted fullWindow flag back off.
            updatePanelState(key, { fullWindow: wasCollapsed ? true : !current })
          }
        : () => {
            const wasCollapsed = collapsedIds.has(run.id)
            expandConversation(run.id)
            setMaximizedKey((current) => (wasCollapsed ? run.id : current === run.id ? null : run.id))
          }
      }
    />
  )

  // Resolve a panel id to its content + draggable wrapper (null if the
  // referenced plugin/app no longer exists).
  const renderPanelBlock = (panelId: string) => {
    const panelMaximized = maximizedKey === panelId
    const togglePanelMaximize = () => setMaximizedKey((current) => (current === panelId ? null : panelId))
    let content: ReactNode = null
    if (panelId === 'terminal') {
      content = (
        <WebTerminal
          initialCwd={workspaceRoot}
          sessionKey="local-terminal"
          onClose={() => closePanel('terminal')}
          collapsed={panelStates[panelId]?.collapsed}
          fullWindow={panelStates[panelId]?.fullWindow}
          onStateChange={(patch) => updatePanelState(panelId, patch)}
          notepad={panelStates[panelId]?.notepad}
          onNotepadChange={(text) => updatePanelState(panelId, { notepad: text })}
        />
      )
    } else if (panelId.startsWith('plugin:')) {
      const plugin = plugins.find((p) => p.id === panelId.slice('plugin:'.length))
      if (plugin) {
        content = plugin.renderPanel({
          onClose: () => closePanel(panelId),
          panelState: panelStates[panelId],
          onPanelStateChange: (patch) => updatePanelState(panelId, patch),
          maximized: panelMaximized,
          onToggleMaximize: togglePanelMaximize,
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
            maximized={panelMaximized}
            onToggleMaximize={togglePanelMaximize}
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

  // Grid template for the tile presets (quad / three-col / master-stack /
  // free). These are true CSS grids: the column count is fixed by the preset,
  // but rows auto-grow as more blocks open — closest to the old stack
  // behavior while giving each preset its distinctive shape.
  function tileGridStyle(): CSSProperties {
    // alignItems:stretch is set inline because `.ws-columns { align-items: start }`
    // otherwise wins the cascade over `.tile-grid { align-items: stretch }` (same
    // specificity, later in the file), leaving tile slots at content height so
    // cards can't fill their (full-height) grid row.
    const base: CSSProperties = { display: 'grid', gap: '10px', alignItems: 'stretch' }
    // quad: the 4 canonical slots live in two explicit rows that split the
    // viewport 50/50 (no scroll); any blocks beyond 4 spill into auto rows
    // (fixed min → the page scrolls, preserving the auto-grow overflow model).
    if (layoutPreset === 'quad') return { ...base, gridTemplateColumns: '1fr 1fr', gridTemplateRows: 'repeat(2, minmax(0, 1fr))', gridAutoRows: 'minmax(280px, 1fr)' }
    if (layoutPreset === 'three-col') return { ...base, gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: 'minmax(0, 1fr)', gridAutoRows: 'minmax(240px, 1fr)' }
    // master+stack: three explicit rows so the three stack panes each take a
    // third of the viewport height (master spans all three); extra stack panes
    // spill into auto rows and scroll.
    if (layoutPreset === 'master-stack') return { ...base, gridTemplateColumns: '1.9fr 1fr', gridTemplateRows: 'repeat(3, minmax(0, 1fr))', gridAutoRows: 'minmax(160px, 1fr)' }
    return { ...base, gridTemplateColumns: `repeat(${freeCols}, 1fr)`, gridAutoRows: 'minmax(200px, 1fr)' }
  }

  // Master+stack gives the first block the whole left column (spanning every
  // row); the rest queue up in the right column, one per row.
  function tileSlotStyle(index: number): CSSProperties {
    if (layoutPreset !== 'master-stack') return {}
    return index === 0 ? { gridColumn: '1', gridRow: '1 / -1' } : { gridColumn: '2' }
  }

  // Tiling grid: every open block gets its own equally-sized slot, filled
  // row-major in layoutOrder. Unlike the stack presets, position is purely
  // order-driven — there's no per-block column assignment to maintain.
  const renderTileGrid = () => {
    const dragActive = draggingKey !== null
    // Fill unused preset slots with dashed "open window" placeholders, like
    // the reference design; extra blocks beyond capacity still auto-grow rows.
    const capacity =
      layoutPreset === 'quad'
        ? 4
        : layoutPreset === 'three-col'
          ? 3
          : layoutPreset === 'master-stack'
            ? 4
            : freeRows * freeCols
    const placeholderCount = Math.max(0, capacity - orderedKeys.length)
    return (
      <div
        className={`ws-columns tile-grid tile-grid-${layoutPreset}`}
        style={tileGridStyle()}
        onDragOver={(event) => {
          if (dragActive) event.preventDefault()
        }}
        onDrop={(event) => {
          if (!dragActive) return
          event.preventDefault()
          handleDropToEnd()
        }}
      >
        {orderedKeys.map((key, index) => (
          <div key={key} className="tile-slot" style={{ display: 'flex', minWidth: 0, minHeight: 0, ...tileSlotStyle(index) }}>
            {renderBlock(key)}
          </div>
        ))}
        {Array.from({ length: placeholderCount }, (_, index) => (
          <div
            key={`tile-empty-${index}`}
            className="tile-slot"
            style={{ display: 'flex', minWidth: 0, minHeight: 0, ...tileSlotStyle(orderedKeys.length + index) }}
          >
            <button type="button" className="tile-empty" onClick={() => setOpenWindowPickerOpen(true)} title="Open a conversation window in this slot">
              <span className="tile-empty-plus" aria-hidden>+</span>
              <span>open window</span>
            </button>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className={`app-shell ${hasContent ? 'has-content' : 'blank'}`}>
      {settingsOpen ? <div className="settings-popover-backdrop" onClick={() => setSettingsOpen(false)} /> : null}

      <div className="settings-gear-anchor">
        <button
          type="button"
          className={`settings-gear-btn ${settingsOpen ? 'open' : ''}`}
          title="Settings"
          aria-label="Settings"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((current) => !current)}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.7" />
            <path
              d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className={`settings-popover ${settingsOpen ? 'open' : ''}`}>
          <div className="settings-popover-title">SETTINGS</div>
          <button
            type="button"
            className="settings-popover-row"
            onClick={() => {
              setSettingsOpen(false)
              setPasswordDialogOpen(true)
            }}
            disabled={!passwordStatus}
          >
            <span>Password</span>
            <span aria-hidden>›</span>
          </button>
        </div>
      </div>

      {passwordDialogOpen && passwordStatus ? (
        <PasswordDialog
          status={passwordStatus}
          onClose={() => setPasswordDialogOpen(false)}
          onStatusChange={setPasswordStatus}
        />
      ) : null}

      {passwordStatus && !passwordStatus.authenticated ? <PasswordUnlock onUnlocked={setPasswordStatus} /> : null}

      {openWindowPickerOpen ? (
        <div
          className="confirm-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Open a conversation window"
          onClick={() => setOpenWindowPickerOpen(false)}
        >
          <div className="picker open-window-picker" onClick={(event) => event.stopPropagation()}>
            <div className="picker-head">
              <div>
                <div className="eyebrow">Navigator</div>
                <h3>Open a conversation window</h3>
              </div>
              <button
                type="button"
                className="picker-close"
                aria-label="Close"
                onClick={() => setOpenWindowPickerOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="open-window-picker-body">
              {conversationTree.length ? (
                <div className="tree-nav">
                  {conversationTree.map((category) => (
                    <section key={category.category} className="tree-nav-category">
                      <h3 className="open-window-picker-category">{category.category}</h3>
                      {category.projects.map((project) => (
                        <div key={`${category.category}-${project.project}`} className="tree-nav-project">
                          <div className="tree-nav-label open-window-picker-project">{project.project}</div>
                          <div className="tree-nav-runs">
                            {project.runs.map((run) => {
                              const isOpen = !closedRunIds.has(run.id)
                              return (
                                <button
                                  key={run.id}
                                  type="button"
                                  className={`tree-nav-run open-window-picker-run ${isOpen ? 'is-open' : ''}`}
                                  onClick={() => {
                                    selectConversation(run.id)
                                    setOpenWindowPickerOpen(false)
                                  }}
                                >
                                  <span className="tree-run-main">
                                    <span className="tree-run-title">{conversationTitle(run)}</span>
                                  </span>
                                  {isOpen ? (
                                    <span className="open-window-picker-badge">open</span>
                                  ) : (
                                    <span className={`tree-run-status ${run.jobStatus}`} aria-hidden />
                                  )}
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </section>
                  ))}
                </div>
              ) : (
                <p className="open-window-picker-empty">No conversations yet — start a new one below.</p>
              )}
            </div>

            <div className="picker-actions">
              <button
                type="button"
                className="send-button"
                onClick={() => {
                  setOpenWindowPickerOpen(false)
                  startNewConversation()
                }}
              >
                + New conversation
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <main className="main-stage">
        <div className={`main-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          <aside
            className={`left-rail ${sidebarCollapsed ? 'collapsed' : 'pinned'} ${sidebarPeek ? 'peek' : ''}`}
            aria-label="Sidebar"
            /* Peek is opened per-icon (each icon knows which menu it shows), so
               there's no rail-wide mouseenter — only the leave that closes it. */
            onMouseLeave={() => setSidebarPeek(false)}
          >
            {/* Always-visible 52px icon strip — the pin toggle lives here so it
                stays reachable even while collapsed and only peeking. Each menu
                icon both selects which menu the panel shows and reveals it. */}
            <div className="rail-icon-strip">
              <button
                type="button"
                className="rail-toggle-button"
                aria-expanded={!sidebarCollapsed}
                aria-label={sidebarCollapsed ? 'Pin sidebar open' : 'Collapse sidebar'}
                title={sidebarCollapsed ? 'Pin sidebar open' : 'Collapse sidebar'}
                onMouseEnter={() => showRailPanel('navigator')}
                onClick={() => {
                  setSidebarCollapsed((current) => !current)
                  setSidebarPeek(false)
                }}
              >
                <svg width="17" height="17" viewBox="0 0 17 17" fill="none">
                  <rect x="1.5" y="2.5" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
                  <line x1="6" y1="2.5" x2="6" y2="14.5" stroke="currentColor" strokeWidth="1.4" />
                </svg>
              </button>
              <div className="rail-icon-divider" aria-hidden />

              <button
                type="button"
                className={`rail-icon-button ${railPanel === 'navigator' ? 'active' : ''}`}
                aria-label="Navigator"
                title="Navigator"
                onMouseEnter={() => showRailPanel('navigator')}
                onClick={() => openRailPanel('navigator')}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 3h4M3 6.5h7M3 10h5M3 13.5h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>

              <button
                type="button"
                className={`rail-icon-button ${railPanel === 'resources' ? 'active' : ''}`}
                aria-label="Resources"
                title="Resources"
                onMouseEnter={() => showRailPanel('resources')}
                onClick={() => openRailPanel('resources')}
              >
                {/* Toolbox */}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M1.5 6.5h13v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-6Z"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinejoin="round"
                  />
                  <path d="M5.5 6.5V4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                  <path d="M1.5 9.5h4m5 0h4M6.5 8.5h3v2h-3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                </svg>
              </button>

              <div className="rail-icon-divider" aria-hidden />

              <button
                type="button"
                className={`rail-icon-button ${terminalOpen ? 'active' : ''}`}
                aria-label={terminalOpen ? 'Local Terminal is open' : 'Launch Local Terminal'}
                title={terminalOpen ? 'Local Terminal is open' : 'Launch Local Terminal'}
                onClick={() => openPanel('terminal')}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M4.3 6l2 2-2 2M8.4 10.2h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            {/* One menu at a time: whichever icon is selected gets the panel's
                full height. Reflows the workspace while pinned, floats over it
                (no reflow) while only peeking on hover. */}
            <div className="rail-content-panel">
              {railPanel === 'navigator' ? (
                <ConversationTreeSidebar
                  tree={conversationTree}
                  activeRunId={activeRunId}
                  unreadRunIds={newDoneIds}
                  onSelect={selectConversation}
                  onDeleteRequest={requestDeleteConversation}
                />
              ) : (
                <ResourceSidebar
                  openPluginIds={openPluginIds}
                  onLaunchPlugin={launchPlugin}
                  apps={appListing.apps}
                  appWarnings={appListing.warnings}
                  openAppSlugs={openAppSlugs}
                  onLaunchApp={launchApp}
                  onReorderApps={reorderApps}
                  onRenameApp={renameAppLabel}
                />
              )}
            </div>
          </aside>

          <section className="conversation-workspace" aria-label="Conversation cards">
            <div className="stack-toolbar">
              <button type="button" className="send-button new-conversation-btn" onClick={startNewConversation}>
                + New conversation
              </button>

              <div className="toolbar-divider" aria-hidden />
              <div className="preset-picker">
                {LAYOUT_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={`preset-button ${layoutPreset === preset.id ? 'active' : ''}`}
                    title={preset.title}
                    aria-label={preset.title}
                    aria-pressed={layoutPreset === preset.id}
                    onClick={() => setLayoutPreset(preset.id)}
                  >
                    {preset.icon}
                  </button>
                ))}
              </div>

              {layoutPreset === 'free' ? (
                <div className="free-grid-controls">
                  <span className="free-grid-label">ROWS</span>
                  <button type="button" className="free-grid-step" onClick={() => setFreeRows((r) => Math.max(1, r - 1))}>–</button>
                  <span className="free-grid-value">{freeRows}</span>
                  <button type="button" className="free-grid-step" onClick={() => setFreeRows((r) => Math.min(6, r + 1))}>+</button>
                  <span className="free-grid-label">COLS</span>
                  <button type="button" className="free-grid-step" onClick={() => setFreeCols((c) => Math.max(1, c - 1))}>–</button>
                  <span className="free-grid-value">{freeCols}</span>
                  <button type="button" className="free-grid-step" onClick={() => setFreeCols((c) => Math.min(6, c + 1))}>+</button>
                </div>
              ) : null}

              {usageAgentRuns.length ? (
                <>
                  <div className="toolbar-divider" aria-hidden />
                  <span className="toolbar-label">USAGE</span>
                  {usageAgentRuns.map((run) => (
                    <AgentUsageToolbarButton key={run.agentType} agent={run.agentType} cwd={run.workspacePath} session={run.id} />
                  ))}
                </>
              ) : null}
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

            <div className={`workspace-panels ${maximizedKey ? 'maximized' : `columns-${layoutPreset === 'two-up' ? 2 : 1}`}`}>
              {maximizedKey ? (
                <div className="maximized-block">
                  <button
                    type="button"
                    className="maximize-restore-btn"
                    onClick={() => setMaximizedKey(null)}
                    title="Restore grid layout"
                  >
                    ⤡ Restore grid
                  </button>
                  {renderBlock(maximizedKey)}
                </div>
              ) : panelOrder.length === 0 && visibleRuns.length === 0 ? (
                <div className="conv-empty">
                  {hasContent ? 'All cards closed — reopen one from the Navigator.' : 'Click “New conversation” to begin.'}
                </div>
              ) : layoutPreset === 'two-up' ? (
                // Unified two-column canvas: panels and cards each carry a
                // column, so a tool/app can sit left-right beside a card.
                <div className="ws-columns">{[0, 1].map((col) => renderWorkspaceColumn(col))}</div>
              ) : layoutPreset === 'single' ? (
                renderWorkspaceColumn(null)
              ) : (
                renderTileGrid()
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
              Delete this conversation? This cannot be undone.
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
          initialPath={runs.find((run) => run.id === pickerRunId)?.workspacePath ?? workspaceRoot}
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
