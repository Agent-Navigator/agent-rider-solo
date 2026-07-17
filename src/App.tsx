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
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import '@xterm/xterm/css/xterm.css'
import { HermesActiveStreamError, HermesBridge, type HermesConnectionState, type PromptContext, type PromptImage } from './hermesBridge'
import {
  loadPersistedState,
  persistState,
  listDir,
  readFilePreview,
  searchFiles,
  makeDir,
  moveDir,
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

// Which agent backend drives a conversation card. 'hermes' streams turns over
// /api (the default); the others run an interactive TUI CLI in an embedded
// terminal (see WebTerminal + the /store/terminal/ws `agent` param).
type AgentType = 'hermes' | 'claude' | 'codex' | 'agy' | 'devin' | 'custom'
type TuiAgentType = Exclude<AgentType, 'hermes'>
type AppBuilderMode = 'chat' | 'app' | 'split'

// Chat pane share of the Chat+App split, clamped so neither pane collapses.
const APP_BUILDER_SPLIT_DEFAULT = 0.3
const APP_BUILDER_SPLIT_MIN = 0.15
const APP_BUILDER_SPLIT_MAX = 0.85

function clampBuilderSplit(value: number) {
  return Math.min(APP_BUILDER_SPLIT_MAX, Math.max(APP_BUILDER_SPLIT_MIN, value))
}
type RunCardKind = 'conversation' | 'app-builder'

interface HermesModel {
  id: string
  label: string
}

interface HermesModelGroup {
  provider: string
  providerId: string | null
  models: HermesModel[]
}

interface HermesModelCatalog {
  groups: HermesModelGroup[]
  defaultModel: string
  activeProvider: string | null
}

const AGENT_OPTIONS: { value: AgentType; label: string }[] = [
  { value: 'hermes', label: 'Hermes Agent' },
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
  hermes: 'Hermes',
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
let agentAvailabilityPromise: Promise<Record<string, boolean>> | null = null
function useAgentAvailability(): Record<string, boolean> | null {
  const [availability, setAvailability] = useState(agentAvailabilityCache)
  useEffect(() => {
    if (agentAvailabilityCache) return
    agentAvailabilityPromise ??= fetch('/store/agents')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => ((data as { agents?: Record<string, boolean> } | null)?.agents ?? null))
      .catch(() => null)
    let cancelled = false
    void agentAvailabilityPromise.then((agents) => {
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

function renderAgentOptions(availability: Record<string, boolean> | null) {
  return AGENT_OPTIONS.map((option) => {
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

function modelSelectValue(model: string, provider: string | null = null) {
  return JSON.stringify([provider ?? '', model])
}

function parseModelSelectValue(value: string) {
  if (!value) return { model: '', modelProvider: null }
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return { model: '', modelProvider: null }
    const [provider, model] = parsed
    return {
      model: String(model ?? '').trim(),
      modelProvider: String(provider ?? '').trim() || null,
    }
  } catch {
    return { model: '', modelProvider: null }
  }
}

/** `refresh` makes the server re-ask hermes instead of serving its cached
 *  catalog — the way to pick up a provider switch made in the hermes CLI. */
async function fetchHermesModelCatalog(refresh = false, workspace = ''): Promise<HermesModelCatalog> {
  const query = refresh ? `?refresh=1${workspace ? `&workspace=${encodeURIComponent(workspace)}` : ''}` : ''
  const res = await fetch(`/api/models${query}`)
  if (!res.ok) throw new Error(`models failed (${res.status})`)
  const data = (await res.json()) as Record<string, unknown>
  const rawGroups = Array.isArray(data.groups) ? data.groups : []
  const groups = rawGroups.map((group) => {
    const item = group as Record<string, unknown>
    const provider = String(item.provider ?? 'Provider').trim() || 'Provider'
    const providerId = String(item.provider_id ?? '').trim() || null
    const rawModels = Array.isArray(item.models) ? item.models : []
    return {
      provider,
      providerId,
      models: rawModels.map((model) => {
        const modelItem = model as Record<string, unknown>
        const id = String(modelItem.id ?? '').trim()
        return { id, label: String(modelItem.label ?? id).trim() || id }
      }).filter((model) => model.id),
    }
  }).filter((group) => group.models.length)

  return {
    groups,
    defaultModel: String(data.default_model ?? '').trim(),
    activeProvider: String(data.active_provider ?? '').trim() || null,
  }
}

async function fetchHermesReasoningEfforts() {
  const res = await fetch('/api/reasoning')
  if (!res.ok) throw new Error(`reasoning failed (${res.status})`)
  const data = (await res.json()) as Record<string, unknown>
  const supported = Array.isArray(data.supported_efforts) ? data.supported_efforts : []
  const efforts = supported.map((effort) => String(effort).trim()).filter(Boolean)
  return {
    efforts: efforts.length ? efforts : DEFAULT_REASONING_EFFORTS,
    defaultEffort: String(data.reasoning_effort ?? '').trim(),
  }
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
  model?: string
  modelProvider?: string | null
  reasoningEffort?: string
  sessionId?: string | null
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

/** One tool Hermes ran during a turn, as reported over ACP. A call starts with
 *  no status and is only sometimes given a terminal `tool_call_update`, so a
 *  'pending' entry is reconciled when the turn finishes. */
interface ToolActivity {
  id: string
  title: string
  kind: string
  status: 'pending' | 'completed' | 'failed'
  locations?: string[]
  output?: string
  // Image files the tool produced (screenshots, generated images), as paths the
  // store can serve. Hermes reports these as text, never as image blocks.
  images?: string[]
}

// Anthropic's vision guidance: a long edge past ~1568px buys no accuracy and
// only costs tokens. Downscaling here also keeps the prompt body — and the
// saved conversation state — from ballooning with raw camera-sized captures.
const MAX_IMAGE_EDGE = 1568
const MAX_PROMPT_IMAGES = 8

function workspaceFileUrl(path: string) {
  return `/store/fs/view/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** Read an image file into a downscaled data URL. PNGs stay PNG so screenshots
 *  keep their crisp text; anything else re-encodes as JPEG. */
async function toPromptImage(file: File): Promise<PromptImage | null> {
  if (!file.type.startsWith('image/')) return null
  const dataUrl = await new Promise<string>((done, fail) => {
    const reader = new FileReader()
    reader.onload = () => done(String(reader.result ?? ''))
    reader.onerror = () => fail(reader.error ?? new Error('could not read file'))
    reader.readAsDataURL(file)
  })

  const image = await new Promise<HTMLImageElement | null>((done) => {
    const element = new Image()
    element.onload = () => done(element)
    element.onerror = () => done(null)
    element.src = dataUrl
  })

  const base = { id: makeId('img'), name: file.name || 'pasted image' }
  // SVG has no intrinsic raster size to scale, and an unreadable image is still
  // worth sending as-is rather than dropping silently.
  const scale = image ? Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height)) : 1
  if (!image || file.type === 'image/svg+xml' || scale === 1) {
    return { ...base, mimeType: file.type, dataUrl }
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(image.width * scale)
  canvas.height = Math.round(image.height * scale)
  const context = canvas.getContext('2d')
  if (!context) return { ...base, mimeType: file.type, dataUrl }
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  return { ...base, mimeType, dataUrl: canvas.toDataURL(mimeType, 0.85) }
}

/** Images carried by a paste or drop, if any. */
function imageFilesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  return Array.from(transfer.files ?? []).filter((file) => file.type.startsWith('image/'))
}

interface PlanEntry {
  content: string
  status: string
}

/** ACP tool status → our three states, never regressing a settled call back to
 *  pending (a late update carrying no status must not un-complete it). */
function normalizeToolStatus(raw: unknown, previous?: ToolActivity['status']): ToolActivity['status'] {
  const value = String(raw ?? '')
  if (value === 'completed') return 'completed'
  if (value === 'failed' || value === 'error') return 'failed'
  return previous && previous !== 'pending' ? previous : 'pending'
}

/** Hermes does not always send a terminal tool_call_update for every tool_call,
 *  so a call left 'pending' when the turn ends would spin forever. Settle it:
 *  the turn is over, so nothing is still running. */
function settleTools(turn: TurnItem, fallback: ToolActivity['status']): ToolActivity[] | undefined {
  if (!turn.tools?.length) return turn.tools
  return turn.tools.map((tool) => (tool.status === 'pending' ? { ...tool, status: fallback } : tool))
}

interface TurnItem {
  id: string
  prompt: string
  response: string
  status: JobStatus
  runId: string
  parentTurnId?: string | null
  createdAt: string
  // Activity timeline (Hermes only): reasoning, tool calls and plan updates that
  // led to `response`. Absent on turns from agents that stream plain text.
  thinking?: string
  tools?: ToolActivity[]
  plan?: PlanEntry[]
  // Images the user attached to `prompt`, shown back in their own bubble.
  images?: PromptImage[]
}

interface QueuedPromptEntry {
  turnId: string
  runId: string
  prompt: string
  workspace: string
  model?: string
  modelProvider?: string | null
  reasoningEffort?: string
  promptContext?: PromptContext
  images?: PromptImage[]
}

interface AppFolderConflict {
  sourcePath: string
  targetPath: string
  error: string
  acknowledged?: boolean
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
const DEFAULT_APP_BUILDER_ROOT = '/root/.agent-rider/apps'
const DEFAULT_TITLE = 'Agent Rider'
const AGENT_TERMINAL_STATE_PREFIX = 'agent-terminal:'
const TUI_WHEEL_PAGE_DELTA = 80
const TUI_PAGE_UP = '\x1b[5~'
const TUI_PAGE_DOWN = '\x1b[6~'
const DEFAULT_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh']
const EMPTY_MODEL_CATALOG: HermesModelCatalog = { groups: [], defaultModel: '', activeProvider: null }
const APP_BUILDER_PANEL_ID = 'app-builder'
const APP_BUILDER_RUN_ID = 'run-app-builder'
// Per-app App Builder instances: every built app opens through its own builder
// panel/run pair so each app keeps its own conversation and chat/app-view mode.
const APP_BUILDER_PANEL_PREFIX = 'app-builder:'
const APP_BUILDER_RUN_PREFIX = 'run-app-builder:'
const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

function appBuilderPanelIdFor(appSlug: string) {
  return `${APP_BUILDER_PANEL_PREFIX}${appSlug}`
}

function appBuilderRunIdFor(appSlug: string) {
  return `${APP_BUILDER_RUN_PREFIX}${appSlug}`
}

function isAppBuilderPanelId(panelId: string) {
  return panelId === APP_BUILDER_PANEL_ID || panelId.startsWith(APP_BUILDER_PANEL_PREFIX)
}

// cardKind is not a persisted run column, so builder runs are recognized by id.
function isAppBuilderRunId(runId: string) {
  return runId === APP_BUILDER_RUN_ID || runId.startsWith(APP_BUILDER_RUN_PREFIX)
}

function appSlugForBuilderPanel(panelId: string) {
  return panelId.startsWith(APP_BUILDER_PANEL_PREFIX) ? panelId.slice(APP_BUILDER_PANEL_PREFIX.length) : null
}

function appBuilderPanelIdForRun(runId: string) {
  return runId.startsWith(APP_BUILDER_RUN_PREFIX) ? appBuilderPanelIdFor(runId.slice(APP_BUILDER_RUN_PREFIX.length)) : APP_BUILDER_PANEL_ID
}

function appBuilderRunIdForPanel(panelId: string) {
  const slug = appSlugForBuilderPanel(panelId)
  return slug ? appBuilderRunIdFor(slug) : APP_BUILDER_RUN_ID
}

// Legacy `app:<slug>` WebView panels are superseded by per-app builder panels.
function migrateLegacyAppPanelId(panelId: string) {
  return panelId.startsWith('app:') ? appBuilderPanelIdFor(panelId.slice('app:'.length)) : panelId
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
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const source = raw as Record<string, unknown>
    const state: WorkspacePanelState = {}
    if (typeof source.collapsed === 'boolean') state.collapsed = source.collapsed
    if (typeof source.fullWindow === 'boolean') state.fullWindow = source.fullWindow
    if (source.builderMode === 'chat' || source.builderMode === 'app' || source.builderMode === 'split') state.builderMode = source.builderMode
    if (typeof source.contextCollapsed === 'boolean') state.contextCollapsed = source.contextCollapsed
    if (typeof source.builderSplit === 'number' && Number.isFinite(source.builderSplit)) state.builderSplit = clampBuilderSplit(source.builderSplit)
    if (typeof source.notepad === 'string') state.notepad = source.notepad
    const migratedKey = migrateLegacyAppPanelId(key)
    // A legacy app panel was showing the app itself, so its builder starts on App View.
    if (migratedKey !== key && !state.builderMode) state.builderMode = 'app'
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
    job: 'Hermes run',
  }
}

function conversationTitle(run: RunNode) {
  return run.task.trim() || run.project.trim() || compactText(run.prompt, 48) || 'Untitled conversation'
}

// Chronological order: oldest at the top, newest at the bottom (like a chat
// log), so it reads top-to-bottom with the prompt bar pinned below it. Within a
// thread the parent comes before its follow-ups.
function buildLinearTurns(turns: TurnItem[]) {
  const byId = new Map(turns.map((turn) => [turn.id, turn]))
  const childrenByParent = new Map<string, TurnItem[]>()
  const roots: TurnItem[] = []
  const oldestFirst = (a: TurnItem, b: TurnItem) => a.createdAt.localeCompare(b.createdAt)

  for (const turn of turns) {
    const parentId = turn.parentTurnId ?? null
    if (parentId && byId.has(parentId)) {
      const children = childrenByParent.get(parentId) ?? []
      children.push(turn)
      childrenByParent.set(parentId, children)
    } else {
      roots.push(turn)
    }
  }

  for (const children of childrenByParent.values()) children.sort(oldestFirst)
  roots.sort(oldestFirst)

  const ordered: TurnItem[] = []
  const visited = new Set<string>()

  function appendWithFollowUps(turn: TurnItem) {
    if (visited.has(turn.id)) return
    visited.add(turn.id)
    ordered.push(turn)
    for (const child of childrenByParent.get(turn.id) ?? []) appendWithFollowUps(child)
  }

  for (const root of roots) appendWithFollowUps(root)
  for (const turn of [...turns].sort(oldestFirst)) appendWithFollowUps(turn)

  return ordered
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function StatusPill({ state, detail }: { state: HermesConnectionState | JobStatus; detail: string }) {
  const tone =
    state === 'ready' || state === 'done' || state === 'cancelled'
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

function headerStatusText(state: HermesConnectionState, detail: string) {
  if (state === 'ready') return 'Hermes ready'
  if (state === 'busy') return 'Hermes running'
  if (state === 'connecting') return 'Hermes connecting'
  if (state === 'error') return detail || 'Hermes error'
  return 'Hermes disconnected'
}

function TreeRow({ label, value, depth }: { label: string; value: string; depth: number }) {
  return (
    <div className={`tree-row depth-${depth}`}>
      <span className="tree-label">{label}</span>
      <strong className="tree-value">{value}</strong>
    </div>
  )
}

// A tiny ASCII spinner so a running/queued turn reads as "alive" even when no
// output is streaming yet. Cycles the classic |/-\ frames on a fixed interval.
const ASCII_SPINNER_FRAMES = ['|', '/', '-', '\\']
function AsciiSpinner() {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setFrame((n) => (n + 1) % ASCII_SPINNER_FRAMES.length), 120)
    return () => window.clearInterval(id)
  }, [])
  return (
    <span className="ascii-spinner" aria-hidden="true">
      {ASCII_SPINNER_FRAMES[frame]}
    </span>
  )
}

function turnRoleLabel(status: JobStatus) {
  return status === 'queued'
    ? 'Queued'
    : status === 'error'
      ? 'Error'
      : status === 'cancelled'
        ? 'Stopped'
        : status === 'done'
          ? 'Done'
          : 'Running'
}

// --- Window chrome (reference design) helpers -------------------------------
// Every workspace block — conversation, TUI agent, tool, app — renders as a
// "window": a 34px titlebar (grip · status dot · mono title · meta · status ·
// actions), a dark body, and (for chat windows) a prompt bar + footer.

interface WindowStatusTone {
  label: string
  dot: string
  color: string
}

function windowStatusTone(status: JobStatus, isDraft: boolean): WindowStatusTone {
  if (isDraft) return { label: 'idle', dot: '#5c6470', color: '#7a828f' }
  switch (status) {
    case 'running':
      return { label: 'running', dot: '#e0a33e', color: '#e6b25a' }
    case 'queued':
      return { label: 'queued', dot: '#e0a33e', color: '#e6b25a' }
    case 'error':
      return { label: 'error', dot: '#ef6d6d', color: '#ff9d9d' }
    case 'cancelled':
      return { label: 'stopped', dot: '#5c6470', color: '#7a828f' }
    default:
      return { label: 'ready', dot: '#46c98b', color: '#5fd39b' }
  }
}

function connectionStatusTone(state: 'connecting' | 'connected' | 'closed' | 'error'): WindowStatusTone {
  switch (state) {
    case 'connected':
      return { label: 'connected', dot: '#46c98b', color: '#5fd39b' }
    case 'connecting':
      return { label: 'connecting', dot: '#e0a33e', color: '#e6b25a' }
    case 'error':
      return { label: 'error', dot: '#ef6d6d', color: '#ff9d9d' }
    default:
      return { label: 'closed', dot: '#5c6470', color: '#7a828f' }
  }
}

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

function pathSegment(value: string, fallback: string) {
  const clean = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return clean || fallback
}

function appBuilderFallbackRoot(workspaceRoot: string) {
  const root = workspaceRoot.replace(/\/+$/, '')
  return root === DEFAULT_WORKSPACE_CWD ? DEFAULT_APP_BUILDER_ROOT : `${root}/.agent-rider/apps`
}

function appBuilderWorkspacePath(appsRoot: string, _category: string, _project: string, title: string, appId?: string | null) {
  const root = appsRoot.replace(/\/+$/, '')
  return [root, pathSegment(appId || title, 'untitled-app')].join('/')
}

function appSlugFromManifestContent(content: string | undefined) {
  if (!content) return null
  try {
    const manifest = JSON.parse(content) as Record<string, unknown>
    const id = String(manifest.id ?? '').trim()
    return APP_SLUG_RE.test(id) ? id : null
  } catch {
    return null
  }
}

async function appSlugFromWorkspaceManifest(workspacePath: string) {
  const base = workspacePath.replace(/\/+$/, '')
  const preview = await readFilePreview(`${base}/manifest.json`)
  if ('error' in preview) return null
  return appSlugFromManifestContent(preview.content)
}

async function ensureWorkspacePath(rootPath: string, targetPath: string) {
  const root = rootPath.replace(/\/+$/, '')
  if (!targetPath.startsWith(`${root}/`)) return
  const parts = targetPath.slice(root.length + 1).split('/').filter(Boolean)
  let parent = root
  for (const part of parts) {
    const result = await makeDir(parent, part)
    parent = 'error' in result ? `${parent}/${part}` : result.path
  }
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
 * Read-only file browser scoped to a conversation's workspace. Collapsed by default
 * and lazy-loaded on first expand. Navigation is bounded to the workspace subtree
 * (you can't browse above `rootPath`), and the backend further sandboxes to BROWSE_ROOT.
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

  // Only allow walking up while staying within the workspace subtree.
  const canGoUp = path !== effectiveRootPath && pathWithinRoot(path, effectiveRootPath)
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

const TOOL_STATUS_MARK: Record<ToolActivity['status'], string> = {
  pending: '·',
  completed: '✓',
  failed: '✗',
}

function planMark(status: string) {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '▸'
  return '○'
}

/** What Hermes did on the way to its answer: plan, tool calls, reasoning. This
 *  is the only window into a Hermes turn — unlike the TUI agents, its work does
 *  not show up in a terminal — and it doubles as the audit trail for tools that
 *  ran without a permission prompt. Everything is collapsed by default so the
 *  answer stays the focus. */
function TurnActivity({ turn }: { turn: TurnItem }) {
  const tools = turn.tools ?? []
  const plan = turn.plan ?? []
  const thinking = (turn.thinking ?? '').trim()
  if (!tools.length && !plan.length && !thinking) return null

  return (
    <div className="term-activity">
      {plan.length ? (
        <ul className="term-plan">
          {plan.map((entry, index) => (
            <li key={index} className={`term-plan-item ${entry.status}`}>
              <span className="term-plan-mark" aria-hidden>{planMark(entry.status)}</span>
              <span>{entry.content}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {tools.map((tool) => (
        <details key={tool.id} className={`term-tool ${tool.status}`}>
          <summary className="term-tool-head">
            <span className="term-tool-mark" aria-hidden>{TOOL_STATUS_MARK[tool.status]}</span>
            <span className="term-tool-kind">{tool.kind}</span>
            <span className="term-tool-title">{tool.title}</span>
          </summary>
          {tool.locations?.length ? (
            <div className="term-tool-locations">{tool.locations.join('\n')}</div>
          ) : null}
          {tool.images?.length ? (
            <div className="term-tool-images">
              {tool.images.map((path) => (
                <a key={path} href={workspaceFileUrl(path)} target="_blank" rel="noreferrer">
                  <img src={workspaceFileUrl(path)} alt={path} loading="lazy" />
                </a>
              ))}
            </div>
          ) : null}
          {tool.output ? <pre className="term-tool-output">{tool.output}</pre> : null}
        </details>
      ))}

      {thinking ? (
        <details className="term-thinking">
          <summary className="term-tool-head">
            <span className="term-tool-mark" aria-hidden>~</span>
            <span className="term-tool-kind">reasoning</span>
          </summary>
          <div className="term-thinking-body">{thinking}</div>
        </details>
      ) : null}
    </div>
  )
}

function ConversationCard({
  run,
  turns,
  collapsed,
  metaCollapsed,
  active,
  embedded = false,
  hideHeader = false,
  hideContext = false,
  isNewDone,
  onMarkRead,
  onToggle,
  onMetaCollapsedChange,
  onSend,
  onTitleChange,
  onCategoryChange,
  onProjectChange,
  onAgentChange,
  onAgentCommandChange,
  modelCatalog,
  modelsRefreshing,
  onRefreshModels,
  reasoningEfforts,
  onModelChange,
  onReasoningEffortChange,
  onOpenPicker,
  onClose,
  onDeleteTurn,
  stoppableTurnId,
  refreshableTurnId,
  onStopTurn,
  onRefreshTurn,
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
  turns: TurnItem[]
  collapsed: boolean
  metaCollapsed: boolean
  active: boolean
  embedded?: boolean
  hideHeader?: boolean
  hideContext?: boolean
  isNewDone: boolean
  onMarkRead: (runId: string) => void
  onToggle: () => void
  onMetaCollapsedChange: (collapsed: boolean) => void
  onSend: (text: string, parentTurnId?: string | null, images?: PromptImage[]) => string | null
  onTitleChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onProjectChange: (value: string) => void
  onAgentChange: (value: AgentType) => void
  onAgentCommandChange: (value: string) => void
  modelCatalog: HermesModelCatalog
  modelsRefreshing: boolean
  onRefreshModels: () => void
  reasoningEfforts: string[]
  onModelChange: (model: string, modelProvider: string | null) => void
  onReasoningEffortChange: (effort: string) => void
  onOpenPicker: () => void
  onClose: () => void
  onDeleteTurn: (turnId: string) => void
  stoppableTurnId: string | null
  refreshableTurnId: string | null
  onStopTurn: (turnId: string) => void
  onRefreshTurn: (turnId: string) => void
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
  /** Whether this card is the single block currently filling the workspace. */
  maximized?: boolean
  onToggleMaximize?: () => void
}) {
  const agentType: AgentType = run.agentType ?? 'hermes'
  const agentAvailability = useAgentAvailability()
  const tui = isTuiAgent(agentType)
  const customAgentCommand = (run.agentCommand ?? '').trim()
  const selectedModelValue = run.model ? modelSelectValue(run.model, run.modelProvider ?? null) : ''
  const selectedReasoningEffort = run.reasoningEffort ?? ''
  const cardRef = useRef<HTMLElement | null>(null)
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  // Whether the hovering drop would land after (below) this card vs before.
  // Ref mirrors it for a staleness-free read in the drop handler.
  const [dragOverAfter, setDragOverAfter] = useState(false)
  const dragOverAfterRef = useRef(false)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<PromptImage[]>([])
  const [customCommandDraft, setCustomCommandDraft] = useState(run.agentCommand ?? '')
  const [askParentId, setAskParentId] = useState<string | null>(null)
  const [askDraft, setAskDraft] = useState('')
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null)
  const [collapsedTurnIds, setCollapsedTurnIds] = useState<Set<string>>(new Set())
  const [focusTurnId, setFocusTurnId] = useState<string | null>(null)
  const linearTurns = useMemo(() => buildLinearTurns(turns), [turns])
  const status = run.jobStatus
  const isDraft = turns.length === 0
  const tone = windowStatusTone(status, isDraft)
  // Turns now render oldest→newest, so the newest (default focus) is the last.
  const newestTurnId = linearTurns[linearTurns.length - 1]?.id ?? null
  const focusedTurnId = focusTurnId && linearTurns.some((turn) => turn.id === focusTurnId) ? focusTurnId : newestTurnId
  const focusedTurnRef = useRef<HTMLDivElement | null>(null)
  const askMoreFormRef = useRef<HTMLFormElement | null>(null)
  const askMoreTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Grow the prompt box to fit its content (typed or pasted), capped by the CSS
  // max-height (past which it scrolls). Done in JS so it works in browsers
  // without CSS `field-sizing`. Runs whenever the draft changes.
  useLayoutEffect(() => {
    const el = promptTextareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  useEffect(() => {
    setCustomCommandDraft(run.agentCommand ?? '')
  }, [run.id, run.agentCommand])

  // Keep the viewport anchored to the most relevant visible bubble.
  // If Ask Here is open, the inline form becomes the focus target instead.
  useEffect(() => {
    if (askParentId) {
      const frame = requestAnimationFrame(() => {
        scrollToFocusTarget(askMoreFormRef.current)
        askMoreTextareaRef.current?.focus({ preventScroll: true })
      })
      return () => cancelAnimationFrame(frame)
    }

    if (!focusedTurnId) return
    setCollapsedTurnIds(new Set(turns.filter((turn) => turn.id !== focusedTurnId).map((turn) => turn.id)))
    const frame = requestAnimationFrame(() => {
      scrollToFocusTarget(focusedTurnRef.current)
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedTurnId, askParentId])

  // Strict "read": clear the unread dot only once the end of the newest reply
  // actually scrolls into the viewport — not merely on opening/selecting the card.
  useEffect(() => {
    if (!isNewDone || collapsed || !focusedTurnId) return
    const sentinel = document.getElementById(assistantBubbleBottomId(focusedTurnId))
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onMarkRead(run.id)
      },
      { threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [isNewDone, collapsed, focusedTurnId, run.id, onMarkRead])

  function hideAllTurns() {
    setCollapsedTurnIds(new Set(turns.map((turn) => turn.id)))
    setAskParentId(null)
    setAskDraft('')
  }

  function dropFilePathIntoTextarea(
    event: DragEvent<HTMLTextAreaElement>,
    setValue: (value: string) => void,
  ) {
    // Image files dropped from the desktop become attachments; a path dragged
    // from the built-in file browser still inserts as text.
    const images = imageFilesFrom(event.dataTransfer)
    if (images.length) {
      event.preventDefault()
      event.stopPropagation()
      void attachImages(images)
      return
    }
    const filePath = filePathFromDrag(event)
    if (!filePath) return
    event.preventDefault()
    event.stopPropagation()
    setValue(insertIntoTextarea(event.currentTarget, filePath))
  }

  async function attachImages(files: File[]) {
    if (!files.length) return
    const room = MAX_PROMPT_IMAGES - attachments.length
    if (room <= 0) return
    const added = (await Promise.all(files.slice(0, room).map(toPromptImage))).filter(
      (image): image is PromptImage => image !== null,
    )
    if (added.length) setAttachments((current) => [...current, ...added].slice(0, MAX_PROMPT_IMAGES))
  }

  function pasteIntoPrompt(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = imageFilesFrom(event.clipboardData)
    if (!images.length) return // plain text paste: leave it to the browser
    event.preventDefault()
    void attachImages(images)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    // An image on its own is a legitimate prompt ("what is this?" is implied).
    if (!text && !attachments.length) return
    const images = attachments
    setDraft('')
    setAttachments([])
    const turnId = onSend(text, null, images)
    if (turnId) setFocusTurnId(turnId)
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
    const turnId = onSend(text, parentTurnId)
    if (turnId) setFocusTurnId(turnId)
  }

  function commitCustomAgentCommand() {
    const next = customCommandDraft.trim()
    if (next === (run.agentCommand ?? '').trim()) return
    onAgentCommandChange(next)
  }

  function handleCustomAgentCommandKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitCustomAgentCommand()
      event.currentTarget.blur()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setCustomCommandDraft(run.agentCommand ?? '')
      event.currentTarget.blur()
    }
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

  function scrollAssistantBubbleToBottom(turnId: string) {
    scrollToFocusTarget(document.getElementById(assistantBubbleBottomId(turnId)))
  }

  function renderTurn(turn: TurnItem): ReactNode {
    const canAskMore = turn.status !== 'running' && turn.status !== 'queued'
    const canDelete = turn.status !== 'running' && turn.status !== 'queued'
    const canStop = turn.status === 'running' && turn.id === stoppableTurnId
    const canRefresh = turn.status === 'running' && turn.id === refreshableTurnId
    const isTurnCollapsed = collapsedTurnIds.has(turn.id)

    return (
      <div
        key={turn.id}
        ref={turn.id === focusedTurnId ? focusedTurnRef : undefined}
        className={`term-turn ${turn.status}`}
      >
        <div
          className={`term-prompt-line ${isTurnCollapsed ? 'collapsed' : ''}`}
          role="button"
          tabIndex={0}
          aria-expanded={!isTurnCollapsed}
          onClick={(event) => {
            if (hasTextSelectionInside(event.currentTarget)) return
            toggleTurnCollapsed(turn.id)
          }}
          onKeyDown={(event) => toggleTurnFromKey(event, turn.id)}
        >
          <span className="term-prompt-mark" aria-hidden>›</span>
          <span className="term-prompt-text">{turn.prompt}</span>
          <span className="term-turn-actions">
            <button
              type="button"
              className="term-action"
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                void copyPrompt(turn)
              }}
            >
              {copiedTurnId === turn.id ? 'copied' : 'copy'}
            </button>
            <button
              type="button"
              className="term-action danger"
              disabled={!canDelete}
              title={canDelete ? 'Delete this Q/A turn' : 'Stop the running turn before deleting it'}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                if (canDelete) onDeleteTurn(turn.id)
              }}
            >
              delete
            </button>
          </span>
        </div>
        {turn.images?.length && !isTurnCollapsed ? (
          <div className="term-prompt-images">
            {turn.images.map((image) => (
              <a key={image.id} href={image.dataUrl} target="_blank" rel="noreferrer">
                <img src={image.dataUrl} alt={image.name} loading="lazy" />
              </a>
            ))}
          </div>
        ) : null}
        {!isTurnCollapsed ? (
          <div className="term-response">
            <div className="term-response-head">
              <span className="term-response-role">hermes · {turnRoleLabel(turn.status).toLowerCase()}</span>
              <span className="term-turn-actions always">
                {canStop ? (
                  <button type="button" className="term-action danger" onClick={() => onStopTurn(turn.id)} aria-label="Stop Hermes">
                    stop
                  </button>
                ) : null}
                {canRefresh ? (
                  <button type="button" className="term-action" onClick={() => onRefreshTurn(turn.id)} aria-label="Refresh Hermes stream">
                    refresh
                  </button>
                ) : null}
                <button
                  type="button"
                  className="term-action"
                  onClick={() => scrollAssistantBubbleToBottom(turn.id)}
                  aria-label="Scroll to bottom of this reply"
                >
                  to bottom
                </button>
                <button
                  type="button"
                  className="term-action"
                  disabled={!canAskMore}
                  title="Ask a follow-up from this reply"
                  onClick={() => {
                    setAskParentId(turn.id)
                    setAskDraft('')
                  }}
                >
                  ask here
                </button>
              </span>
            </div>
            <TurnActivity turn={turn} />
            <div className="md-body term-md">
              <ReactMarkdown
                remarkPlugins={richMarkdownPlugins.remark}
                rehypePlugins={richMarkdownPlugins.rehype}
                components={richMarkdownComponents}
              >
                {turn.response || '…'}
              </ReactMarkdown>
              {turn.status === 'running' || turn.status === 'queued' ? (
                <div className="term-response-wait">
                  <AsciiSpinner />
                  <span>{turn.status === 'queued' ? 'waiting in queue' : 'working'}…</span>
                  {canRefresh ? (
                    <button
                      type="button"
                      className="term-response-wait-refresh"
                      onClick={() => onRefreshTurn(turn.id)}
                      title="Hermes may have finished — reconnect to pull the latest"
                    >
                      refresh
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {askParentId === turn.id ? (
              <form ref={askMoreFormRef} className="ask-more-form" onSubmit={(event) => submitAskMore(event, turn.id)}>
                <textarea
                  ref={askMoreTextareaRef}
                  value={askDraft}
                  onChange={(event) => setAskDraft(event.target.value)}
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes('application/x-agent-rider-file-path')) event.preventDefault()
                  }}
                  onDrop={(event) => dropFilePathIntoTextarea(event, setAskDraft)}
                  placeholder="Ask a follow-up from this reply…"
                  rows={2}
                />
                <div className="ask-more-controls">
                  <button
                    type="button"
                    className="term-action"
                    onClick={() => {
                      setAskParentId(null)
                      setAskDraft('')
                    }}
                  >
                    cancel
                  </button>
                  <button type="submit" className="term-action accent">
                    send
                  </button>
                </div>
              </form>
            ) : null}
            <div id={assistantBubbleBottomId(turn.id)} className="assistant-bubble-bottom" aria-hidden />
          </div>
        ) : null}
      </div>
    )
  }

  // In full-window TUI mode the terminal is a fixed overlay covering the card,
  // so the context fields rendered in the card body sit hidden behind it. Render
  // them inside the overlay (below its titlebar) instead so "Show context" works.
  // A stale persisted full-window flag must not hide a collapsed card's only
  // mounted titlebar. Once the card expands, the same flag can safely mount
  // the terminal overlay and its replacement titlebar.
  const isTuiFullWindow = Boolean(tui && agentTerminalState?.fullWindow && !collapsed)
  const contextFields = (
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
        <span className="tree-label">Title</span>
        <input
          className="conv-input"
          value={run.task}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="Conversation title"
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
          {renderAgentOptions(agentAvailability)}
        </select>
      </div>
      {agentType === 'custom' ? (
        <div className="conv-meta-row">
          <span className="tree-label">Command</span>
          <div className="conv-agent-command-editor">
            <input
              className="conv-input conv-agent-command"
              value={customCommandDraft}
              onChange={(event) => setCustomCommandDraft(event.target.value)}
              onKeyDown={handleCustomAgentCommandKeyDown}
              placeholder="bash command, e.g. claude --permission-mode auto"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <button
              type="button"
              className="conv-agent-command-apply"
              disabled={customCommandDraft.trim() === (run.agentCommand ?? '').trim()}
              onClick={commitCustomAgentCommand}
            >
              Apply
            </button>
          </div>
        </div>
      ) : null}
      <div className="conv-meta-row">
        <span className="tree-label">Workspace</span>
        <button type="button" className="conv-workspace-btn" onClick={onOpenPicker} title={run.workspacePath}>
          <span className="conv-workspace-path">{run.workspacePath}</span>
          <span className="conv-workspace-action">Change…</span>
        </button>
      </div>
    </div>
  )

  const toggleCollapsedState = onToggle

  return (
    <article
      id={`conversation-${run.id}`}
      ref={cardRef}
      className={`conv-card ${embedded ? 'embedded' : ''} ${collapsed ? 'collapsed' : ''} ${active ? 'active' : ''} ${dragging ? 'dragging' : ''} ${dragOver ? (dragOverAfter ? 'drag-over after' : 'drag-over') : ''}`}
      onMouseDown={(event) => {
        if (embedded) return
        // Toggle draggable synchronously on the element so the browser's
        // drag-vs-select decision for THIS press is correct: off over inputs
        // (so they stay selectable), on everywhere else.
        const target = event.target as HTMLElement
        if (!cardRef.current) return
        const canDrag = !target.closest(DRAG_EXCLUDE)
        cardRef.current.draggable = canDrag
        if (canDrag) resetDraggableAfterPointerSettles(cardRef.current)
      }}
      onMouseUp={() => {
        if (embedded) return
        if (cardRef.current) cardRef.current.draggable = false
      }}
      onDragStart={(event) => {
        if (embedded) {
          event.preventDefault()
          return
        }
        const target = event.target as HTMLElement
        if (target.closest(DRAG_EXCLUDE)) {
          event.preventDefault()
          return
        }
        beginElementDrag(event, cardRef.current, run.id)
        onDragStartCard()
      }}
      onDragEnd={() => {
        if (embedded) return
        if (cardRef.current) cardRef.current.draggable = false
        setDragOver(false)
        onDragEndCard()
      }}
      onDragOver={(event) => {
        if (embedded) return
        if (!dragActive) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        const after = event.clientY > rect.top + rect.height / 2
        dragOverAfterRef.current = after
        if (!dragOver) setDragOver(true)
        if (after !== dragOverAfter) setDragOverAfter(after)
      }}
      onDragLeave={(event) => {
        if (embedded) return
        // Ignore leaves into child elements.
        if (event.currentTarget.contains(event.relatedTarget as Node)) return
        setDragOver(false)
      }}
      onDrop={(event) => {
        if (embedded) return
        if (!dragActive) return
        event.preventDefault()
        event.stopPropagation()
        setDragOver(false)
        // Use the position computed during dragover (the drop event's clientY
        // is unreliable across browsers) so it matches the indicator shown.
        onDropOnCard(dragOverAfterRef.current)
      }}
    >
      {/* In full-window mode the titlebar is rendered inside the WebTerminal
          overlay so the two stay visually connected as one element. */}
      {isTuiFullWindow ? null : (
      <div
        className="win-titlebar"
        onDoubleClick={toggleCollapsedState}
        title="Drag to reorder · double-click to collapse"
      >
        <WinGrip />
        <span className="win-dot" style={{ background: tone.dot }} aria-hidden />
        <input
          className="win-title-input"
          value={run.task}
          onChange={(event) => onTitleChange(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          placeholder="untitled"
          aria-label="Conversation title"
          size={Math.max(4, Math.min(28, (run.task || 'untitled').length + 1))}
        />
        <span className="win-meta" title={timeLabel(run.createdAt)}>
          {run.category || '···'} | {run.project || '···'}
        </span>
        <div className="win-spacer" />
        {isNewDone ? <span className="new-dot" title="New result" /> : null}
        <button
          type="button"
          className={`win-btn ${fileBrowserOpen ? 'active' : ''}`}
          title={fileBrowserOpen ? 'Hide file browser' : 'Browse files'}
          aria-label={fileBrowserOpen ? 'Hide file browser' : 'Browse files'}
          aria-expanded={fileBrowserOpen}
          onClick={(event) => {
            event.stopPropagation()
            setFileBrowserOpen((current) => !current)
          }}
        >
          <WinFilesIcon />
        </button>
        {hideContext ? null : (
          <button
            type="button"
            className={`win-btn ${metaCollapsed ? '' : 'active'}`}
            title={metaCollapsed ? 'Show context (category / project / agent / workspace)' : 'Hide context'}
            aria-label="Toggle context fields"
            aria-expanded={!metaCollapsed}
            onClick={(event) => {
              event.stopPropagation()
              onMetaCollapsedChange(!metaCollapsed)
            }}
          >
            <WinContextIcon />
          </button>
        )}
        <button
          type="button"
          className="win-btn"
          title={collapsed ? 'Expand window' : 'Collapse window'}
          aria-label={collapsed ? 'Expand window' : 'Collapse window'}
          aria-expanded={!collapsed}
          onClick={(event) => {
            event.stopPropagation()
            toggleCollapsedState()
          }}
        >
          {collapsed ? <WinConversationExpandIcon /> : <WinConversationCollapseIcon />}
        </button>
        {onToggleMaximize ? (
          <button
            type="button"
            className="win-btn"
            title={maximized || isTuiFullWindow ? 'Restore' : (tui ? 'Full window' : 'Maximize in grid')}
            aria-label={maximized || isTuiFullWindow ? 'Restore' : (tui ? 'Full window' : 'Maximize in grid')}
            onClick={(event) => {
              event.stopPropagation()
              onToggleMaximize()
            }}
          >
            {tui ? (
              <WinFullscreenIcon active={isTuiFullWindow} />
            ) : (
              <WinMaximizeIcon active={maximized} />
            )}
          </button>
        ) : null}
        <button
          type="button"
          className="win-btn win-btn-close"
          title="Close window"
          aria-label="Close window"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          <WinCloseIcon />
        </button>
      </div>
      )}

      {!collapsed ? (
        <div className="conv-card-body">
          {hideContext || metaCollapsed || isTuiFullWindow ? null : (
          <div className="conv-meta">
            {contextFields}
          </div>
          )}

          <div className={`conv-content-shell ${tui ? 'tui-content-shell' : ''} ${tui && agentTerminalState?.fullWindow ? 'file-browser-full-window' : ''}`}>
            <FileBrowser
              rootPath={run.workspacePath}
              open={fileBrowserOpen}
              onToggle={() => setFileBrowserOpen((current) => !current)}
              showOwnToggle={false}
            />

            {tui && (agentType !== 'custom' || customAgentCommand) ? (
              <div className="conv-agent-terminal">
                <WebTerminal
                  // Re-attach (not restart) on agent/workspace change — the tmux
                  // session persists in the background, keyed by run + agent + cwd.
                  key={`${agentType}:${customAgentCommand}:${run.workspacePath}`}
                  agent={agentType}
                  customCommand={agentType === 'custom' ? customAgentCommand : undefined}
                  sessionKey={run.id}
                  initialCwd={run.workspacePath}
                  eyebrow={`Agent · ${agentLabel(agentType)} · persistent`}
                  title={agentType === 'custom' ? customAgentCommand : `${agentType} — interactive`}
                  showClose={false}
                  onClose={() => {}}
                  collapsible={false}
                  frameless
                  titleBar={tui && !hideHeader ? (
                    <>
                    <div className="win-titlebar" onDoubleClick={toggleCollapsedState} title="Drag to reorder · double-click to collapse">
                      <WinGrip />
                      <span className="win-dot" style={{ background: tone.dot }} aria-hidden />
                      <input className="win-title-input" value={run.task} onChange={(event) => onTitleChange(event.target.value)} onClick={(event) => event.stopPropagation()} placeholder="untitled" aria-label="Conversation title" size={Math.max(4, Math.min(28, (run.task || 'untitled').length + 1))} />
                      <span className="win-meta" title={timeLabel(run.createdAt)}>{run.category || '···'} | {run.project || '···'}</span>
                      <div className="win-spacer" />
                      {isNewDone ? <span className="new-dot" title="New result" /> : null}
                      <button type="button" className={`win-btn ${fileBrowserOpen ? 'active' : ''}`} title={fileBrowserOpen ? 'Hide file browser' : 'Browse files'} aria-label={fileBrowserOpen ? 'Hide file browser' : 'Browse files'} aria-expanded={fileBrowserOpen} onClick={(event) => { event.stopPropagation(); setFileBrowserOpen((current) => !current) }}><WinFilesIcon /></button>
                      {hideContext ? null : <button type="button" className={`win-btn ${metaCollapsed ? '' : 'active'}`} title={metaCollapsed ? 'Show context' : 'Hide context'} aria-label="Toggle context fields" aria-expanded={!metaCollapsed} onClick={(event) => { event.stopPropagation(); onMetaCollapsedChange(!metaCollapsed) }}><WinContextIcon /></button>}
                      <button type="button" className="win-btn" title={collapsed ? 'Expand window' : 'Collapse window'} aria-label={collapsed ? 'Expand window' : 'Collapse window'} aria-expanded={!collapsed} onClick={(event) => { event.stopPropagation(); toggleCollapsedState() }}>{collapsed ? <WinConversationExpandIcon /> : <WinConversationCollapseIcon />}</button>
                      {onToggleMaximize ? <button type="button" className="win-btn" title={maximized || agentTerminalState?.fullWindow ? 'Restore' : 'Full window'} aria-label={maximized || agentTerminalState?.fullWindow ? 'Restore' : 'Full window'} onClick={(event) => { event.stopPropagation(); onToggleMaximize() }}><WinFullscreenIcon active={agentTerminalState?.fullWindow} /></button> : null}
                      <button type="button" className="win-btn win-btn-close" title="Close window" aria-label="Close window" onClick={(event) => { event.stopPropagation(); onClose() }}><WinCloseIcon /></button>
                    </div>
                    {hideContext || metaCollapsed ? null : (
                      <div className="conv-meta conv-meta-overlay">
                        {contextFields}
                      </div>
                    )}
                    </>
                  ) : undefined}
                  fullWindow={agentTerminalState?.fullWindow}
                  promptContext={run.cardKind === 'app-builder' ? 'app-builder' : undefined}
                  appWorkspace={run.cardKind === 'app-builder' ? run.workspacePath : undefined}
                  onStateChange={onAgentTerminalStateChange}
                  notepad={agentTerminalState?.notepad}
                  onNotepadChange={(text) => onAgentTerminalStateChange({ notepad: text })}
                  // Rendered inside WebTerminal's own box (not a sibling) so it
                  // stays visible/clickable in full-window mode, where the section
                  // becomes `position: fixed` and covers any sibling elements.
                  headerLeading={
                    <button
                      type="button"
                      className={`terminal-clear file-browser-toggle-inline ${fileBrowserOpen ? 'active' : ''}`}
                      aria-expanded={fileBrowserOpen}
                      title={fileBrowserOpen ? 'Hide file browser' : 'Browse files'}
                      onClick={(event) => {
                        event.stopPropagation()
                        setFileBrowserOpen((current) => !current)
                      }}
                    >
                      Files
                    </button>
                  }
                />
              </div>
            ) : tui ? (
              <div className="conv-agent-command-empty">
                Enter a bash command to launch the custom TUI agent.
              </div>
            ) : (
              <>
                <div className="win-body conv-transcript">
                  {turns.length ? (
                    <>
                      <div className="feed-toolbar">
                        <span className="feed-toolbar-label">
                          {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
                        </span>
                        <button
                          type="button"
                          className="term-action"
                          onClick={hideAllTurns}
                          title="Collapse every turn in this conversation"
                        >
                          hide all
                        </button>
                      </div>
                      {linearTurns.map((turn) => renderTurn(turn))}
                    </>
                  ) : (
                    <div className="win-body-empty">
                      New conversation.
                      {'\n'}Awaiting first message…
                    </div>
                  )}
                </div>

                {attachments.length ? (
                  <ul className="win-attachments">
                    {attachments.map((image) => (
                      <li key={image.id} className="win-attachment">
                        <img src={image.dataUrl} alt={image.name} />
                        <button
                          type="button"
                          className="win-attachment-remove"
                          title={`Remove ${image.name}`}
                          onClick={() => setAttachments((current) => current.filter((item) => item.id !== image.id))}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <form className="win-promptbar" onSubmit={submit}>
                  <span className="win-prompt-mark" aria-hidden>›</span>
                  {draft || attachments.length ? null : <span className="win-cursor" aria-hidden />}
                  <textarea
                    ref={promptTextareaRef}
                    value={draft}
                    rows={1}
                    onChange={(event) => setDraft(event.target.value)}
                    onPaste={pasteIntoPrompt}
                    onDragOver={(event) => {
                      if (
                        event.dataTransfer.types.includes('application/x-agent-rider-file-path')
                        || event.dataTransfer.types.includes('Files')
                      ) event.preventDefault()
                    }}
                    onDrop={(event) => dropFilePathIntoTextarea(event, setDraft)}
                    placeholder={isDraft ? 'Describe the task to start this conversation…' : `Reply to ${conversationTitle(run)}…`}
                    aria-label="Message"
                    style={draft || attachments.length ? undefined : { caretColor: 'transparent' }}
                  />
                  <label className="win-attach" title="Attach an image (or paste one)">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(event) => {
                        void attachImages(Array.from(event.target.files ?? []))
                        event.target.value = ''
                      }}
                    />
                    <WinImageIcon />
                  </label>
                  {draft || attachments.length ? (
                    <button type="submit" className="term-action accent win-send" title="Send">
                      send ↵
                    </button>
                  ) : null}
                </form>

                <div className="win-footer">
                  <label className="win-footer-control" title="Model">
                    <select
                      value={selectedModelValue}
                      onChange={(event) => {
                        const next = parseModelSelectValue(event.target.value)
                        onModelChange(next.model, next.modelProvider)
                      }}
                      aria-label="Model"
                    >
                      <option value="">
                        {modelCatalog.defaultModel ? `default · ${modelCatalog.defaultModel}` : 'default model'}
                      </option>
                      {modelCatalog.groups.map((group) => (
                        <optgroup key={`${group.providerId ?? group.provider}:${group.provider}`} label={group.provider}>
                          {group.models.map((model) => (
                            <option key={`${group.providerId ?? group.provider}:${model.id}`} value={modelSelectValue(model.id, group.providerId)}>
                              {model.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="term-action win-models-refresh"
                    disabled={modelsRefreshing}
                    title="Reload the model list from hermes (after switching provider in the CLI)"
                    onClick={() => onRefreshModels()}
                  >
                    {modelsRefreshing ? '…' : '↻'}
                  </button>
                  <label className="win-footer-control" title="Reasoning effort">
                    <select
                      value={selectedReasoningEffort}
                      onChange={(event) => onReasoningEffortChange(event.target.value)}
                      aria-label="Reasoning effort"
                    >
                      <option value="">default effort</option>
                      {reasoningEfforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="win-spacer" />
                  <button type="button" className="win-footer-path" onClick={onOpenPicker} title={`${run.workspacePath} — change workspace`}>
                    {run.workspacePath}
                  </button>
                </div>
            </>
          )}
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

function AppBuilderPanel({
  run,
  apps,
  appWarnings,
  targetAppId,
  chatContent,
  onTitleChange,
  onCategoryChange,
  onProjectChange,
  onAgentChange,
  onAgentCommandChange,
  onClose,
  collapsed,
  fullWindow,
  mode,
  onModeChange,
  contextCollapsed,
  onContextCollapsedChange,
  splitRatio,
  onStateChange,
  maximized,
  onToggleMaximize,
}: {
  run: RunNode
  apps: AgentApp[]
  appWarnings: AppWarning[]
  /** When set, this builder instance edits an existing app (Resources → App entry). */
  targetAppId?: string
  chatContent: ReactNode
  onTitleChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onProjectChange: (value: string) => void
  onAgentChange: (value: AgentType) => void
  onAgentCommandChange: (value: string) => void
  onClose: () => void
  collapsed?: boolean
  fullWindow?: boolean
  mode?: AppBuilderMode
  onModeChange?: (mode: AppBuilderMode) => void
  contextCollapsed?: boolean
  onContextCollapsedChange?: (collapsed: boolean) => void
  /** Chat pane share (0.15–0.85) of the Chat+App split. */
  splitRatio?: number
  onStateChange?: (patch: WorkspacePanelState) => void
  /** True while this panel is the single block filling the workspace grid. */
  maximized?: boolean
  /** Toggles this panel as the single block filling the workspace grid. */
  onToggleMaximize?: () => void
}) {
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const [internalFullWindow, setInternalFullWindow] = useState(false)
  const [internalMode, setInternalMode] = useState<AppBuilderMode>('chat')
  const [internalContextCollapsed, setInternalContextCollapsed] = useState(false)
  const [internalSplit, setInternalSplit] = useState(APP_BUILDER_SPLIT_DEFAULT)
  // Live ratio while the divider is being dragged (committed on pointer-up).
  const [dragSplit, setDragSplit] = useState<number | null>(null)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)
  const [customCommandDraft, setCustomCommandDraft] = useState(run.agentCommand ?? '')
  const isCollapsed = collapsed ?? internalCollapsed
  const isFullWindow = fullWindow ?? internalFullWindow
  const activeMode = mode ?? internalMode
  const isContextCollapsed = contextCollapsed ?? internalContextCollapsed
  const splitValue = dragSplit ?? splitRatio ?? internalSplit
  const agentAvailability = useAgentAvailability()
  // Full-window App View drops the builder chrome (header/context/tabs) so the
  // app truly fills the screen.
  const appViewOnly = isFullWindow && activeMode === 'app'
  const appTitle = run.task.trim() || 'Untitled app'
  const appSlug = pathSegment(appTitle, 'untitled-app')
  const appAtWork = targetAppId
    ? apps.find((app) => app.id === targetAppId) ?? null
    : apps.find((app) => app.id === appSlug || app.label.trim().toLowerCase() === appTitle.toLowerCase()) ?? apps.find((app) => app.hasDist) ?? apps[0] ?? null

  useEffect(() => {
    setCustomCommandDraft(run.agentCommand ?? '')
  }, [run.id, run.agentCommand])

  function setCollapsedState(updater: boolean | ((current: boolean) => boolean)) {
    const next = typeof updater === 'function' ? updater(isCollapsed) : updater
    if (collapsed === undefined) setInternalCollapsed(next)
    onStateChange?.({ collapsed: next })
  }

  function setFullWindowState(updater: boolean | ((current: boolean) => boolean)) {
    const next = typeof updater === 'function' ? updater(isFullWindow) : updater
    if (fullWindow === undefined) setInternalFullWindow(next)
    onStateChange?.({ fullWindow: next })
  }

  function setModeState(next: AppBuilderMode) {
    if (mode === undefined) setInternalMode(next)
    onModeChange?.(next)
  }

  function setContextCollapsedState(next: boolean) {
    if (contextCollapsed === undefined) setInternalContextCollapsed(next)
    onContextCollapsedChange?.(next)
  }

  function commitSplit(next: number) {
    const ratio = clampBuilderSplit(next)
    if (splitRatio === undefined) setInternalSplit(ratio)
    onStateChange?.({ builderSplit: ratio })
  }

  function handleSplitPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const container = splitContainerRef.current
    if (!container || event.button !== 0) return
    event.preventDefault()
    const ratioFor = (clientX: number) => {
      const rect = container.getBoundingClientRect()
      return rect.width > 0 ? clampBuilderSplit((clientX - rect.left) / rect.width) : null
    }
    const onMove = (moveEvent: PointerEvent) => {
      const ratio = ratioFor(moveEvent.clientX)
      if (ratio !== null) setDragSplit(ratio)
    }
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const ratio = ratioFor(upEvent.clientX)
      if (ratio !== null) commitSplit(ratio)
      setDragSplit(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  function commitCustomAgentCommand() {
    const next = customCommandDraft.trim()
    if (next === (run.agentCommand ?? '').trim()) return
    onAgentCommandChange(next)
  }

  function handleCustomAgentCommandKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitCustomAgentCommand()
      event.currentTarget.blur()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setCustomCommandDraft(run.agentCommand ?? '')
      event.currentTarget.blur()
    }
  }

  const appView = (
    <div className="app-builder-view" role="tabpanel">
      <div className="app-builder-viewbar">
        <strong>{appAtWork?.label ?? 'App at work'}</strong>
        <span>{appAtWork?.hasDist ? 'Ready' : appAtWork ? 'Waiting for build' : 'No app yet'}</span>
        <button
          type="button"
          className="terminal-icon-button app-builder-view-expand"
          title={isFullWindow ? 'Exit full window' : 'Expand to full window'}
          aria-label={isFullWindow ? 'Exit full window' : 'Expand to full window'}
          onClick={() => setFullWindowState((current) => !current)}
        >
          {isFullWindow ? '↙' : '⛶'}
        </button>
      </div>
      {appAtWork?.hasDist ? (
        <iframe className="app-builder-frame" title={appAtWork.label} src={appAtWork.entry} />
      ) : (
        <div className="conv-empty">
          {appAtWork ? `${appAtWork.label} needs a dist/index.html build before preview.` : 'The app being built will appear here after the Resources App scan refreshes.'}
        </div>
      )}
      {appWarnings.length ? (
        <div className="app-builder-warnings">
          {appWarnings.map((warning, index) => (
            <div key={`builder-warn-${index}`} className="app-warning" role="alert">
              ⚠ {warning.id ?? warning.dir ?? 'plugin'}: {warning.error}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )

  return (
    <section
      className={`app-builder-card conv-card ${isCollapsed && !appViewOnly ? 'collapsed' : ''} ${isFullWindow ? 'full-window' : ''} ${appViewOnly ? 'app-view-only' : ''}`}
      aria-label="App Builder"
    >
      {appViewOnly ? null : (
      <div className="win-titlebar" onDoubleClick={() => setCollapsedState((current) => !current)}>
        <WinGrip />
        <span
          className="win-dot"
          style={{ background: appAtWork?.hasDist ? '#46c98b' : '#e0a33e' }}
          aria-hidden
        />
        <input
          className="win-title-input app-builder-title-input"
          value={run.task}
          onChange={(event) => onTitleChange(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          placeholder="untitled app"
          aria-label="App title"
          size={Math.max(4, Math.min(28, (run.task || 'untitled app').length + 1))}
        />
        <span className="win-meta">
          {run.category || '···'} | {run.project || '···'}
        </span>
        <div className="win-spacer" />
        <span className="win-status" style={{ color: appAtWork?.hasDist ? '#5fd39b' : '#e6b25a' }}>
          {appAtWork?.hasDist ? 'ready' : appAtWork ? 'building' : 'no build'}
        </span>
        <button
          type="button"
          className={`win-btn ${isContextCollapsed ? '' : 'active'}`}
          title={isContextCollapsed ? 'Show context' : 'Hide context'}
          aria-label="Toggle context"
          aria-expanded={!isContextCollapsed}
          onClick={(event) => {
            event.stopPropagation()
            setContextCollapsedState(!isContextCollapsed)
          }}
        >
          <WinContextIcon />
        </button>
        <button
          type="button"
          className="win-btn"
          title={isCollapsed ? 'Expand window' : 'Collapse window'}
          aria-label={isCollapsed ? 'Expand window' : 'Collapse window'}
          aria-expanded={!isCollapsed}
          onClick={() => setCollapsedState((current) => !current)}
        >
          <span className={`conv-caret ${isCollapsed ? '' : 'open'}`} aria-hidden>▾</span>
        </button>
        {onToggleMaximize ? (
          <button
            type="button"
            className="win-btn"
            title={maximized ? 'Restore grid layout' : 'Maximize in grid'}
            aria-label={maximized ? 'Restore grid layout' : 'Maximize in grid'}
            onClick={(event) => {
              event.stopPropagation()
              onToggleMaximize()
            }}
          >
            <WinMaximizeIcon active={maximized} />
          </button>
        ) : null}
        <button
          type="button"
          className="win-btn"
          title={isFullWindow ? 'Exit full window' : 'Expand to full window'}
          aria-label={isFullWindow ? 'Exit full window' : 'Expand to full window'}
          onClick={(event) => {
            event.stopPropagation()
            setFullWindowState((current) => !current)
          }}
        >
          <WinFullscreenIcon active={isFullWindow} />
        </button>
        <button
          type="button"
          className="win-btn win-btn-close"
          title="Close App Builder"
          aria-label="Close App Builder"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          <WinCloseIcon />
        </button>
      </div>
      )}

      {!isCollapsed || appViewOnly ? (
        <div className="conv-card-body app-builder-body">
          {appViewOnly ? null : (
          <div className={`conv-meta app-builder-context ${isContextCollapsed ? 'collapsed' : ''}`}>
            <button
              type="button"
              className="conv-meta-toggle"
              aria-expanded={!isContextCollapsed}
              onClick={() => setContextCollapsedState(!isContextCollapsed)}
            >
              <span className={`conv-meta-caret ${isContextCollapsed ? '' : 'open'}`} aria-hidden>▾</span>
              <span className="conv-meta-toggle-label">Context</span>
              {isContextCollapsed ? (
                <span className="conv-meta-summary">
                  {[run.category, run.project, run.task, agentLabel(run.agentType)].filter(Boolean).join(' · ') || 'Category · Project · Title · Agent'}
                </span>
              ) : null}
            </button>
            {isContextCollapsed ? null : (
            <div className="conv-meta-fields">
              <div className="conv-meta-row">
                <span className="tree-label">Category</span>
                <input
                  className="conv-input"
                  list="known-categories"
                  value={run.category}
                  onChange={(event) => onCategoryChange(event.target.value)}
                  placeholder="App category"
                />
              </div>
              <div className="conv-meta-row">
                <span className="tree-label">Project</span>
                <input
                  className="conv-input"
                  list="known-projects"
                  value={run.project}
                  onChange={(event) => onProjectChange(event.target.value)}
                  placeholder="App project"
                />
              </div>
              <div className="conv-meta-row">
                <span className="tree-label">Title</span>
                <input
                  className="conv-input"
                  value={run.task}
                  onChange={(event) => onTitleChange(event.target.value)}
                  placeholder="App title"
                />
              </div>
              <div className="conv-meta-row">
                <span className="tree-label">Agent</span>
                <select
                  className="conv-input conv-agent-select"
                  value={run.agentType ?? 'hermes'}
                  onChange={(event) => onAgentChange(event.target.value as AgentType)}
                  aria-label="App Builder agent"
                >
                  {renderAgentOptions(agentAvailability)}
                </select>
              </div>
              {run.agentType === 'custom' ? (
                <div className="conv-meta-row">
                  <span className="tree-label">Command</span>
                  <div className="conv-agent-command-editor">
                    <input
                      className="conv-input conv-agent-command"
                      value={customCommandDraft}
                      onChange={(event) => setCustomCommandDraft(event.target.value)}
                      onKeyDown={handleCustomAgentCommandKeyDown}
                      placeholder="bash command, e.g. claude --permission-mode auto"
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                    />
                    <button
                      type="button"
                      className="conv-agent-command-apply"
                      disabled={customCommandDraft.trim() === (run.agentCommand ?? '').trim()}
                      onClick={commitCustomAgentCommand}
                    >
                      Apply
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
            )}
          </div>
          )}

          {appViewOnly ? null : (
          <div className="app-builder-tabs" role="tablist" aria-label="App Builder view">
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === 'chat'}
              className={activeMode === 'chat' ? 'active' : ''}
              onClick={() => setModeState('chat')}
            >
              Chat Window
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === 'app'}
              className={activeMode === 'app' ? 'active' : ''}
              onClick={() => setModeState('app')}
            >
              App View
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === 'split'}
              className={activeMode === 'split' ? 'active' : ''}
              onClick={() => setModeState('split')}
            >
              Chat+App
            </button>
          </div>
          )}

          {activeMode === 'chat' ? (
            <div className="app-builder-chat" role="tabpanel">
              {chatContent}
            </div>
          ) : activeMode === 'split' ? (
            <div
              className={`app-builder-split ${dragSplit !== null ? 'dragging' : ''}`}
              role="tabpanel"
              ref={splitContainerRef}
            >
              <div className="app-builder-split-chat" style={{ width: `${splitValue * 100}%` }}>
                {chatContent}
              </div>
              <div
                className="app-builder-split-divider"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize chat and app panes"
                onPointerDown={handleSplitPointerDown}
              />
              <div className="app-builder-split-app">{appView}</div>
            </div>
          ) : (
            appView
          )}
        </div>
      ) : null}
    </section>
  )
}

function ResourceSidebar({
  openPluginIds,
  onLaunchPlugin,
  apps,
  appWarnings,
  appBuilderOpen,
  appBuilderTitle,
  onLaunchAppBuilder,
  openAppSlugs,
  onLaunchApp,
  onReorderApps,
  onRenameApp,
}: {
  openPluginIds: Set<string>
  onLaunchPlugin: (pluginId: string) => void
  apps: AgentApp[]
  appWarnings: AppWarning[]
  appBuilderOpen: boolean
  appBuilderTitle: string
  onLaunchAppBuilder: () => void
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
            <div className="tree-nav-project resource-app-tree">
              <div className="tree-nav-label">Build</div>
              <div className="tree-nav-runs">
                <button
                  type="button"
                  className="tree-nav-run resource-tool build-app-button"
                  onClick={onLaunchAppBuilder}
                  title="Start a new App Builder conversation"
                >
                  <span className="tree-run-title">Build an App</span>
                  <LaunchIcon open={appBuilderOpen} />
                </button>
                <button
                  type="button"
                  className={`tree-nav-run resource-tool ${appBuilderOpen ? 'active' : ''}`}
                  onClick={onLaunchAppBuilder}
                  title={appBuilderOpen ? 'App Builder is open' : 'Launch App Builder'}
                >
                  <span className="tree-run-title">{appBuilderTitle}</span>
                  <LaunchIcon open={appBuilderOpen} />
                </button>
              </div>
            </div>
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
          title={open ? `${app.label} is open in App Builder` : `Open ${app.label} in App Builder`}
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
  promptContext,
  appWorkspace,
  onStateChange,
  headerLeading,
  frameless = false,
  titleBar,
  maximized,
  onToggleMaximize,
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
  promptContext?: PromptContext
  appWorkspace?: string
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
  /** True while this panel is the single block filling the workspace grid. */
  maximized?: boolean
  /** Toggles this panel as the single block filling the workspace grid. */
  onToggleMaximize?: () => void
  /** TUI cards only: persisted scratch draft (see WorkspacePanelState.notepad). */
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
  const notepadEnabled = agentTerminal && typeof onNotepadChange === 'function'
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
    const promptContextParam = promptContext ? `&prompt_context=${encodeURIComponent(promptContext)}` : ''
    const appWorkspaceParam = appWorkspace ? `&app_workspace=${encodeURIComponent(appWorkspace)}` : ''
    const resetParam = resetOnNextConnectRef.current ? '&reset=1' : ''
    resetOnNextConnectRef.current = false
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/store/terminal/ws?cwd=${encodeURIComponent(initialCwd)}&cols=${terminal.cols}&rows=${terminal.rows}${agentParam}${commandParam}${sessionParam}${promptContextParam}${appWorkspaceParam}${resetParam}`,
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
  }, [initialCwd, terminalKey, agent, customCommand, sessionKey, promptContext, appWorkspace])

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
            onClick={() => setTerminalCollapsedState((current) => !current)}
          >
            <span className={`conv-caret ${terminalCollapsed ? '' : 'open'}`} aria-hidden>{terminalCollapsed ? '▼' : '▲'}</span>
          </button>
        ) : null}
        {onToggleMaximize ? (
          <button
            type="button"
            className="win-btn"
            title={maximized ? 'Restore grid layout' : 'Maximize in grid'}
            aria-label={maximized ? 'Restore grid layout' : 'Maximize in grid'}
            onClick={(event) => {
              event.stopPropagation()
              onToggleMaximize()
            }}
          >
            <WinMaximizeIcon active={maximized} />
          </button>
        ) : null}
        <button
          type="button"
          className="win-btn"
          title={terminalFullWindow ? 'Exit full window' : 'Expand to full window'}
          aria-label={terminalFullWindow ? 'Exit full window' : 'Expand to full window'}
          onClick={(event) => {
            event.stopPropagation()
            setTerminalFullWindowState((current) => !current)
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
          <span className="terminal-cwd">{initialCwd === DEFAULT_TERMINAL_CWD ? '~/' : initialCwd}</span>
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
  const bridgeRef = useRef<HermesBridge | null>(null)
  const activeTurnRef = useRef<string | null>(null)
  const activeRunRef = useRef<string | null>(null)
  const hydratedRef = useRef(false)
  const queuedPromptsRef = useRef<QueuedPromptEntry[]>([])
  const assistantBufferRef = useRef('')
  const thinkingBufferRef = useRef('')
  const turnsRef = useRef<TurnItem[]>([])
  const runsRef = useRef<RunNode[]>([])
  // Pending debounced App Builder workspace-folder moves, keyed by run id —
  // avoids moving the folder on every keystroke while the title is being typed.
  const workspaceMoveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const [activeHermesTurnId, setActiveHermesTurnId] = useState<string | null>(null)
  const [activeHermesStreamId, setActiveHermesStreamId] = useState<string | null>(null)
  // Each conversation (run) keeps its own Hermes session for multi-turn context.
  const sessionByRunRef = useRef<Map<string, string>>(new Map())

  const [turns, setTurns] = useState<TurnItem[]>([])
  const [runs, setRuns] = useState<RunNode[]>([])
  const [resources, setResources] = useState<ResourceItem[]>([])
  const [connectionState, setConnectionState] = useState<HermesConnectionState>('disconnected')
  const [connectionDetail, setConnectionDetail] = useState('Disconnected')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionInfoText, setSessionInfoText] = useState('No Hermes session yet')
  const [error, setError] = useState<string | null>(null)
  const [workspaceRoot, setWorkspaceRoot] = useState(DEFAULT_WORKSPACE_CWD)
  const [modelCatalog, setModelCatalog] = useState<HermesModelCatalog>(EMPTY_MODEL_CATALOG)
  const [modelsRefreshing, setModelsRefreshing] = useState(false)
  const [reasoningEfforts, setReasoningEfforts] = useState<string[]>(DEFAULT_REASONING_EFFORTS)
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
  const [appFolderConflict, setAppFolderConflict] = useState<AppFolderConflict | null>(null)
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
  const appBuilderRoot = appListing.appsRoot || appBuilderFallbackRoot(workspaceRoot)

  useEffect(() => {
    turnsRef.current = turns
  }, [turns])

  useEffect(() => {
    runsRef.current = runs
  }, [runs])

  const terminalOpen = panelOrder.includes('terminal')
  const appBuilderOpen = panelOrder.includes(APP_BUILDER_PANEL_ID)
  const openPluginIds = useMemo(
    () => new Set(panelOrder.filter((p) => p.startsWith('plugin:')).map((p) => p.slice('plugin:'.length))),
    [panelOrder],
  )
  const openAppSlugs = useMemo(
    () =>
      new Set(
        panelOrder
          .map(migrateLegacyAppPanelId)
          .filter((p) => p.startsWith(APP_BUILDER_PANEL_PREFIX))
          .map((p) => p.slice(APP_BUILDER_PANEL_PREFIX.length)),
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
  // Opening a built app goes through its own App Builder instance so viewing
  // and maintaining apps share a single editor entry point.
  const launchApp = (slug: string) => {
    const app = appListing.apps.find((item) => item.id === slug)
    setRuns((current) =>
      current.some((run) => run.id === appBuilderRunIdFor(slug))
        ? current
        : [makeAppBuilderRun({ id: slug, label: app?.label ?? slug, workspacePath: app?.workspacePath }), ...current],
    )
    openPanel(appBuilderPanelIdFor(slug))
  }

  function makeAppBuilderRun(app?: { id: string; label: string; workspacePath?: string }): RunNode {
    const category = 'Product Delivery'
    const project = 'Agent Rider App'
    const task = app ? app.label : 'Build an App'
    return {
      id: app ? appBuilderRunIdFor(app.id) : APP_BUILDER_RUN_ID,
      prompt: '',
      category,
      categoryTags: tagsForCategory(category),
      project,
      workspace: '',
      workspacePath: app?.workspacePath ?? appBuilderWorkspacePath(appBuilderRoot, category, project, task, app?.id),
      task,
      job: 'App Builder',
      jobStatus: 'queued',
      resourceIds: [],
      model: '',
      modelProvider: null,
      reasoningEffort: '',
      sessionId: null,
      agentType: 'hermes',
      agentCommand: '',
      cardKind: 'app-builder',
      column: 0,
      createdAt: new Date().toISOString(),
    }
  }

  function launchAppBuilder() {
    setRuns((current) => (current.some((run) => run.id === APP_BUILDER_RUN_ID) ? current : [makeAppBuilderRun(), ...current]))
    setClosedRunIds((current) => {
      if (!current.has(APP_BUILDER_RUN_ID)) return current
      const next = new Set(current)
      next.delete(APP_BUILDER_RUN_ID)
      return next
    })
    openPanel(APP_BUILDER_PANEL_ID)
  }

  // Every open App Builder panel needs a backing run. Per-app builders wait for
  // the app listing so the run's title matches the app's label.
  useEffect(() => {
    const builderPanels = panelOrder.filter(isAppBuilderPanelId)
    if (!builderPanels.length) return
    setRuns((current) => {
      const additions: RunNode[] = []
      for (const panelId of builderPanels) {
        const runId = appBuilderRunIdForPanel(panelId)
        if (current.some((run) => run.id === runId) || additions.some((run) => run.id === runId)) continue
        const slug = appSlugForBuilderPanel(panelId)
        if (!slug) {
          additions.push(makeAppBuilderRun())
          continue
        }
        const app = appListing.apps.find((item) => item.id === slug)
        if (app) additions.push(makeAppBuilderRun({ id: slug, label: app.label, workspacePath: app.workspacePath }))
      }
      return additions.length ? [...additions, ...current] : current
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOrder, appBuilderRoot, appListing.apps])

  // Moves an App Builder run's workspace folder to match its current
  // category/project/title. Reads the run fresh from runsRef at call time
  // (not from a closure) since this fires after a debounce delay.
  async function moveAppBuilderWorkspace(runId: string) {
    const run = runsRef.current.find((item) => item.id === runId)
    if (!run) return
    const targetAppSlug = run.id.startsWith(APP_BUILDER_RUN_PREFIX)
      ? run.id.slice(APP_BUILDER_RUN_PREFIX.length)
      : await appSlugFromWorkspaceManifest(run.workspacePath)
    const nextWorkspace = appBuilderWorkspacePath(appBuilderRoot, run.category, run.project, run.task, targetAppSlug)
    if (run.workspacePath === nextWorkspace) {
      void ensureWorkspacePath(appBuilderRoot, nextWorkspace).catch(() => {})
      return
    }

    const sourceListing = await listDir(run.workspacePath)
    if (!sourceListing) {
      await ensureWorkspacePath(appBuilderRoot, nextWorkspace)
      sessionByRunRef.current.delete(run.id)
      updateRunContext(run.id, { workspacePath: nextWorkspace, sessionId: null })
      return
    }

    const result = await moveDir(run.workspacePath, nextWorkspace)
    if ('error' in result) {
      if (result.conflict) {
        setAppFolderConflict({
          sourcePath: run.workspacePath,
          targetPath: nextWorkspace,
          error: result.error,
        })
        return
      }
      setError(result.error)
      return
    }
    setAppFolderConflict(null)
    sessionByRunRef.current.delete(run.id)
    updateRunContext(run.id, { workspacePath: result.path, sessionId: null })
  }

  // Debounce the folder move so it settles once after the user stops typing
  // the title/category/project, instead of moving the folder on every
  // keystroke (each keystroke would otherwise create+move a new folder).
  useEffect(() => {
    const timers = workspaceMoveTimersRef.current
    const openBuilderRuns = runs.filter(
      (run) => isAppBuilderRunId(run.id) && panelOrder.includes(appBuilderPanelIdForRun(run.id)),
    )
    const openRunIds = new Set(openBuilderRuns.map((run) => run.id))
    for (const [runId, timer] of timers) {
      if (!openRunIds.has(runId)) {
        clearTimeout(timer)
        timers.delete(runId)
      }
    }
    for (const run of openBuilderRuns) {
      const targetAppSlug = run.id.startsWith(APP_BUILDER_RUN_PREFIX) ? run.id.slice(APP_BUILDER_RUN_PREFIX.length) : null
      const nextWorkspace = appBuilderWorkspacePath(appBuilderRoot, run.category, run.project, run.task, targetAppSlug)
      const runConflict = appFolderConflict?.sourcePath === run.workspacePath ? appFolderConflict : null
      if (runConflict && runConflict.targetPath !== nextWorkspace) setAppFolderConflict(null)
      const existing = timers.get(run.id)
      if (existing) clearTimeout(existing)
      if (run.workspacePath === nextWorkspace) {
        timers.delete(run.id)
        void ensureWorkspacePath(appBuilderRoot, nextWorkspace).catch(() => {})
        continue
      }
      if (runConflict && runConflict.targetPath === nextWorkspace) continue
      timers.set(
        run.id,
        setTimeout(() => {
          timers.delete(run.id)
          void moveAppBuilderWorkspace(run.id).catch((error) =>
            setError(error instanceof Error ? error.message : String(error)),
          )
        }, 1200),
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOrder, runs, appBuilderRoot, appFolderConflict])

  useEffect(() => {
    const timers = workspaceMoveTimersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  function setPanelColumn(panelId: string, column: number) {
    setPanelColumns((current) => ({ ...current, [panelId]: column }))
  }

  function updatePanelState(panelId: string, patch: WorkspacePanelState) {
    setPanelStates((current) => {
      const nextState = { ...(current[panelId] ?? {}), ...patch }
      const normalized: WorkspacePanelState = {}
      if (typeof nextState.collapsed === 'boolean') normalized.collapsed = nextState.collapsed
      if (typeof nextState.fullWindow === 'boolean') normalized.fullWindow = nextState.fullWindow
      if (nextState.builderMode === 'chat' || nextState.builderMode === 'app' || nextState.builderMode === 'split') normalized.builderMode = nextState.builderMode
      if (typeof nextState.contextCollapsed === 'boolean') normalized.contextCollapsed = nextState.contextCollapsed
      if (typeof nextState.builderSplit === 'number' && Number.isFinite(nextState.builderSplit)) normalized.builderSplit = clampBuilderSplit(nextState.builderSplit)
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
      model: '',
      modelProvider: null,
      reasoningEffort: '',
      sessionId: null,
      agentType: 'hermes',
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
    // Hermes can't move a live session's cwd, so reset this conversation's
    // session — the next turn runs in the newly chosen folder.
    sessionByRunRef.current.delete(runId)
    updateRunContext(runId, { workspacePath: path, sessionId: null })
  }

  function updateRunHermesModel(runId: string, model: string, modelProvider: string | null) {
    updateRunContext(runId, { model, modelProvider })
  }

  function updateRunReasoningEffort(runId: string, reasoningEffort: string) {
    updateRunContext(runId, { reasoningEffort })
  }

  function canonicalAppBuilderWorkspace(run: RunNode) {
    const targetSlug = run.id.startsWith(APP_BUILDER_RUN_PREFIX)
      ? run.id.slice(APP_BUILDER_RUN_PREFIX.length)
      : pathSegment(run.task, 'untitled-app')
    const app = appListing.apps.find((item) =>
      item.id === targetSlug || item.label.trim().toLowerCase() === run.task.trim().toLowerCase(),
    )
    return app?.workspacePath ?? appBuilderWorkspacePath(appBuilderRoot, run.category, run.project, run.task, targetSlug)
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

  function deleteConversationTurn(runId: string, turnId: string) {
    const runTurns = turnsRef.current.filter((turn) => turn.runId === runId)
    const childrenByParent = new Map<string, TurnItem[]>()
    for (const turn of runTurns) {
      if (!turn.parentTurnId) continue
      const children = childrenByParent.get(turn.parentTurnId) ?? []
      children.push(turn)
      childrenByParent.set(turn.parentTurnId, children)
    }

    const idsToDelete = new Set<string>()
    const visit = (id: string) => {
      if (idsToDelete.has(id)) return
      idsToDelete.add(id)
      for (const child of childrenByParent.get(id) ?? []) visit(child.id)
    }
    visit(turnId)

    if ([...idsToDelete].some((id) => id === activeTurnRef.current)) return

    queuedPromptsRef.current = queuedPromptsRef.current.filter((entry) => !idsToDelete.has(entry.turnId))
    setTurns((current) => current.filter((turn) => !idsToDelete.has(turn.id)))
    setRuns((current) =>
      current.map((run) => {
        if (run.id !== runId) return run
        const hasRemainingTurns = runTurns.some((turn) => !idsToDelete.has(turn.id))
        return hasRemainingTurns ? run : { ...run, jobStatus: 'queued' }
      }),
    )
    setNewDoneIds((current) => {
      if (!current.has(runId)) return current
      const next = new Set(current)
      next.delete(runId)
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
        const currentText = assistantBufferRef.current
        setTurns((current) =>
          current.map((turn) => (turn.id === turnId ? { ...turn, response: currentText, status: 'running' } : turn)),
        )
        return
      }

      if (event.type === 'message.thought') {
        const delta = String(event.payload?.text ?? '')
        if (!delta) return
        thinkingBufferRef.current += delta
        const turnId = activeTurnRef.current
        if (!turnId) return
        const thinking = thinkingBufferRef.current
        setTurns((current) =>
          current.map((turn) => (turn.id === turnId ? { ...turn, thinking, status: 'running' } : turn)),
        )
        return
      }

      if (event.type === 'message.tool') {
        const turnId = activeTurnRef.current
        const id = String(event.payload?.id ?? '')
        if (!turnId || !id) return
        const patch = event.payload as Record<string, unknown>
        setTurns((current) =>
          current.map((turn) => {
            if (turn.id !== turnId) return turn
            const tools = turn.tools ?? []
            const existing = tools.find((tool) => tool.id === id)
            // tool_call and tool_call_update share this event; an update carries
            // only the fields that changed, so merge rather than replace.
            const merged: ToolActivity = {
              id,
              title: String(patch.title ?? existing?.title ?? id),
              kind: String(patch.kind ?? existing?.kind ?? 'other'),
              status: normalizeToolStatus(patch.status, existing?.status),
              locations: (patch.locations as string[] | undefined) ?? existing?.locations,
              output: String(patch.output ?? '') || existing?.output,
              images: (patch.images as string[] | undefined) ?? existing?.images,
            }
            return {
              ...turn,
              status: 'running',
              tools: existing
                ? tools.map((tool) => (tool.id === id ? merged : tool))
                : [...tools, merged],
            }
          }),
        )
        return
      }

      if (event.type === 'message.plan') {
        const turnId = activeTurnRef.current
        const entries = Array.isArray(event.payload?.entries) ? (event.payload.entries as PlanEntry[]) : []
        if (!turnId) return
        setTurns((current) =>
          current.map((turn) => (turn.id === turnId ? { ...turn, plan: entries, status: 'running' } : turn)),
        )
        return
      }

      if (event.type === 'message.complete') {
        const turnId = activeTurnRef.current
        const currentText = assistantBufferRef.current.trim()
        if (turnId) {
          setTurns((current) =>
            current.map((turn) =>
              turn.id === turnId
                ? { ...turn, response: currentText || turn.response, status: 'done', tools: settleTools(turn, 'completed') }
                : turn,
            ),
          )
        }

        const runId = activeRunRef.current
        if (runId) {
          setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'done' } : item)))
          // Flag a "new result" dot (cleared once the reply scrolls into view).
          setNewDoneIds((current) => {
            const next = new Set(current)
            next.add(runId)
            return next
          })
        }

        activeTurnRef.current = null
        activeRunRef.current = null
        assistantBufferRef.current = ''
        thinkingBufferRef.current = ''
        setActiveHermesTurnId(null)
        setActiveHermesStreamId(null)
        setConnectionState('ready')
        setConnectionDetail('Assistant response complete')
        void flushQueue()
      }

      if (event.type === 'message.cancelled') {
        finishStoppedTurn(String(event.payload?.message ?? 'Task stopped.'))
        return
      }

      if (event.type === 'message.error') {
        const message = String(event.payload?.error ?? 'Hermes stream error')
        const turnId = activeTurnRef.current
        const runId = activeRunRef.current
        const currentText = assistantBufferRef.current.trim()
        if (turnId) {
          setTurns((current) =>
            current.map((turn) =>
              turn.id === turnId
                ? { ...turn, response: currentText || message, status: 'error', tools: settleTools(turn, 'failed') }
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
        thinkingBufferRef.current = ''
        setActiveHermesTurnId(null)
        setActiveHermesStreamId(null)
        void flushQueue()
      }

      // Hermes closes the stream after an application-level error (rate limit,
      // silent provider failure, crash, ...) without ever sending stream_end/done.
      // If tokens already streamed in before it, the turn is effectively done —
      // finish it normally instead of clobbering a good reply with an error and
      // leaving the card stuck on "Hermes running…" forever.
      if (event.type === 'message.apperror') {
        const message = String(event.payload?.error ?? 'Hermes reported an application error')
        const hint = event.payload?.hint ? String(event.payload.hint) : ''
        const turnId = activeTurnRef.current
        const runId = activeRunRef.current
        const currentText = assistantBufferRef.current.trim()
        const hasContent = currentText.length > 0
        if (turnId) {
          setTurns((current) =>
            current.map((turn) =>
              turn.id === turnId
                ? hasContent
                  ? { ...turn, response: currentText, status: 'done', tools: settleTools(turn, 'completed') }
                  : { ...turn, response: [message, hint].filter(Boolean).join('\n\n'), status: 'error', tools: settleTools(turn, 'failed') }
                : turn,
            ),
          )
        }
        if (runId) {
          setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: hasContent ? 'done' : 'error' } : item)))
          if (hasContent) {
            setNewDoneIds((current) => {
              const next = new Set(current)
              next.add(runId)
              return next
            })
          }
        }
        if (!hasContent) setError(message)
        activeTurnRef.current = null
        activeRunRef.current = null
        assistantBufferRef.current = ''
        thinkingBufferRef.current = ''
        setActiveHermesTurnId(null)
        setActiveHermesStreamId(null)
        setConnectionState(hasContent ? 'ready' : 'error')
        setConnectionDetail(hasContent ? 'Assistant response complete' : message)
        void flushQueue()
      }
    })

    void bridge.connect().catch((error) => {
      setError(error instanceof Error ? error.message : String(error))
    })

    return () => {
      removeEvent()
      removeStatus()
      bridge.close()
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
    let cancelled = false
    void fetchHermesModelCatalog()
      .then((catalog) => {
        if (!cancelled) setModelCatalog(catalog)
      })
      .catch(() => {
        if (!cancelled) setModelCatalog(EMPTY_MODEL_CATALOG)
      })
    void fetchHermesReasoningEfforts()
      .then(({ efforts }) => {
        if (!cancelled) setReasoningEfforts(efforts)
      })
      .catch(() => {
        if (!cancelled) setReasoningEfforts(DEFAULT_REASONING_EFFORTS)
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
        sessionByRunRef.current.delete(run.id)
        return { ...run, workspacePath: workspaceRoot, sessionId: null }
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
          // Default agentType for runs persisted before the field existed.
          const restored = (state.runs as RunNode[]).map((run) => ({
            ...run,
            agentType: run.agentType ?? 'hermes',
            column: Number.isFinite(run.column) ? run.column : 0,
            model: typeof run.model === 'string' ? run.model : '',
            modelProvider: typeof run.modelProvider === 'string' ? run.modelProvider : null,
            reasoningEffort: typeof run.reasoningEffort === 'string' ? run.reasoningEffort : '',
            agentCommand: typeof run.agentCommand === 'string' ? run.agentCommand : '',
            cardKind: isAppBuilderRunId(run.id) ? 'app-builder' : run.cardKind ?? 'conversation',
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
          const restoredUnreadRunIds = layoutRunIdSet(layout?.unreadRunIds, restoredRunIds)
          if (restoredUnreadRunIds) {
            setNewDoneIds((current) => (current.size ? current : restoredUnreadRunIds))
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
            const migratedOrder = [...new Set((layout.panelOrder as string[]).map(migrateLegacyAppPanelId))]
            setPanelOrder((current) => (current.length ? current : migratedOrder))
          }
          if (layout.panelColumns && typeof layout.panelColumns === 'object') {
            const migratedColumns = Object.fromEntries(
              Object.entries(layout.panelColumns as Record<string, number>).map(([key, column]) => [migrateLegacyAppPanelId(key), column]),
            )
            setPanelColumns((current) => (Object.keys(current).length ? current : migratedColumns))
          }
          if (Array.isArray(layout.layoutOrder)) {
            const migratedLayout = [...new Set((layout.layoutOrder as string[]).map(migrateLegacyAppPanelId))]
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

  // Debounced auto-save of runs/turns + layout to the local SQLite backend.
  useEffect(() => {
    if (!hydratedRef.current || !passwordStatus?.authenticated) return
    const handle = setTimeout(() => {
      void persistState(runs, turns, sessionId, {
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
  }, [runs, turns, sessionId, panelOrder, panelColumns, layoutOrder, layoutPreset, freeRows, freeCols, sidebarCollapsed, closedRunIds, collapsedIds, metaCollapsedIds, newDoneIds, panelStates, passwordStatus?.authenticated])

  async function flushQueue() {
    if (activeTurnRef.current) return
    const nextEntry = queuedPromptsRef.current.shift()
    if (!nextEntry) return
    await startTurn(nextEntry)
  }

  function recoverActiveHermesStream(entry: QueuedPromptEntry, activeStreamId: string) {
    const bridge = bridgeRef.current
    const ownerTurn = turnsRef.current.find((turn) =>
      turn.runId === entry.runId && turn.id !== entry.turnId && turn.status === 'running')
    // The reconnected stream must be bound to a REAL turn so its deltas/terminal
    // event land somewhere. Prefer a still-running earlier turn (it owns the
    // stream); otherwise adopt the just-submitted turn itself, so the recovered
    // output is shown and its completion flushes the queue — instead of binding a
    // null active turn (which dropped deltas and stranded the card forever).
    const boundTurnId = ownerTurn?.id ?? entry.turnId

    if (ownerTurn) {
      // An earlier turn owns the active stream; the new prompt waits behind it.
      queuedPromptsRef.current.push(entry)
      setTurns((current) =>
        current.map((turn) =>
          turn.id === entry.turnId
            ? { ...turn, status: 'queued', response: 'Queued until the active Hermes stream finishes...' }
            : turn,
        ),
      )
    } else {
      // Desync: server reports an active stream but no local turn is running.
      // Adopt this turn so the recovered stream resolves it rather than deadlocking.
      setTurns((current) =>
        current.map((turn) =>
          turn.id === entry.turnId
            ? { ...turn, status: 'running', response: isThinkingPlaceholder(turn.response) ? 'Thinking…' : turn.response }
            : turn,
        ),
      )
    }

    activeTurnRef.current = boundTurnId
    activeRunRef.current = entry.runId
    assistantBufferRef.current = ownerTurn && !isThinkingPlaceholder(ownerTurn.response) ? ownerTurn.response : ''
    // The server replays a recovered stream from its first frame, so reasoning
    // rebuilds itself from the replayed thought chunks; seeding it here would
    // double the text. Tool events are merged by id, so they replay idempotently.
    thinkingBufferRef.current = ''
    setActiveHermesTurnId(boundTurnId)
    setActiveHermesStreamId(activeStreamId)
    setConnectionState('busy')
    setConnectionDetail('Reconnected to active Hermes stream...')
    setRuns((current) => current.map((item) => (item.id === entry.runId ? { ...item, jobStatus: 'running' } : item)))
    if (bridge?.reconnectStream(activeStreamId)) return

    // Reconnect failed: resolve the bound turn to an error state and flush the
    // queue so the card never sits stuck on a stream we can't reach.
    const message = 'Hermes reported an active stream, but it could not be reconnected.'
    queuedPromptsRef.current = queuedPromptsRef.current.filter((queued) => queued.turnId !== entry.turnId)
    setTurns((current) =>
      current.map((turn) =>
        turn.id === boundTurnId ? { ...turn, status: 'error', response: turn.response || message } : turn,
      ),
    )
    setRuns((current) => current.map((item) => (item.id === entry.runId ? { ...item, jobStatus: 'error' } : item)))
    activeTurnRef.current = null
    activeRunRef.current = null
    assistantBufferRef.current = ''
    setActiveHermesTurnId(null)
    setActiveHermesStreamId(null)
    setError(message)
    setConnectionState('error')
    setConnectionDetail(message)
    void flushQueue()
  }

  /** Pull the model list from hermes again. The hermes CLI can be repointed at
   *  another provider at any time, and nothing tells the running server. */
  async function refreshModelCatalog(workspace: string) {
    setModelsRefreshing(true)
    try {
      setModelCatalog(await fetchHermesModelCatalog(true, workspace))
    } catch (error) {
      setError(`Could not refresh the model list: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setModelsRefreshing(false)
    }
  }

  async function startTurn(entry: QueuedPromptEntry) {
    const bridge = bridgeRef.current
    if (!bridge) return

    const { turnId, runId, prompt, workspace, model, modelProvider, reasoningEffort, promptContext, images } = entry

    activeTurnRef.current = turnId
    activeRunRef.current = runId
    assistantBufferRef.current = ''
    thinkingBufferRef.current = ''
    try {
      // Reuse this conversation's session, or create one rooted at its workspace.
      let session = sessionByRunRef.current.get(runId)
      if (!session) {
        session = await bridge.createSession(workspace)
        sessionByRunRef.current.set(runId, session)
        setRuns((current) => current.map((item) => (item.id === runId ? { ...item, sessionId: session ?? null } : item)))
        // session/new is when hermes re-reports its models, so this is the free
        // moment to notice that the CLI was pointed at a different provider.
        void fetchHermesModelCatalog().then(setModelCatalog).catch(() => {})
      }
      setSessionId(session)
      setSessionInfoText(`Hermes session ${session}`)
      const promptOptions = {
        model,
        modelProvider,
        promptContext,
        appWorkspace: promptContext === 'app-builder' ? workspace : undefined,
        images,
      }
      if (reasoningEffort?.trim()) await bridge.setReasoningEffort(reasoningEffort, promptOptions)
      await bridge.submitPrompt(session, prompt, workspace, promptOptions)
      setActiveHermesTurnId(turnId)
      setActiveHermesStreamId(bridge.activeStreamId)
      setConnectionState('busy')
      setConnectionDetail('Hermes is running…')
      setTurns((current) => current.map((item) => (item.id === turnId ? { ...item, status: 'running', response: 'Thinking…' } : item)))
      setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'running' } : item)))
    } catch (error) {
      if (error instanceof HermesActiveStreamError) {
        recoverActiveHermesStream(entry, error.activeStreamId)
        return
      }

      if (isBusyError(error)) {
        queuedPromptsRef.current.push(entry)
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
      setActiveHermesTurnId(null)
      setActiveHermesStreamId(null)
      setTurns((current) => current.map((item) => (item.id === turnId ? { ...item, status: 'error', response: message } : item)))
      setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'error' } : item)))
    }
  }

  function finishStoppedTurn(message = 'Task stopped.') {
    const turnId = activeTurnRef.current
    const runId = activeRunRef.current
    const response = assistantBufferRef.current.trim() || message
    if (turnId) {
      setTurns((current) =>
        current.map((turn) =>
          turn.id === turnId ? { ...turn, response, status: 'cancelled', tools: settleTools(turn, 'failed') } : turn,
        ),
      )
    }
    if (runId) {
      setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'cancelled' } : item)))
    }
    activeTurnRef.current = null
    activeRunRef.current = null
    assistantBufferRef.current = ''
    thinkingBufferRef.current = ''
    setActiveHermesTurnId(null)
    setActiveHermesStreamId(null)
    setConnectionState('ready')
    setConnectionDetail('Hermes stopped')
    void flushQueue()
  }

  async function stopHermesTurn(turnId: string) {
    if (turnId !== activeTurnRef.current) return
    const bridge = bridgeRef.current
    if (!bridge) return
    setError(null)
    setConnectionDetail('Stopping Hermes…')
    try {
      const cancelled = await bridge.cancelActiveStream()
      if (!cancelled && activeTurnRef.current === turnId) finishStoppedTurn('Hermes stream is no longer active.')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setError(message)
      setConnectionState('error')
      setConnectionDetail(message)
    }
  }

  function refreshHermesTurn(turnId: string) {
    const bridge = bridgeRef.current
    if (!bridge || turnId !== activeHermesTurnId || !activeHermesStreamId) return
    setError(null)
    setConnectionDetail('Reconnecting to Hermes stream...')
    const reconnected = bridge.reconnectStream(activeHermesStreamId)
    if (!reconnected) {
      const message = 'Hermes stream is no longer available.'
      setError(message)
      setConnectionState('error')
      setConnectionDetail(message)
      setTurns((current) => current.map((item) => (item.id === turnId ? { ...item, status: 'error', response: item.response || message } : item)))
      setRuns((current) => current.map((item) => (item.id === activeRunRef.current ? { ...item, jobStatus: 'error' } : item)))
      activeTurnRef.current = null
      activeRunRef.current = null
      setActiveHermesTurnId(null)
      setActiveHermesStreamId(null)
      assistantBufferRef.current = ''
      return
    }
    setConnectionState('busy')
  }

  // Queue a turn if Hermes is busy, otherwise start it immediately.
  function enqueueOrStart(entry: QueuedPromptEntry) {
    const busy = connectionState === 'busy' || activeTurnRef.current !== null
    if (busy) {
      queuedPromptsRef.current.push(entry)
      setTurns((current) => current.map((item) => (item.id === entry.turnId ? { ...item, status: 'queued', response: 'Queued until Hermes is ready…' } : item)))
      setRuns((current) => current.map((item) => (item.id === entry.runId ? { ...item, jobStatus: 'queued' } : item)))
      return
    }
    void startTurn(entry)
  }

  function newTurn(
    runId: string,
    prompt: string,
    parentTurnId: string | null = null,
    images: PromptImage[] = [],
  ): { turn: TurnItem; turnId: string } {
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
        images: images.length ? images : undefined,
      },
    }
  }

  // Send a message inside a conversation card. The first turn derives the
  // card's metadata from the prompt (honoring any context the user set).
  function sendInConversation(
    runId: string,
    prompt: string,
    parentTurnId: string | null = null,
    images: PromptImage[] = [],
  ) {
    if (!bridgeRef.current) {
      setError('Hermes bridge is not ready yet.')
      return null
    }
    const run = runs.find((item) => item.id === runId)
    if (!run) return null

    setActiveRunId(runId)
    const model = (run.model ?? '').trim()
    const modelProvider = (run.modelProvider ?? '').trim() || null
    const reasoningEffort = (run.reasoningEffort ?? '').trim()
    const hasTurns = turns.some((turn) => turn.runId === runId)
    let workspace = run.cardKind === 'app-builder' ? canonicalAppBuilderWorkspace(run) : run.workspacePath
    const appBuilderWorkspaceChanged = run.cardKind === 'app-builder' && workspace !== run.workspacePath
    if (appBuilderWorkspaceChanged) sessionByRunRef.current.delete(run.id)
    if (!hasTurns && run.cardKind !== 'app-builder') {
      const fields = deriveRunFields(prompt, {
        category: run.category,
        project: run.project,
        workspace: run.workspacePath,
      }, workspaceRoot)
      workspace = fields.workspacePath
      setRuns((current) =>
        current.map((item) =>
          item.id === runId ? { ...item, ...fields, task: item.task.trim() || fields.project, jobStatus: 'running' } : item,
        ),
      )
    } else {
      setRuns((current) => current.map((item) => (
        item.id === runId
          ? {
            ...item,
            workspacePath: appBuilderWorkspaceChanged ? workspace : item.workspacePath,
            sessionId: appBuilderWorkspaceChanged ? null : item.sessionId,
            jobStatus: 'running',
          }
          : item
      )))
    }

    const { turn, turnId } = newTurn(runId, prompt, parentTurnId, images)
    setTurns((current) => [turn, ...current])
    setError(null)
    enqueueOrStart({
      turnId,
      runId,
      prompt,
      workspace,
      model,
      modelProvider,
      reasoningEffort,
      images,
      promptContext: run.cardKind === 'app-builder' ? 'app-builder' : 'agent-rider',
    })
    return turnId
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
      onMarkRead={markConversationRead}
      dragging={draggingKey === run.id}
      dragActive={draggingKey !== null && draggingKey !== run.id}
      onDragStartCard={() => setDraggingKey(run.id)}
      onDragEndCard={() => setDraggingKey(null)}
      onDropOnCard={(after) => handleDropOnBlock(run.id, after)}
      onToggle={() => toggleCollapse(run.id)}
      onMetaCollapsedChange={(collapsed) => setMetaCollapsed(run.id, collapsed)}
      onSend={(text, parentTurnId, images) => sendInConversation(run.id, text, parentTurnId ?? null, images)}
      onTitleChange={(value) => updateRunContext(run.id, { task: value })}
      onCategoryChange={(value) => updateRunContext(run.id, { category: value, categoryTags: tagsForCategory(value) })}
      onProjectChange={(value) => updateRunProject(run.id, value)}
      onAgentChange={(value) => updateRunContext(run.id, { agentType: value })}
      onAgentCommandChange={(value) => updateRunContext(run.id, { agentCommand: value })}
      modelCatalog={modelCatalog}
      modelsRefreshing={modelsRefreshing}
      onRefreshModels={() => void refreshModelCatalog(run.workspacePath)}
      reasoningEfforts={reasoningEfforts}
      onModelChange={(model, modelProvider) => updateRunHermesModel(run.id, model, modelProvider)}
      onReasoningEffortChange={(reasoningEffort) => updateRunReasoningEffort(run.id, reasoningEffort)}
      onOpenPicker={() => setPickerRunId(run.id)}
      onClose={() => closeConversation(run.id)}
      onDeleteTurn={(turnId) => deleteConversationTurn(run.id, turnId)}
      stoppableTurnId={activeHermesStreamId ? activeHermesTurnId : null}
      refreshableTurnId={activeHermesStreamId ? activeHermesTurnId : null}
      onStopTurn={(turnId) => void stopHermesTurn(turnId)}
      onRefreshTurn={refreshHermesTurn}
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

  const renderAppBuilderChat = (run: RunNode, panelId: string) => {
    return (
      <ConversationCard
        key={run.id}
        run={run}
        turns={turnsByRun.get(run.id) ?? []}
        collapsed={false}
        metaCollapsed={metaCollapsedIds.has(run.id)}
        active={activeRunId === run.id}
        embedded
        hideHeader
        hideContext
        isNewDone={newDoneIds.has(run.id)}
        onMarkRead={markConversationRead}
        dragging={false}
        dragActive={false}
        onDragStartCard={() => {}}
        onDragEndCard={() => {}}
        onDropOnCard={() => {}}
        onToggle={() => {}}
        onMetaCollapsedChange={(collapsed) => setMetaCollapsed(run.id, collapsed)}
        onSend={(text, parentTurnId, images) => sendInConversation(run.id, text, parentTurnId ?? null, images)}
        onTitleChange={(value) => updateRunContext(run.id, { task: value })}
        onCategoryChange={(value) => updateRunContext(run.id, { category: value, categoryTags: tagsForCategory(value) })}
        onProjectChange={(value) => updateRunProject(run.id, value)}
        onAgentChange={(value) => updateRunContext(run.id, { agentType: value })}
        onAgentCommandChange={(value) => updateRunContext(run.id, { agentCommand: value })}
        modelCatalog={modelCatalog}
        modelsRefreshing={modelsRefreshing}
        onRefreshModels={() => void refreshModelCatalog(run.workspacePath)}
        reasoningEfforts={reasoningEfforts}
        onModelChange={(model, modelProvider) => updateRunHermesModel(run.id, model, modelProvider)}
        onReasoningEffortChange={(reasoningEffort) => updateRunReasoningEffort(run.id, reasoningEffort)}
        onOpenPicker={() => setPickerRunId(run.id)}
        onClose={() => closePanel(panelId)}
        onDeleteTurn={(turnId) => deleteConversationTurn(run.id, turnId)}
        stoppableTurnId={activeHermesStreamId ? activeHermesTurnId : null}
        refreshableTurnId={activeHermesStreamId ? activeHermesTurnId : null}
        onStopTurn={(turnId) => void stopHermesTurn(turnId)}
        onRefreshTurn={refreshHermesTurn}
        agentTerminalState={panelStates[agentTerminalStateKey(run.id)]}
        onAgentTerminalStateChange={(patch) => updatePanelState(agentTerminalStateKey(run.id), patch)}
      />
    )
  }

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
          maximized={panelMaximized}
          onToggleMaximize={togglePanelMaximize}
        />
      )
    } else if (isAppBuilderPanelId(panelId)) {
      const runId = appBuilderRunIdForPanel(panelId)
      const targetAppSlug = appSlugForBuilderPanel(panelId)
      const run = runs.find((item) => item.id === runId) ?? (targetAppSlug ? null : makeAppBuilderRun())
      if (run) {
        content = (
          <AppBuilderPanel
            run={run}
            apps={appListing.apps}
            appWarnings={appListing.warnings}
            targetAppId={targetAppSlug ?? undefined}
            chatContent={renderAppBuilderChat(run, panelId)}
            onTitleChange={(value) => updateRunContext(runId, { task: value })}
            onCategoryChange={(value) => updateRunContext(runId, { category: value, categoryTags: tagsForCategory(value) })}
            onProjectChange={(value) => updateRunProject(runId, value)}
            onAgentChange={(value) => updateRunContext(runId, { agentType: value })}
            onAgentCommandChange={(value) => updateRunContext(runId, { agentCommand: value })}
            onClose={() => closePanel(panelId)}
            collapsed={panelStates[panelId]?.collapsed}
            fullWindow={panelStates[panelId]?.fullWindow}
            mode={panelStates[panelId]?.builderMode ?? (targetAppSlug ? 'app' : 'chat')}
            onModeChange={(nextMode) => updatePanelState(panelId, { builderMode: nextMode })}
            contextCollapsed={panelStates[panelId]?.contextCollapsed ?? Boolean(targetAppSlug)}
            onContextCollapsedChange={(nextCollapsed) => updatePanelState(panelId, { contextCollapsed: nextCollapsed })}
            splitRatio={panelStates[panelId]?.builderSplit}
            onStateChange={(patch) => updatePanelState(panelId, patch)}
            maximized={panelMaximized}
            onToggleMaximize={togglePanelMaximize}
          />
        )
      }
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

      {appFolderConflict && !appFolderConflict.acknowledged ? (
        <div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="App folder conflict">
          <div className="confirm-dialog card app-folder-conflict-dialog">
            <div className="picker-head">
              <div>
                <div className="eyebrow">App folder conflict</div>
                <h3>Target folder already exists</h3>
              </div>
            </div>
            <p className="confirm-copy">
              App Builder cannot rename the current folder because the new auto-named folder already exists. Change the App title, Category, or Project, or manually move/delete the target folder, then retry.
            </p>
            <div className="folder-conflict-paths">
              <label>
                <span>Current folder</span>
                <code>{appFolderConflict.sourcePath}</code>
              </label>
              <label>
                <span>Target folder</span>
                <code>{appFolderConflict.targetPath}</code>
              </label>
            </div>
            <div className="picker-actions confirm-actions">
              <button
                type="button"
                className="picker-cancel"
                onClick={() => setAppFolderConflict((current) => current ? { ...current, acknowledged: true } : current)}
              >
                I will resolve it
              </button>
              <button
                type="button"
                className="send-button"
                onClick={() => setAppFolderConflict(null)}
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
                  appBuilderOpen={appBuilderOpen}
                  appBuilderTitle={runs.find((run) => run.id === APP_BUILDER_RUN_ID)?.task.trim() || 'App Builder'}
                  onLaunchAppBuilder={launchAppBuilder}
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
