import { type ChangeEvent, type ClipboardEvent, type ComponentProps, type CSSProperties, type Dispatch, type DragEvent, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeKatex from 'rehype-katex'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTermTerminal, type ILink } from '@xterm/xterm'
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
import 'katex/dist/katex.min.css'
import {
  loadWorkspaceBootstrap,
  loadUsageState,
  loadUsageCredentialSettings,
  loadVersionInfo,
  acknowledgeWorkspaceUpgrade,
  loadAgentCommandAvailability,
  loadBrowserBookmarks,
  persistAgentCommandsSetting,
  persistBrowserBookmarks,
  persistUsageCredentialSettings,
  persistState,
  refreshUsageState,
  listDir,
  readFilePreview,
  writeFileContent,
  searchFiles,
  makeDir,
  moveFsEntry,
  duplicateFsEntry,
  fileDownloadUrl,
  deleteFile,
  uploadFile,
  listApps,
  createAgentApp as createAgentAppWorkspace,
  deleteAgentApp,
  duplicateAgentApp,
  setAppOrder,
  renameApp,
  allocateAgentAppPort,
  agentAppPortReady,
  loadPasswordStatus,
  loginPagePassword,
  setPagePassword,
  logoutPagePassword,
  loadTodos,
  createTodo,
  updateTodo,
  deleteTodo,
  setTodoOrder,
  type FsListing,
  type FsEntry,
  type FsFileEntry,
  type FsFilePreview,
  type FsSearchResultEntry,
  type AgentApp,
  type AppListing,
  type AppWarning,
  type WorkspacePanelState,
  type WorkspaceLayout,
  type PasswordStatus,
  type LayoutPreset,
  type DesktopId,
  type DesktopLayoutSettings,
  type PaneSizeState,
  type AgentCommand,
  type AgentCommandAvailability,
  type ProviderUsage,
  type RateLimitWindow,
  type TodoItem,
  type UsageState,
  type UsageCredentialSettings,
  type VersionInfo,
} from './store'
import { StateSaveQueue } from './stateSaveQueue'
import {
  FILE_CHANGE_POLL_INTERVAL_MS,
  fileListingsMatch,
  filePreviewsMatch,
  fileSearchResultsMatch,
  mergeOpenedFilePreview,
  mergeRefreshedFilePreview,
  previewLineCountLabel,
  type FilePreviewWindow,
} from './filePreview'
import { todoMatchesCompletionFilter, type TodoCompletionFilter } from './todoFilter'
import { normalizeCsvRows, parseCsv, serializeCsv, type CsvDocument } from './csv'
import { nextTwoUpColumn, type TwoUpColumn } from './workspaceLayout'
import {
  isMobileViewport,
  nextRailSheet,
  viewportLayoutPreset,
  type RailPanel,
} from './mobileView'
import {
  detectTerminalFileLinks,
  type TerminalLinkRow,
} from './terminalFileLinks'
import {
  AGENT_APP_DEFAULT_SPLIT,
  AGENT_APP_MAX_SPLIT,
  AGENT_APP_MIN_SPLIT,
  agentAppIconHue,
  agentAppIconUrl,
  agentAppLaunchPrompt,
  agentAppOrientation,
  agentAppProxyUrl,
  clampAgentAppSplit,
  legacyEmbedPort,
  nextAgentAppFrameRevision,
  remapAgentAppPanelCommands,
  registeredAgentAppPanelId,
  type AgentAppOrientation,
} from './agentApp'
import { sendAgentCollaborationPrompt } from './agentCollaboration'
import { browserControlPrompt } from './browserPrompt'
import { APP_BUILD_CHECK_INTERVAL_MS, applicationUpgradeReloadUrl } from './appBuild'
import { usageProviderVisible } from './usageVisibility'
import {
  resolveBrowserMode,
  type BrowserModePreference,
  type BrowserResolvedMode,
  type ExternalSiteRule,
} from './browserMode'
import {
  commitBrowserAddress,
  editBrowserAddress,
  initialBrowserAddressState,
  observeBrowserAddress,
  type BrowserAddressState,
} from './browserAddress'
import { browserPasteAvailable, prepareBrowserPaste } from './browserPaste'
import { findBrowserSessionSnapshot } from './browserSession'
import {
  browserBookmarkForUrl,
  browserBookmarkMatches,
  browserBookmarkTitle,
  normalizeBrowserBookmarkUrl,
  upsertBrowserBookmark,
  type BrowserBookmark,
} from './browserBookmarks'
import {
  browserReloadAvailable,
  externalBrowserControlReady,
  externalBrowserDisplayCoordinator,
} from './externalBrowserDisplay'
import { SelkiesClient } from './selkies/client'
import { plugins, type AgentRiderPlugin } from '../plugins'
import { WebView } from '../plugins/WebView'

type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'
type TerminalConnectionState = 'connecting' | 'connected' | 'closed' | 'error'
type ResourceHealth = 'Ready' | 'Needs setup' | 'Draft'

type ChatRole = 'user' | 'assistant'

// Conversation cards run an interactive TUI CLI in an embedded terminal.
type AgentType = 'claude' | 'codex' | 'agy' | 'devin' | 'custom'
type TuiAgentType = AgentType
type RunCardKind = 'conversation' | 'app-builder'

const LEGACY_AGENT_LABELS: Record<AgentType, string> = {
  claude: 'Claude (CLI)',
  codex: 'Codex (CLI)',
  agy: 'Agy (CLI)',
  devin: 'Devin (CLI)',
  custom: 'Custom command',
}

const DEFAULT_AGENT_COMMANDS: AgentCommand[] = [
  { id: 'default-claude', name: LEGACY_AGENT_LABELS.claude, command: 'claude --permission-mode auto' },
  { id: 'default-codex', name: LEGACY_AGENT_LABELS.codex, command: 'codex --yolo' },
  { id: 'default-agy', name: LEGACY_AGENT_LABELS.agy, command: 'agy --dangerously-skip-permissions' },
  { id: 'default-devin', name: LEGACY_AGENT_LABELS.devin, command: 'devin --permission-mode auto' },
]

function defaultAgentCommands() {
  return DEFAULT_AGENT_COMMANDS.map((item) => ({ ...item }))
}

function isTuiAgent(agent: AgentType): agent is TuiAgentType {
  return agent === 'claude' || agent === 'codex' || agent === 'agy' || agent === 'devin' || agent === 'custom'
}

function agentLabel(agent: AgentType) {
  return LEGACY_AGENT_LABELS[agent] ?? agent
}

const USAGE_POLL_INTERVAL_MS = 3 * 60 * 1000
const USAGE_PROVIDER_LABEL: Record<ProviderUsage['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
  grok: 'Grok',
  gemini: 'Gemini',
  antigravity: 'Agy',
  'opencode-go': 'OpenCode Go',
  minimax: 'MiniMax',
}

function usagePercent(value: number) {
  return `${Math.round(value)}%`
}

function usageWindowLabel(windowMinutes: number, compact: boolean) {
  if (windowMinutes === 10_080) return compact ? 'wk' : 'Weekly'
  if (windowMinutes === 300) return compact ? '5h' : '5 hours'
  if (windowMinutes === 60) return compact ? '1h' : '1 hour'
  if (windowMinutes < 60) return `${windowMinutes}m`
  if (windowMinutes % (60 * 24 * 7) === 0) {
    const weeks = windowMinutes / (60 * 24 * 7)
    return compact ? `${weeks}wk` : `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`
  }
  if (windowMinutes % (60 * 24) === 0) {
    const days = windowMinutes / (60 * 24)
    return compact ? `${days}d` : `${days} ${days === 1 ? 'day' : 'days'}`
  }
  if (windowMinutes % 60 === 0) {
    const hours = windowMinutes / 60
    return compact ? `${hours}h` : `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  }
  return `${windowMinutes}m`
}

function usageWindowReset(window: RateLimitWindow) {
  if (window.resetsAt != null) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(window.resetsAt))
  }
  return window.resetDescription ?? 'Reset time unavailable'
}

function usageProviderSummary(provider: ProviderUsage) {
  const values = [provider.session, provider.weekly, provider.monthly].flatMap((window) => (
    window
      ? [`${usageWindowLabel(window.windowMinutes, true)} ${usagePercent(window.usedPercent)}`]
      : []
  ))
  if (!values.length && provider.buckets.length) {
    const mostConstrained = provider.buckets.reduce((highest, bucket) => (
      bucket.usedPercent > highest.usedPercent ? bucket : highest
    ))
    values.push(`${mostConstrained.name} ${usagePercent(mostConstrained.usedPercent)}`)
  }
  if (values.length) return values.join(' / ')
  if (provider.status === 'idle') return 'checking…'
  if (provider.status === 'unavailable') return 'sign in'
  return 'error'
}

function UsageWindowRow({ label, window }: { label?: string; window: RateLimitWindow }) {
  return (
    <div className="usage-window-row">
      <span>{label ?? usageWindowLabel(window.windowMinutes, false)}</span>
      <strong>{usagePercent(window.usedPercent)} used</strong>
      <small>Resets {usageWindowReset(window)}</small>
    </div>
  )
}

function UsageProviderToolbarButton({ provider }: { provider: ProviderUsage }) {
  const [open, setOpen] = useState(false)
  const label = USAGE_PROVIDER_LABEL[provider.provider]
  const stateLabel = provider.stale ? 'stale' : provider.status === 'error' ? 'error' : null
  const detailId = `usage-detail-${provider.provider}`
  const windows = [provider.session, provider.weekly, provider.monthly].filter(
    (window): window is RateLimitWindow => window !== null,
  )
  return (
    <div className="usage-provider-shell">
      <button
        type="button"
        className={`usage-provider-button ${provider.status} ${provider.stale ? 'stale' : ''}`}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        <strong>{usageProviderSummary(provider)}</strong>
        {stateLabel ? <em>{stateLabel}</em> : null}
      </button>
      {open ? (
        <div id={detailId} className="usage-detail-popover" role="status">
          <div className="usage-detail-head">
            <strong>{label} usage</strong>
            <button type="button" aria-label={`Close ${label} usage details`} onClick={() => setOpen(false)}>×</button>
          </div>
          {windows.map((window, index) => (
            <UsageWindowRow key={`${window.windowMinutes}-${index}`} window={window} />
          ))}
          {provider.buckets.map((bucket, index) => (
            <UsageWindowRow key={`${bucket.name}-${index}`} label={bucket.name} window={bucket} />
          ))}
          {!windows.length && !provider.buckets.length ? <p className="usage-stale-copy">No quota windows reported.</p> : null}
          {provider.stale ? <p className="usage-stale-copy">Showing cached data from a previous successful refresh.</p> : null}
          {provider.error ? <p className="usage-error-copy">{provider.error}</p> : null}
          {provider.updatedAt ? <footer>Updated {new Date(provider.updatedAt).toLocaleTimeString()}</footer> : null}
        </div>
      ) : null}
    </div>
  )
}

const LOCAL_TERMINAL_PANEL_ID = 'terminal'
const LOCAL_TERMINAL_PANEL_ID_PREFIX = 'terminal-'
const BROWSER_PANEL_ID_PREFIX = 'browser-'
const EMBED_PANEL_ID_PREFIX = 'embed-'
function isLocalTerminalPanelId(panelId: string) {
  return panelId === LOCAL_TERMINAL_PANEL_ID || panelId.startsWith(LOCAL_TERMINAL_PANEL_ID_PREFIX)
}
function localTerminalSessionId(panelId: string) {
  return panelId === LOCAL_TERMINAL_PANEL_ID ? 'local-terminal' : panelId
}
function isBrowserPanelId(panelId: string) {
  return panelId.startsWith(BROWSER_PANEL_ID_PREFIX)
}
function isEmbedPanelId(panelId: string) {
  return panelId.startsWith(EMBED_PANEL_ID_PREFIX)
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

function forceTerminalSelectionModifier(event: MouseEvent) {
  const applePointerPlatform = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)
  const modifier = applePointerPlatform ? 'altKey' : 'shiftKey'
  if (event[modifier]) return

  // xterm intentionally requires Shift (or Option on Apple platforms) to
  // select while a TUI has mouse reporting enabled. Copy mode supplies that
  // modifier to xterm's own selection handler so every agent behaves alike.
  Object.defineProperty(event, modifier, { configurable: true, value: true })
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
  code({ node: _node, className, children, ...props }) {
    const source = String(children ?? '').replace(/\n$/, '')
    const language = /(?:^|\s)language-([\w-]+)/.exec(className ?? '')?.[1]
    if (!language && !source.includes('\n')) {
      return <code {...props} className={className}>{children}</code>
    }
    const highlighted = language && hljs.getLanguage(language)
      ? { value: hljs.highlight(source, { language, ignoreIllegals: true }).value, language }
      : hljs.highlightAuto(source)
    return (
      <code
        {...props}
        className={`hljs${highlighted.language ? ` language-${highlighted.language}` : ''}`}
        dangerouslySetInnerHTML={{ __html: highlighted.value }}
      />
    )
  },
}

const richMarkdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', 'language-math', 'math-inline'],
    ],
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ['className', 'math', 'math-display'],
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ['className', 'math', 'math-inline'],
    ],
  },
}

const richMarkdownPlugins: {
  remark: NonNullable<ComponentProps<typeof ReactMarkdown>['remarkPlugins']>
  rehype: NonNullable<ComponentProps<typeof ReactMarkdown>['rehypePlugins']>
} = {
  remark: [remarkGfm, remarkMath],
  // Sanitize terminal/file-derived HTML before KaTeX expands the explicitly
  // allowed math nodes into its deterministic, script-free output.
  rehype: [
    rehypeRaw,
    [rehypeSanitize, richMarkdownSanitizeSchema],
    [rehypeKatex, { throwOnError: false, strict: 'warn', trust: false, macros: {} }],
  ],
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
// Park the Resource rail entry without removing its current implementation.
const SHOW_RESOURCE_BUTTON = false
const AGENT_TERMINAL_STATE_PREFIX = 'agent-terminal:'
const TUI_WHEEL_PAGE_DELTA = 80
/** Finger travel (px) that separates a tap or long press from a scroll gesture. */
const TOUCH_SCROLL_SLOP = 8
/** Row height assumed while the terminal has not been measured yet. */
const TOUCH_SCROLL_FALLBACK_LINE = 17
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

function connectionStatusTone(state: TerminalConnectionState) {
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

function isLegacyBrowserRunId(runId: string) {
  return runId === 'run-browser' || runId.startsWith('run-browser-')
}

function legacyBrowserPanelId(runId: string) {
  return runId.replace(/^run-browser/, 'browser')
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

function migrateWorkspaceKey(key: string): string | null {
  return isLegacyBrowserRunId(key) ? legacyBrowserPanelId(key) : migrateAppPanelId(key)
}

const DESKTOP_IDS: DesktopId[] = [1, 2, 3, 4, 5, 6]
const VALID_LAYOUT_PRESETS: LayoutPreset[] = ['single', 'two-up', 'quad', 'three-col', 'master-stack', 'free']
const DEFAULT_DESKTOP_LAYOUT: DesktopLayoutSettings = { layoutPreset: 'single', freeRows: 2, freeCols: 3 }

function isDesktopId(value: unknown): value is DesktopId {
  return typeof value === 'number' && DESKTOP_IDS.includes(value as DesktopId)
}

function isLayoutPreset(value: unknown): value is LayoutPreset {
  return typeof value === 'string' && VALID_LAYOUT_PRESETS.includes(value as LayoutPreset)
}

function makeDesktopLayouts(layout: DesktopLayoutSettings = DEFAULT_DESKTOP_LAYOUT): Record<DesktopId, DesktopLayoutSettings> {
  return Object.fromEntries(DESKTOP_IDS.map((desktop) => [desktop, { ...layout }])) as Record<DesktopId, DesktopLayoutSettings>
}

function normalizeDesktopLayouts(
  value: unknown,
  legacyLayout: DesktopLayoutSettings,
): Record<DesktopId, DesktopLayoutSettings> {
  const layouts = makeDesktopLayouts(legacyLayout)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return layouts
  for (const desktop of DESKTOP_IDS) {
    const candidate = (value as Record<string, unknown>)[String(desktop)]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const settings = candidate as Record<string, unknown>
    layouts[desktop] = {
      layoutPreset: isLayoutPreset(settings.layoutPreset) ? settings.layoutPreset : legacyLayout.layoutPreset,
      freeRows: typeof settings.freeRows === 'number' && settings.freeRows > 0 ? settings.freeRows : legacyLayout.freeRows,
      freeCols: typeof settings.freeCols === 'number' && settings.freeCols > 0 ? settings.freeCols : legacyLayout.freeCols,
      paneSizes: normalizePresetPaneSizes(settings.paneSizes),
    }
  }
  return layouts
}

function normalizePaneSizeList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const sizes = value
    .slice(0, 24)
    .map(Number)
    .filter((size) => Number.isFinite(size) && size > 0)
  return sizes.length ? sizes : undefined
}

function normalizePaneSizeState(value: unknown): PaneSizeState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  const columns = normalizePaneSizeList(candidate.columns)
  const rows = normalizePaneSizeList(candidate.rows)
  const columnRows = candidate.columnRows && typeof candidate.columnRows === 'object' && !Array.isArray(candidate.columnRows)
    ? Object.fromEntries(
        Object.entries(candidate.columnRows as Record<string, unknown>)
          .flatMap(([column, sizes]) => {
            const normalized = normalizePaneSizeList(sizes)
            return normalized ? [[column, normalized]] : []
          }),
      )
    : undefined
  if (!columns && !rows && !columnRows) return undefined
  return { columns, rows, columnRows }
}

function normalizePresetPaneSizes(value: unknown): DesktopLayoutSettings['paneSizes'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const paneSizes: DesktopLayoutSettings['paneSizes'] = {}
  for (const preset of VALID_LAYOUT_PRESETS) {
    const normalized = normalizePaneSizeState((value as Record<string, unknown>)[preset])
    if (normalized) paneSizes[preset] = normalized
  }
  return Object.keys(paneSizes).length ? paneSizes : undefined
}

function normalizeDesktopAssignments(value: unknown): Record<string, DesktopId> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const assignments: Record<string, DesktopId> = {}
  for (const [key, desktop] of Object.entries(value as Record<string, unknown>)) {
    if (!isDesktopId(desktop) || RETIRED_PLUGIN_PANEL_IDS.has(key)) continue
    const migratedKey = migrateWorkspaceKey(key)
    if (migratedKey) assignments[migratedKey] = desktop
  }
  return assignments
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

function normalizeAgentCommands(value: unknown): AgentCommand[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const commandValues = new Set<string>()
  const commands: AgentCommand[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const source = raw as Record<string, unknown>
    const name = typeof source.name === 'string' ? source.name.trim() : ''
    const command = typeof source.command === 'string' ? source.command.trim() : ''
    if (!name || !command || command.length > 2000 || commandValues.has(command)) continue
    let id = typeof source.id === 'string' ? source.id.trim() : ''
    if (!id || ids.has(id)) id = makeId('agent-command')
    ids.add(id)
    commandValues.add(command)
    commands.push({ id, name, command })
  }
  return commands
}

function agentTerminalStateKey(runId: string) {
  return `${AGENT_TERMINAL_STATE_PREFIX}${runId}`
}

function normalizeWorkspacePanelState(raw: unknown, panelId: string): WorkspacePanelState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const state: WorkspacePanelState = {}
  if (typeof source.collapsed === 'boolean') state.collapsed = source.collapsed
  if (typeof source.fullWindow === 'boolean') state.fullWindow = source.fullWindow
  if (source.browserMode === 'auto' || source.browserMode === 'embedded' || source.browserMode === 'external') {
    state.browserMode = source.browserMode
  }
  if (typeof source.browserAddress === 'string' && source.browserAddress.length <= 16_384) {
    state.browserAddress = source.browserAddress
  }
  if (typeof source.browserUrl === 'string' && source.browserUrl.length <= 16_384) {
    state.browserUrl = source.browserUrl
  }
  if (typeof source.appName === 'string') state.appName = source.appName.slice(0, 120)
  if (typeof source.appId === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(source.appId)) {
    state.appId = source.appId
  }
  if (typeof source.appIcon === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(source.appIcon)) {
    state.appIcon = source.appIcon.slice(0, 40)
  }
  if (typeof source.appLocation === 'string' && source.appLocation.length <= 4096) {
    state.appLocation = source.appLocation
  }
  const appPort = typeof source.appPort === 'number'
    && Number.isInteger(source.appPort)
    && source.appPort >= 1024
    && source.appPort <= 65535
    ? source.appPort
    : isEmbedPanelId(panelId)
      ? legacyEmbedPort(source.url)
      : undefined
  if (appPort !== undefined) state.appPort = appPort
  if (typeof source.appSplit === 'number' && Number.isFinite(source.appSplit)) {
    state.appSplit = clampAgentAppSplit(source.appSplit)
  }
  if (typeof source.appChatCollapsed === 'boolean') state.appChatCollapsed = source.appChatCollapsed
  if (typeof source.agentCommand === 'string' && source.agentCommand.length <= 2000) {
    state.agentCommand = source.agentCommand
  }
  if (typeof source.notepad === 'string') state.notepad = source.notepad
  if (typeof source.richViewOpen === 'boolean') state.richViewOpen = source.richViewOpen
  return state
}

function normalizePanelStates(value: unknown): Record<string, WorkspacePanelState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const states: Record<string, WorkspacePanelState> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (RETIRED_PLUGIN_PANEL_IDS.has(key)) continue
    const migratedKey = migrateWorkspaceKey(key)
    if (!migratedKey) continue
    const state = normalizeWorkspacePanelState(raw, migratedKey)
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
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)
  if (!copied) throw new Error('Clipboard copy was rejected')
}

async function readClipboardText() {
  // No DOM fallback exists for reading: execCommand('paste') is not implemented
  // by browsers, and readText is absent outside a secure context. Callers must
  // report the failure and leave the in-page Ctrl+V path available.
  if (!navigator.clipboard?.readText) throw new Error('Clipboard read is unavailable')
  return navigator.clipboard.readText()
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

function WinPromptIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8.4 1.8l.7 2.3a3.7 3.7 0 002.4 2.4l2.3.7-2.3.7a3.7 3.7 0 00-2.4 2.4l-.7 2.3-.7-2.3a3.7 3.7 0 00-2.4-2.4L3 7.2l2.3-.7a3.7 3.7 0 002.4-2.4l.7-2.3z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M3 11.3l.35 1.05c.2.6.67 1.07 1.27 1.27l1.05.35-1.05.35c-.6.2-1.07.67-1.27 1.27L3 16l-.35-1.05a2.02 2.02 0 00-1.27-1.27L.33 13.33l1.05-.35c.6-.2 1.07-.67 1.27-1.27L3 10.66v.64z" fill="currentColor" transform="translate(0 -1)" />
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

function formatFileDate(modifiedAt: number | null): string {
  if (modifiedAt == null) return '—'
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(modifiedAt))
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

function inputTextFromDrag(event: DragEvent<HTMLElement>) {
  return event.dataTransfer.getData(INPUT_TEXT_DRAG)
    || event.dataTransfer.getData(TODO_DRAG_TEXT)
    || event.dataTransfer.getData('application/x-agent-rider-file-path')
}

function allowInputTextDrop(event: DragEvent<HTMLElement>) {
  const types = event.dataTransfer.types
  if (!types.includes(INPUT_TEXT_DRAG)
    && !types.includes(TODO_DRAG_TEXT)
    && !types.includes('application/x-agent-rider-file-path')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}

function setInputTextDragData(event: DragEvent<HTMLElement>, text: string) {
  event.stopPropagation()
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData(INPUT_TEXT_DRAG, text)
  event.dataTransfer.setData('text/plain', text)
}

function setFilePathDragData(event: DragEvent<HTMLElement>, filePath: string, entryType?: 'file' | 'dir') {
  event.stopPropagation()
  event.dataTransfer.effectAllowed = entryType ? 'copyMove' : 'copy'
  event.dataTransfer.setData('application/x-agent-rider-file-path', filePath)
  event.dataTransfer.setData('text/plain', filePath)
  if (entryType) {
    event.dataTransfer.setData(FS_ENTRY_DRAG, JSON.stringify({ path: filePath, type: entryType }))
  }
}

function fsEntryFromDrag(event: DragEvent<HTMLElement>): { path: string; type: 'file' | 'dir' } | null {
  try {
    const value = JSON.parse(event.dataTransfer.getData(FS_ENTRY_DRAG)) as { path?: unknown; type?: unknown }
    if (typeof value.path !== 'string' || (value.type !== 'file' && value.type !== 'dir')) return null
    return { path: value.path, type: value.type }
  } catch {
    return null
  }
}

function parentDirectory(path: string) {
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path
  const separator = normalized.lastIndexOf('/')
  return separator <= 0 ? '/' : normalized.slice(0, separator)
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

function spreadsheetColumnLabel(index: number) {
  let label = ''
  let value = index + 1
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}

interface CsvFilePreviewProps {
  preview: FsFilePreview
  editing: boolean
  onEditingChange: (editing: boolean) => void
  onSaved: (preview: FsFilePreview) => void
}

function CsvFilePreview({ preview, editing, onEditingChange, onSaved }: CsvFilePreviewProps) {
  const parsedPreview = useMemo(() => parseCsv(preview.content ?? ''), [preview.content])
  const [csvDocument, setCsvDocument] = useState<CsvDocument>(() => ({
    ...parsedPreview,
    rows: normalizeCsvRows(parsedPreview.rows),
  }))
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const cellRefs = useRef(new Map<string, HTMLTextAreaElement>())

  useEffect(() => {
    if (editing) return
    setCsvDocument({ ...parsedPreview, rows: normalizeCsvRows(parsedPreview.rows) })
    setSaveError(null)
  }, [editing, parsedPreview])

  useEffect(() => {
    if (!editing) return
    window.requestAnimationFrame(() => cellRefs.current.get('0:0')?.focus())
  }, [editing])

  const rowCount = csvDocument.rows.length
  const columnCount = csvDocument.rows[0]?.length ?? 1
  const serialized = useMemo(() => serializeCsv(csvDocument), [csvDocument])
  const dirty = serialized !== (preview.content ?? '')

  function updateCell(rowIndex: number, columnIndex: number, value: string) {
    setCsvDocument((current) => ({
      ...current,
      rows: current.rows.map((row, index) => (
        index === rowIndex ? row.map((cell, column) => column === columnIndex ? value : cell) : row
      )),
    }))
  }

  function focusCell(rowIndex: number, columnIndex: number) {
    const row = Math.max(0, Math.min(rowCount - 1, rowIndex))
    const column = Math.max(0, Math.min(columnCount - 1, columnIndex))
    cellRefs.current.get(`${row}:${column}`)?.focus()
  }

  function moveFromCell(event: KeyboardEvent<HTMLTextAreaElement>, rowIndex: number, columnIndex: number) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && event.altKey) return
    let nextRow = rowIndex
    let nextColumn = columnIndex
    if (event.key === 'ArrowUp') nextRow -= 1
    else if (event.key === 'ArrowDown' || event.key === 'Enter') nextRow += event.shiftKey ? -1 : 1
    else if (event.key === 'ArrowLeft') nextColumn -= 1
    else if (event.key === 'ArrowRight') nextColumn += 1
    else if (event.key === 'Tab') {
      const offset = rowIndex * columnCount + columnIndex + (event.shiftKey ? -1 : 1)
      nextRow = Math.floor(Math.max(0, Math.min(rowCount * columnCount - 1, offset)) / columnCount)
      nextColumn = Math.max(0, Math.min(rowCount * columnCount - 1, offset)) % columnCount
    } else if (event.key === 'Home') {
      nextColumn = 0
    } else if (event.key === 'End') {
      nextColumn = columnCount - 1
    } else {
      return
    }
    event.preventDefault()
    focusCell(nextRow, nextColumn)
  }

  function pasteCells(event: ClipboardEvent<HTMLTextAreaElement>, startRow: number, startColumn: number) {
    const clipboard = event.clipboardData.getData('text/plain')
    if (!clipboard.includes('\t') && !/[\r\n]/.test(clipboard)) return
    event.preventDefault()
    const pastedRows = clipboard.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((row) => row.split('\t'))
    setCsvDocument((current) => {
      const neededRows = Math.max(current.rows.length, startRow + pastedRows.length)
      const neededColumns = Math.max(
        current.rows[0]?.length ?? 1,
        startColumn + Math.max(...pastedRows.map((row) => row.length)),
      )
      const rows = Array.from({ length: neededRows }, (_, rowIndex) => (
        Array.from({ length: neededColumns }, (_, columnIndex) => (
          pastedRows[rowIndex - startRow]?.[columnIndex - startColumn]
            ?? current.rows[rowIndex]?.[columnIndex]
            ?? ''
        ))
      ))
      return { ...current, rows }
    })
  }

  async function saveCsv() {
    if (saving) return
    if (!dirty) {
      onEditingChange(false)
      return
    }
    setSaving(true)
    setSaveError(null)
    const result = await writeFileContent(preview.path, serialized)
    setSaving(false)
    if ('error' in result) {
      setSaveError(result.error)
      return
    }
    onSaved({ ...preview, content: serialized, size: result.size })
    onEditingChange(false)
  }

  return (
    <div className={`csv-preview ${editing ? 'editing' : ''}`}>
      <div className="csv-preview-toolbar">
        <span>{rowCount} row{rowCount === 1 ? '' : 's'} · {columnCount} column{columnCount === 1 ? '' : 's'}</span>
        {editing ? (
          <>
            <span className="csv-preview-hint">Arrow keys move · Enter moves down · paste from Excel</span>
            {saveError ? <span className="csv-preview-error" role="alert">{saveError}</span> : null}
            <button type="button" className="csv-preview-save" disabled={saving || !dirty} onClick={() => void saveCsv()}>
              {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
          </>
        ) : null}
      </div>
      <div className="csv-preview-scroll">
        <table className="csv-preview-table" aria-label={`${preview.name} spreadsheet`}>
          <thead>
            <tr className="csv-column-labels">
              <th className="csv-corner" aria-label="Row number" />
              {Array.from({ length: columnCount }, (_, columnIndex) => (
                <th key={columnIndex} scope="col">{spreadsheetColumnLabel(columnIndex)}</th>
              ))}
            </tr>
            <tr className="csv-header-row">
              <th scope="row">1</th>
              {csvDocument.rows[0].map((cell, columnIndex) => (
                <th key={columnIndex} scope="col">
                  {editing ? (
                    <textarea
                      rows={1}
                      ref={(node) => {
                        if (node) cellRefs.current.set(`0:${columnIndex}`, node)
                        else cellRefs.current.delete(`0:${columnIndex}`)
                      }}
                      value={cell}
                      aria-label={`Row 1, column ${spreadsheetColumnLabel(columnIndex)}`}
                      onChange={(event) => updateCell(0, columnIndex, event.target.value)}
                      onFocus={(event) => event.currentTarget.select()}
                      onKeyDown={(event) => moveFromCell(event, 0, columnIndex)}
                      onPaste={(event) => pasteCells(event, 0, columnIndex)}
                    />
                  ) : <span title={cell}>{cell}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {csvDocument.rows.slice(1).map((row, bodyIndex) => {
              const rowIndex = bodyIndex + 1
              return (
                <tr key={rowIndex}>
                  <th scope="row">{rowIndex + 1}</th>
                  {row.map((cell, columnIndex) => (
                    <td key={columnIndex}>
                      {editing ? (
                        <textarea
                          rows={1}
                          ref={(node) => {
                            if (node) cellRefs.current.set(`${rowIndex}:${columnIndex}`, node)
                            else cellRefs.current.delete(`${rowIndex}:${columnIndex}`)
                          }}
                          value={cell}
                          aria-label={`Row ${rowIndex + 1}, column ${spreadsheetColumnLabel(columnIndex)}`}
                          onChange={(event) => updateCell(rowIndex, columnIndex, event.target.value)}
                          onFocus={(event) => event.currentTarget.select()}
                          onKeyDown={(event) => moveFromCell(event, rowIndex, columnIndex)}
                          onPaste={(event) => pasteCells(event, rowIndex, columnIndex)}
                        />
                      ) : <span title={cell}>{cell}</span>}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Floating file preview ────────────────────────────────────────────────

interface FloatingPreviewProps {
  preview: FilePreviewWindow
  visible: boolean
  onClose: () => void
  onPreviewChange: (preview: FsFilePreview) => void
}

type PreviewResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

/**
 * A draggable, resizable floating window that portals to the document body so
 * it always renders on top of other UI. Drag by the titlebar; resize via the
 * any edge or corner; expand to full screen via the titlebar button. Minimized
 * previews remain mounted as tabs in the workspace dock below the menu bar.
 */
function FloatingPreview({ preview, visible, onClose, onPreviewChange }: FloatingPreviewProps) {
  const [position, setPosition] = useState({ x: 160, y: 80 })
  const [size, setSize] = useState({ width: 640, height: 520 })
  const [fullScreen, setFullScreen] = useState(false)
  const [minimized, setMinimized] = useState(false)
  const [copyState, setCopyState] = useState<'copied' | 'error' | null>(null)
  const [filePathDragEnabled, setFilePathDragEnabled] = useState(false)
  const [editingCsv, setEditingCsv] = useState(false)
  const savedGeom = useRef({ x: 160, y: 80, w: 640, h: 520 })
  const draggingRef = useRef(false)
  const resizingRef = useRef<PreviewResizeDirection | null>(null)
  const filePathDraggingRef = useRef(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const resizeStart = useRef({ pointerX: 0, pointerY: 0, x: 0, y: 0, width: 640, height: 520 })
  const previewRef = useRef(preview)
  const onPreviewChangeRef = useRef(onPreviewChange)
  const restoreRequestRef = useRef(preview.restoreRequest)
  const minW = 320, minH = 240
  const lineCountLabel = previewLineCountLabel(preview.content)
  const previewMetadata = [preview.kind, formatBytes(preview.size), lineCountLabel].filter(Boolean).join(' · ')
  previewRef.current = preview
  onPreviewChangeRef.current = onPreviewChange

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let refreshing = false
    const refreshPreview = async () => {
      if (refreshing || document.visibilityState === 'hidden') return
      refreshing = true
      const result = await readFilePreview(preview.path)
      refreshing = false
      if (cancelled || 'error' in result || filePreviewsMatch(previewRef.current, result)) return
      onPreviewChangeRef.current(result)
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshPreview()
    }
    const interval = window.setInterval(() => void refreshPreview(), FILE_CHANGE_POLL_INTERVAL_MS)
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [preview.path, visible])

  useEffect(() => {
    if (preview.restoreRequest === restoreRequestRef.current) return
    restoreRequestRef.current = preview.restoreRequest
    setMinimized(false)
  }, [preview.restoreRequest])

  const onPointerDownTitle = useCallback((event: ReactPointerEvent) => {
    const target = event.target as HTMLElement
    if (target.closest('button, [draggable="true"]')) return
    event.preventDefault()
    draggingRef.current = true
    dragOffset.current = { x: event.clientX - position.x, y: event.clientY - position.y }
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  }, [position])

  const onPointerDownResize = useCallback((dir: PreviewResizeDirection) => (event: ReactPointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    resizingRef.current = dir
    resizeStart.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
    }
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  }, [position, size])

  const onPointerMove = useCallback((event: ReactPointerEvent) => {
    if (draggingRef.current) {
      setPosition({ x: event.clientX - dragOffset.current.x, y: event.clientY - dragOffset.current.y })
    } else if (resizingRef.current) {
      const dir = resizingRef.current
      const start = resizeStart.current
      const dx = event.clientX - start.pointerX
      const dy = event.clientY - start.pointerY
      const changesLeft = dir.includes('w')
      const changesRight = dir.includes('e')
      const changesTop = dir.includes('n')
      const changesBottom = dir.includes('s')
      const width = changesLeft
        ? Math.max(minW, start.width - dx)
        : changesRight
          ? Math.max(minW, start.width + dx)
          : start.width
      const height = changesTop
        ? Math.max(minH, start.height - dy)
        : changesBottom
          ? Math.max(minH, start.height + dy)
          : start.height

      setPosition({
        x: changesLeft ? start.x + start.width - width : start.x,
        y: changesTop ? start.y + start.height - height : start.y,
      })
      setSize({ width, height })
    }
  }, [])

  const onPointerUp = useCallback(() => {
    draggingRef.current = false
    resizingRef.current = null
  }, [])

  const armFilePathDrag = useCallback(() => setFilePathDragEnabled(true), [])

  const disarmFilePathDrag = useCallback(() => {
    if (!filePathDraggingRef.current) setFilePathDragEnabled(false)
  }, [])

  const beginFilePathDrag = useCallback((event: DragEvent<HTMLElement>) => {
    filePathDraggingRef.current = true
    setFilePathDragData(event, preview.path)
  }, [preview.path])

  const endFilePathDrag = useCallback((event: DragEvent<HTMLElement>) => {
    filePathDraggingRef.current = false
    const source = event.currentTarget
    window.requestAnimationFrame(() => setFilePathDragEnabled(source.matches(':hover')))
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

  const copyPreview = useCallback(async () => {
    setCopyState(null)
    try {
      if (preview.content != null) {
        await copyToClipboard(preview.content)
      } else if (preview.viewUrl) {
        const response = await fetch(preview.viewUrl)
        if (!response.ok) throw new Error('Unable to read preview source')
        await copyToClipboard(await response.text())
      } else if (preview.dataUrl && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        const blob = await (await fetch(preview.dataUrl)).blob()
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      } else {
        await copyToClipboard(preview.path)
      }
      setCopyState('copied')
      window.setTimeout(() => setCopyState(null), 1200)
    } catch {
      setCopyState('error')
      window.setTimeout(() => setCopyState(null), 1600)
    }
  }, [preview])

  // Keep the component mounted while its conversation is on another Desktop.
  // Its local window state (especially minimized) then survives the round trip.
  if (!visible) return null

  if (minimized) {
    const dock = document.getElementById('minimized-preview-tabs')
    return dock
      ? createPortal(
          <div
            className="minimized-preview-tab"
            draggable
            onDragStart={beginFilePathDrag}
            onDragEnd={endFilePathDrag}
          >
            <button
              type="button"
              className="minimized-preview-tab-restore"
              onClick={() => setMinimized(false)}
              title={`Click to restore or drag the full path: ${preview.path}`}
            >
              <span className="minimized-preview-tab-icon" aria-hidden>▱</span>
              <span className="minimized-preview-tab-name">{preview.name}</span>
            </button>
            <button
              type="button"
              className="minimized-preview-tab-close"
              onClick={onClose}
              aria-label={`Close ${preview.name} preview`}
              title="Close preview"
            >
              ×
            </button>
          </div>,
          dock,
        )
      : null
  }

  return createPortal(
    <div
      className={`floating-preview ${fullScreen ? 'full-screen' : ''}`}
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div className="floating-preview-titlebar" onPointerDown={onPointerDownTitle}>
        <div className="floating-preview-title">
          <strong
            className="floating-preview-file-name"
            draggable={filePathDragEnabled}
            title={`Drag the full path: ${preview.path}`}
            onPointerEnter={armFilePathDrag}
            onPointerLeave={disarmFilePathDrag}
            onDragStart={beginFilePathDrag}
            onDragEnd={endFilePathDrag}
          >
            {preview.name}
          </strong>
          <span>{previewMetadata}</span>
        </div>
        <button
          type="button"
          className={`floating-preview-edit ${editingCsv ? 'active' : ''}`}
          hidden={preview.kind !== 'csv'}
          onClick={() => setEditingCsv((current) => !current)}
          title={editingCsv ? 'Cancel CSV edits' : 'Edit CSV as a spreadsheet'}
        >
          {editingCsv ? 'Cancel' : 'Edit'}
        </button>
        <button
          type="button"
          className={`floating-preview-copy ${copyState ?? ''}`}
          onClick={() => void copyPreview()}
          title="Copy preview contents"
          aria-label="Copy preview contents"
        >
          {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Failed' : 'Copy'}
        </button>
        <button
          type="button"
          className="floating-preview-icon-btn"
          onClick={() => setMinimized(true)}
          title="Minimize to the preview tabs"
          aria-label="Minimize file preview"
        >
          −
        </button>
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
            key={`${preview.path}\0${preview.modifiedAt ?? preview.size}`}
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
        ) : preview.kind === 'csv' ? (
          <CsvFilePreview
            preview={preview}
            editing={editingCsv}
            onEditingChange={setEditingCsv}
            onSaved={onPreviewChange}
          />
        ) : (
          <CodeFilePreview preview={preview} />
        )}
      </div>
      {!fullScreen ? (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as PreviewResizeDirection[]).map((direction) => (
        <div
          key={direction}
          className={`floating-preview-resize-handle resize-${direction}`}
          onPointerDown={onPointerDownResize(direction)}
          aria-hidden
        />
      )) : null}
    </div>,
    document.body,
  )
}

// ── Floating To-Do List ────────────────────────────────────────────────────

const TODO_DRAG_ID = 'application/x-agent-rider-todo-id'
const TODO_DRAG_TEXT = 'application/x-agent-rider-todo-text'
const FS_ENTRY_DRAG = 'application/x-agent-rider-fs-entry'
const INPUT_TEXT_DRAG = 'application/x-agent-rider-input-text'

function moveTodoItem(items: TodoItem[], draggedId: string, targetId: string, after: boolean) {
  const dragged = items.find((item) => item.id === draggedId)
  if (!dragged || draggedId === targetId) return items
  const without = items.filter((item) => item.id !== draggedId)
  let targetIndex = without.findIndex((item) => item.id === targetId)
  if (targetIndex < 0) return items
  if (after) targetIndex += 1
  return [...without.slice(0, targetIndex), dragged, ...without.slice(targetIndex)]
}

function TodoWindow({
  minimized,
  onMinimizedChange,
  onClose,
}: {
  minimized: boolean
  onMinimizedChange: (minimized: boolean) => void
  onClose: () => void
}) {
  const [items, setItems] = useState<TodoItem[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [completionFilter, setCompletionFilter] = useState<TodoCompletionFilter>('unchecked')
  const [position, setPosition] = useState({ x: 130, y: 76 })
  const [size, setSize] = useState({ width: 460, height: 580 })
  const [fullScreen, setFullScreen] = useState(false)
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<{ id: string; after: boolean } | null>(null)
  const savedGeom = useRef({ x: 130, y: 76, w: 460, h: 580 })
  const draggingWindowRef = useRef(false)
  const resizingRef = useRef<PreviewResizeDirection | null>(null)
  const dragOffset = useRef({ x: 0, y: 0 })
  const resizeStart = useRef({ pointerX: 0, pointerY: 0, x: 0, y: 0, width: 460, height: 580 })
  const minW = 340, minH = 320
  const uncheckedCount = items.filter((item) => !item.completed).length
  const checkedCount = items.length - uncheckedCount
  const visibleItems = items.filter((item) => todoMatchesCompletionFilter(item.completed, completionFilter))

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void loadTodos().then((result) => {
      if (cancelled) return
      if ('error' in result) setError(result.error)
      else setItems(result.items)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const onPointerDownTitle = useCallback((event: ReactPointerEvent) => {
    const target = event.target as HTMLElement
    if (target.closest('button')) return
    event.preventDefault()
    draggingWindowRef.current = true
    dragOffset.current = { x: event.clientX - position.x, y: event.clientY - position.y }
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  }, [position])

  const onPointerDownResize = useCallback((direction: PreviewResizeDirection) => (event: ReactPointerEvent) => {
    event.preventDefault()
    event.stopPropagation()
    resizingRef.current = direction
    resizeStart.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: position.x,
      y: position.y,
      width: size.width,
      height: size.height,
    }
    ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
  }, [position, size])

  const onPointerMove = useCallback((event: ReactPointerEvent) => {
    if (draggingWindowRef.current) {
      setPosition({ x: event.clientX - dragOffset.current.x, y: event.clientY - dragOffset.current.y })
      return
    }
    const direction = resizingRef.current
    if (!direction) return
    const start = resizeStart.current
    const dx = event.clientX - start.pointerX
    const dy = event.clientY - start.pointerY
    const changesLeft = direction.includes('w')
    const changesRight = direction.includes('e')
    const changesTop = direction.includes('n')
    const changesBottom = direction.includes('s')
    const width = changesLeft
      ? Math.max(minW, start.width - dx)
      : changesRight ? Math.max(minW, start.width + dx) : start.width
    const height = changesTop
      ? Math.max(minH, start.height - dy)
      : changesBottom ? Math.max(minH, start.height + dy) : start.height
    setPosition({
      x: changesLeft ? start.x + start.width - width : start.x,
      y: changesTop ? start.y + start.height - height : start.y,
    })
    setSize({ width, height })
  }, [])

  const onPointerUp = useCallback(() => {
    draggingWindowRef.current = false
    resizingRef.current = null
  }, [])

  const toggleFullScreen = useCallback(() => {
    setFullScreen((current) => {
      if (current) {
        const geometry = savedGeom.current
        setPosition({ x: geometry.x, y: geometry.y })
        setSize({ width: geometry.w, height: geometry.h })
      } else {
        savedGeom.current = { x: position.x, y: position.y, w: size.width, h: size.height }
        setPosition({ x: 8, y: 8 })
        setSize({ width: window.innerWidth - 16, height: window.innerHeight - 16 })
      }
      return !current
    })
  }, [position, size])

  async function addItem(event: FormEvent) {
    event.preventDefault()
    const content = draft.trim()
    if (!content || saving) return
    setSaving(true)
    setError(null)
    const result = await createTodo(content)
    setSaving(false)
    if ('error' in result) {
      setError(result.error)
      return
    }
    setItems((current) => [result.item, ...current])
    setDraft('')
  }

  function changeItem(id: string, content: string) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, content } : item))
  }

  async function saveItem(item: TodoItem) {
    const content = item.content.trim()
    if (!content) {
      setError('To-Do content cannot be empty.')
      return
    }
    setError(null)
    const result = await updateTodo(item.id, { content })
    if ('error' in result) {
      setError(result.error)
      return
    }
    setItems((current) => current.map((candidate) => candidate.id === item.id
      ? { ...candidate, content: result.item.content, updatedAt: result.item.updatedAt }
      : candidate))
  }

  async function toggleItem(item: TodoItem, completed: boolean) {
    setError(null)
    setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, completed } : candidate))
    const result = await updateTodo(item.id, { completed })
    if ('error' in result) {
      setError(result.error)
      setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, completed: item.completed } : candidate))
      return
    }
    setItems((current) => current.map((candidate) => candidate.id === item.id
      ? { ...candidate, completed: result.item.completed, updatedAt: result.item.updatedAt }
      : candidate))
  }

  async function removeItem(id: string) {
    setError(null)
    const result = await deleteTodo(id)
    if ('error' in result) {
      setError(result.error)
      return
    }
    setItems((current) => current.filter((item) => item.id !== id))
  }

  function beginItemDrag(event: DragEvent<HTMLElement>, item: TodoItem) {
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData(TODO_DRAG_ID, item.id)
    event.dataTransfer.setData(TODO_DRAG_TEXT, item.content)
    event.dataTransfer.setData('text/plain', item.content)
    setDraggedId(item.id)
  }

  function dropOnItem(event: DragEvent<HTMLElement>, targetId: string) {
    const sourceId = event.dataTransfer.getData(TODO_DRAG_ID)
    if (!sourceId || sourceId === targetId) return
    event.preventDefault()
    event.stopPropagation()
    const target = event.currentTarget.getBoundingClientRect()
    const after = event.clientY > target.top + target.height / 2
    setItems((current) => {
      const next = moveTodoItem(current, sourceId, targetId, after)
      void setTodoOrder(next.map((item) => item.id)).then((result) => {
        if ('error' in result) setError(result.error)
      })
      return next
    })
    setDragOver(null)
  }

  if (minimized) {
    const dock = document.getElementById('minimized-preview-tabs')
    return dock ? createPortal(
      <div className="minimized-preview-tab todo-minimized-tab">
        <button
          type="button"
          className="minimized-preview-tab-restore"
          onClick={() => onMinimizedChange(false)}
          title="Restore To-Do List"
        >
          <span className="minimized-preview-tab-icon" aria-hidden>✓</span>
          <span className="minimized-preview-tab-name">To-Do List</span>
        </button>
        <button
          type="button"
          className="minimized-preview-tab-close"
          onClick={onClose}
          aria-label="Close To-Do List"
        >
          ×
        </button>
      </div>,
      dock,
    ) : null
  }

  return createPortal(
    <section
      className={`floating-preview todo-window ${fullScreen ? 'full-screen' : ''}`}
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-label="To-Do List"
    >
      <div className="floating-preview-titlebar" onPointerDown={onPointerDownTitle}>
        <div className="floating-preview-title">
          <strong>To-Do List</strong>
          <span>Ideas & unused prompts · {items.length} item{items.length === 1 ? '' : 's'}</span>
        </div>
        <button
          type="button"
          className="floating-preview-icon-btn"
          onClick={() => onMinimizedChange(true)}
          title="Minimize To-Do List"
          aria-label="Minimize To-Do List"
        >
          −
        </button>
        <button
          type="button"
          className="floating-preview-icon-btn"
          onClick={toggleFullScreen}
          title={fullScreen ? 'Exit full screen' : 'Expand to full screen'}
          aria-label={fullScreen ? 'Exit full screen' : 'Expand to full screen'}
        >
          {fullScreen ? '↙' : '⛶'}
        </button>
        <button type="button" className="floating-preview-close" onClick={onClose} aria-label="Close To-Do List">
          ×
        </button>
      </div>

      <div className="floating-preview-body todo-window-body">
        <form className="todo-composer" onSubmit={addItem}>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Record an idea or save an unused prompt…"
            rows={3}
            spellCheck={false}
          />
          <button type="submit" className="send-button" disabled={!draft.trim() || saving}>
            {saving ? 'Adding…' : '+ Add'}
          </button>
        </form>

        {error ? <div className="todo-error" role="alert">{error}</div> : null}

        <div className="todo-completion-filter" role="group" aria-label="Filter To-Do items by completion">
          <button
            type="button"
            className={completionFilter === 'unchecked' ? 'active' : ''}
            aria-pressed={completionFilter === 'unchecked'}
            onClick={() => setCompletionFilter('unchecked')}
          >
            Unchecked <span>{uncheckedCount}</span>
          </button>
          <button
            type="button"
            className={completionFilter === 'checked' ? 'active' : ''}
            aria-pressed={completionFilter === 'checked'}
            onClick={() => setCompletionFilter('checked')}
          >
            Checked <span>{checkedCount}</span>
          </button>
        </div>

        <div className="todo-list" aria-live="polite">
          {loading ? (
            <div className="todo-empty">Loading To-Do items…</div>
          ) : visibleItems.length ? visibleItems.map((item, index) => {
            const itemIndex = items.findIndex((candidate) => candidate.id === item.id)
            const itemNumber = items.length - itemIndex
            return (
              <article
                key={item.id}
                className={`todo-bubble ${item.completed ? 'completed' : ''} ${draggedId === item.id ? 'dragging' : ''} ${dragOver?.id === item.id ? (dragOver.after ? 'drag-over after' : 'drag-over') : ''}`}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(TODO_DRAG_ID)) return
                  event.preventDefault()
                  event.stopPropagation()
                  event.dataTransfer.dropEffect = 'move'
                  const rect = event.currentTarget.getBoundingClientRect()
                  setDragOver({ id: item.id, after: event.clientY > rect.top + rect.height / 2 })
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragOver(null)
                }}
                onDrop={(event) => dropOnItem(event, item.id)}
              >
                <div
                  className="todo-bubble-head"
                  draggable
                  onDragStart={(event) => beginItemDrag(event, item)}
                  onDragEnd={() => {
                    setDraggedId(null)
                    setDragOver(null)
                  }}
                  title="Drag to reorder or drop into a TUI / Notepad"
                >
                  <span
                    className="todo-drag-handle"
                    aria-label={`Drag To-Do item ${itemNumber}`}
                  >
                    ⠿
                  </span>
                  <input
                    className="todo-checkbox"
                    type="checkbox"
                    checked={item.completed}
                    onChange={(event) => void toggleItem(item, event.target.checked)}
                    aria-label={`Mark To-Do item ${itemNumber} as ${item.completed ? 'incomplete' : 'complete'}`}
                  />
                  <span className="todo-number">#{itemNumber}</span>
                  <button type="button" className="todo-delete" onClick={() => void removeItem(item.id)} aria-label={`Delete To-Do item ${itemNumber}`}>
                    ×
                  </button>
                </div>
                <textarea
                  value={item.content}
                  onChange={(event) => changeItem(item.id, event.target.value)}
                  onBlur={() => void saveItem(item)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.blur()
                    }
                  }}
                  rows={Math.min(8, Math.max(2, item.content.split('\n').length))}
                  spellCheck={false}
                  aria-label={`To-Do item ${itemNumber}`}
                />
              </article>
            )
          }) : (
            <div className="todo-empty">
              {completionFilter === 'checked' ? 'No checked To-Do items.' : 'No unchecked To-Do items.'}
            </div>
          )}
        </div>
      </div>

      {!fullScreen ? (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as PreviewResizeDirection[]).map((direction) => (
        <div
          key={direction}
          className={`floating-preview-resize-handle resize-${direction}`}
          onPointerDown={onPointerDownResize(direction)}
          aria-hidden
        />
      )) : null}
    </section>,
    document.body,
  )
}

/**
 * File browser opened at a conversation's workspace. Collapsed by default and
 * lazy-loaded on first expand. Users can navigate above the workspace, while the
 * backend still sandboxes every filesystem operation to BROWSE_ROOT.
 */
async function openFilePreviewWindow(
  filePath: string,
  onPreviewsChange: Dispatch<SetStateAction<FilePreviewWindow[]>>,
) {
  const result = await readFilePreview(filePath)
  if ('error' in result) return result.error
  onPreviewsChange((current) => mergeOpenedFilePreview(current, result))
  return null
}

function FileBrowser({
  rootPath,
  open,
  onToggle,
  previews,
  onPreviewsChange,
  showOwnToggle = true,
}: {
  rootPath: string
  /** Controlled from the parent so a card can also trigger it from elsewhere
   *  (e.g. a compact button in the TUI terminal's own header). */
  open: boolean
  onToggle: () => void
  previews: FilePreviewWindow[]
  onPreviewsChange: Dispatch<SetStateAction<FilePreviewWindow[]>>
  /** When false, this component renders only the dropdown panel (when open)
   *  and skips its own floating toggle pill — the parent renders a toggle
   *  trigger elsewhere instead. */
  showOwnToggle?: boolean
}) {
  type BrowserEntry = FsEntry & { type: 'file' | 'dir'; size: number | null }
  type FileSortKey = 'name' | 'modifiedAt' | 'size'
  const [path, setPath] = useState(rootPath)
  const [effectiveRootPath, setEffectiveRootPath] = useState(rootPath)
  const [listing, setListing] = useState<FsListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<FsFileEntry | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [renamingEntry, setRenamingEntry] = useState<(FsEntry & { type: 'file' | 'dir' }) | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [contextMenu, setContextMenu] = useState<{ entry: BrowserEntry; x: number; y: number } | null>(null)
  const [pendingMove, setPendingMove] = useState<BrowserEntry | null>(null)
  const [moveDestination, setMoveDestination] = useState('')
  const [sortKey, setSortKey] = useState<FileSortKey>('name')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')
  const [mutatingPath, setMutatingPath] = useState<string | null>(null)
  const [draggingPath, setDraggingPath] = useState<string | null>(null)
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const [typeFilter, setTypeFilter] = useState('all')
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<FsSearchResultEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchTruncated, setSearchTruncated] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const resizeRef = useRef<{ startX: number; startWidth: number; minWidth: number; maxWidth: number } | null>(null)
  const [panelWidth, setPanelWidth] = useState<number | null>(null)
  const [resizing, setResizing] = useState(false)

  useEffect(() => {
    if (!contextMenu) return
    const closeMenu = () => setContextMenu(null)
    const closeMenuOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    document.addEventListener('keydown', closeMenuOnEscape)
    window.addEventListener('blur', closeMenu)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    return () => {
      document.removeEventListener('keydown', closeMenuOnEscape)
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [contextMenu])

  function fileBrowserWidthBounds(panel: HTMLDivElement) {
    const availableWidth = Math.max(0, (panel.parentElement?.clientWidth ?? window.innerWidth) - 12)
    return {
      minWidth: Math.min(240, availableWidth),
      maxWidth: availableWidth,
    }
  }

  function resizeFileBrowserTo(width: number, panel = panelRef.current) {
    if (!panel) return
    const { minWidth, maxWidth } = fileBrowserWidthBounds(panel)
    setPanelWidth(Math.min(maxWidth, Math.max(minWidth, width)))
  }

  function beginFileBrowserResize(event: ReactPointerEvent<HTMLDivElement>) {
    const panel = panelRef.current
    if (!panel) return
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const { minWidth, maxWidth } = fileBrowserWidthBounds(panel)
    resizeRef.current = {
      startX: event.clientX,
      startWidth: panel.getBoundingClientRect().width,
      minWidth,
      maxWidth,
    }
    setResizing(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function continueFileBrowserResize(event: ReactPointerEvent<HTMLDivElement>) {
    const resize = resizeRef.current
    if (!resize || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const width = resize.startWidth + resize.startX - event.clientX
    setPanelWidth(Math.min(resize.maxWidth, Math.max(resize.minWidth, width)))
  }

  function endFileBrowserResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizeRef.current) return
    resizeRef.current = null
    setResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function nudgeFileBrowserWidth(event: KeyboardEvent<HTMLDivElement>) {
    const panel = panelRef.current
    if (!panel || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    event.preventDefault()
    event.stopPropagation()
    const direction = event.key === 'ArrowLeft' ? 1 : -1
    resizeFileBrowserTo(panel.getBoundingClientRect().width + direction * 24, panel)
  }

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
    // Close only the preview of the file we just removed, then refresh the
    // listing without disturbing any other open or minimized previews.
    onPreviewsChange((current) => current.filter((preview) => preview.path !== pendingDelete.path))
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

  function beginRename(entry: FsEntry, type: 'file' | 'dir') {
    setError(null)
    setContextMenu(null)
    setRenamingEntry({ ...entry, type })
    setRenameValue(entry.name)
  }

  async function confirmRename() {
    if (!renamingEntry || mutatingPath) return
    const name = renameValue.trim()
    if (!name) {
      setError('Name cannot be empty.')
      return
    }
    if (name === renamingEntry.name) {
      setRenamingEntry(null)
      return
    }
    setMutatingPath(renamingEntry.path)
    setError(null)
    const result = await moveFsEntry(renamingEntry.path, parentDirectory(renamingEntry.path), name)
    setMutatingPath(null)
    if ('error' in result) {
      setError(result.error)
      return
    }
    onPreviewsChange((current) => current.filter((preview) => (
      preview.path !== renamingEntry.path && !preview.path.startsWith(`${renamingEntry.path}/`)
    )))
    setRenamingEntry(null)
    void load(path)
  }

  async function moveEntryTo(source: string, destination: string) {
    if (mutatingPath || source === destination) return
    setMutatingPath(source)
    setError(null)
    setDragOverPath(null)
    const result = await moveFsEntry(source, destination)
    setMutatingPath(null)
    setDraggingPath(null)
    if ('error' in result) {
      setError(result.error)
      return
    }
    onPreviewsChange((current) => current.filter((preview) => (
      preview.path !== source && !preview.path.startsWith(`${source}/`)
    )))
    if (renamingEntry?.path === source) setRenamingEntry(null)
    void load(path)
  }

  async function confirmMove() {
    if (!pendingMove || mutatingPath) return
    const destination = moveDestination.trim()
    if (!destination) {
      setError('Destination folder cannot be empty.')
      return
    }
    const entry = pendingMove
    setPendingMove(null)
    await moveEntryTo(entry.path, destination)
  }

  async function duplicateEntry(entry: BrowserEntry) {
    if (mutatingPath) return
    setContextMenu(null)
    setMutatingPath(entry.path)
    setError(null)
    const result = await duplicateFsEntry(entry.path)
    setMutatingPath(null)
    if ('error' in result) {
      setError(result.error)
      return
    }
    void load(path)
  }

  function openFileContextMenu(event: React.MouseEvent<HTMLElement>, entry: BrowserEntry) {
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 210
    const menuHeight = entry.type === 'file' ? 226 : 150
    setContextMenu({
      entry,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
    })
  }

  function beginMove(entry: BrowserEntry) {
    setContextMenu(null)
    setPendingMove(entry)
    setMoveDestination(parentDirectory(entry.path))
  }

  function toggleSort(nextKey: FileSortKey) {
    if (nextKey === sortKey) {
      setSortDirection((current) => current === 'asc' ? 'desc' : 'asc')
      return
    }
    setSortKey(nextKey)
    setSortDirection(nextKey === 'name' ? 'asc' : 'desc')
  }

  function allowEntryDrop(event: DragEvent<HTMLElement>, destination: string) {
    if (!event.dataTransfer.types.includes(FS_ENTRY_DRAG) || draggingPath === destination || mutatingPath) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDragOverPath(destination)
  }

  function dropEntry(event: DragEvent<HTMLElement>, destination: string) {
    const entry = fsEntryFromDrag(event)
    if (!entry || entry.path === destination) return
    event.preventDefault()
    event.stopPropagation()
    setDragOverPath(null)
    void moveEntryTo(entry.path, destination)
  }

  async function load(target: string, exact = false) {
    setLoading(true)
    setError(null)
    setPreviewError(null)
    setSearchInput('')
    setSearchQuery('')
    setRenamingEntry(null)
    setDragOverPath(null)
    // Ordinary navigation can recover from a folder that disappeared by
    // falling back to the workspace, then the backend's allowed root. The
    // workspace button is intentionally exact: silently landing at the server
    // root makes it look as though that unrelated folder is the card's
    // Context workspace.
    const attempts = exact ? [target] : Array.from(new Set([target, rootPath, '']))
    let result: FsListing | null = null
    for (const attempt of attempts) {
      result = await listDir(attempt)
      if (result) break
    }
    if (!result) {
      setError(exact
        ? `Unable to read the Context workspace: ${rootPath}`
        : 'Unable to read this folder.')
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
    const error = await openFilePreviewWindow(filePath, onPreviewsChange)
    if (error) setPreviewError(error)
    setPreviewLoading(false)
  }

  // When the conversation's workspace changes, reset to its root (reload if open).
  useEffect(() => {
    setPath(rootPath)
    setEffectiveRootPath(rootPath)
    setListing(null)
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

  // TUI and external tools can change workspace files without going through
  // this component. Refresh silently while visible so navigation, filters,
  // search text, and scroll position are not reset by the polling cycle.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let refreshing = false
    const refreshFiles = async () => {
      if (refreshing || document.visibilityState === 'hidden') return
      refreshing = true
      const [nextListing, nextSearch] = await Promise.all([
        listDir(path),
        searchQuery ? searchFiles(path, searchQuery) : Promise.resolve(null),
      ])
      refreshing = false
      if (cancelled) return
      if (nextListing) {
        setListing((current) => fileListingsMatch(current, nextListing) ? current : nextListing)
      }
      if (nextSearch && !('error' in nextSearch)) {
        setSearchResults((current) => fileSearchResultsMatch(current, nextSearch.results) ? current : nextSearch.results)
        setSearchTruncated(Boolean(nextSearch.truncated))
      }
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshFiles()
    }
    const interval = window.setInterval(() => void refreshFiles(), FILE_CHANGE_POLL_INTERVAL_MS)
    window.addEventListener('focus', refreshWhenVisible)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', refreshWhenVisible)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [open, path, searchQuery])

  // Nothing to render — the parent owns the toggle trigger and the panel is
  // closed. But if a floating preview is open, keep the component alive so the
  // preview stays visible (it portals to document.body, so it doesn't need the
  // browser panel to be rendered).
  if (!open && !showOwnToggle && previews.length === 0) return null

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
        .map((entry) => ({ name: entry.name, path: entry.path, size: entry.size ?? null, modifiedAt: entry.modifiedAt }))
    : visibleFiles
  const compareEntries = (left: FsEntry & { size?: number | null }, right: FsEntry & { size?: number | null }) => {
    let result = 0
    if (sortKey === 'name') {
      result = left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    } else if (sortKey === 'modifiedAt') {
      result = (left.modifiedAt ?? -1) - (right.modifiedAt ?? -1)
    } else {
      result = (left.size ?? -1) - (right.size ?? -1)
    }
    return sortDirection === 'asc' ? result : -result
  }
  const sortedDirs = [...dirsToShow].sort(compareEntries)
  const sortedFiles = [...filesToShow].sort(compareEntries)
  const sortArrow = (key: FileSortKey) => sortKey === key ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'
  const contextMenuNode = contextMenu ? createPortal(
    <>
      <div
        className="file-context-backdrop"
        onMouseDown={() => setContextMenu(null)}
        onContextMenu={(event) => event.preventDefault()}
      />
      <div
        className="file-context-menu"
        role="menu"
        aria-label={`Actions for ${contextMenu.entry.name}`}
        style={{ left: contextMenu.x, top: contextMenu.y }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="file-context-title" title={contextMenu.entry.path}>{contextMenu.entry.name}</div>
        <button type="button" role="menuitem" className="file-context-item" onClick={() => beginRename(contextMenu.entry, contextMenu.entry.type)}>
          Rename
        </button>
        {contextMenu.entry.type === 'file' ? (
          <a
            role="menuitem"
            className="file-context-item"
            href={fileDownloadUrl(contextMenu.entry.path)}
            download={contextMenu.entry.name}
            onClick={() => setContextMenu(null)}
          >
            Download
          </a>
        ) : null}
        <button type="button" role="menuitem" className="file-context-item" onClick={() => beginMove(contextMenu.entry)}>
          Move
        </button>
        <button type="button" role="menuitem" className="file-context-item" disabled={Boolean(mutatingPath)} onClick={() => void duplicateEntry(contextMenu.entry)}>
          Duplicate
        </button>
        {contextMenu.entry.type === 'file' ? (
          <>
            <div className="file-context-separator" />
            <button
              type="button"
              role="menuitem"
              className="file-context-item delete"
              onClick={() => {
                setContextMenu(null)
                setPendingDelete(contextMenu.entry)
              }}
            >
              Delete
            </button>
          </>
        ) : null}
      </div>
    </>,
    document.body,
  ) : null

  return (
    <div
      ref={panelRef}
      className={`file-browser ${open ? 'open' : ''} ${resizing ? 'resizing' : ''} list-only`}
      style={panelWidth === null ? undefined : { width: `${panelWidth}px` }}
    >
      {open ? (
        <div
          className="file-browser-resize-handle"
          role="separator"
          aria-label="Resize file list"
          aria-orientation="vertical"
          tabIndex={0}
          title="Drag to resize the file list"
          onPointerDown={beginFileBrowserResize}
          onPointerMove={continueFileBrowserResize}
          onPointerUp={endFileBrowserResize}
          onPointerCancel={endFileBrowserResize}
          onLostPointerCapture={endFileBrowserResize}
          onKeyDown={nudgeFileBrowserWidth}
        />
      ) : null}
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
          <div className="file-browser-header">
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
              className={`file-browser-up ${dragOverPath === listing?.parent ? 'drop-target' : ''}`}
              disabled={!canGoUp || loading}
              onClick={() => listing?.parent && void load(listing.parent)}
              title={canGoUp ? 'Up one folder' : 'At server browse root'}
              onDragOver={(event) => listing?.parent && allowEntryDrop(event, listing.parent)}
              onDragLeave={() => setDragOverPath((current) => current === listing?.parent ? null : current)}
              onDrop={(event) => listing?.parent && dropEntry(event, listing.parent)}
            >
              ↑ ..
            </button>
            <button
              type="button"
              className="file-browser-home"
              disabled={isAtWorkspace || loading}
              onClick={() => void load(rootPath, true)}
              title={`Return to Context workspace: ${rootPath}`}
              aria-label={`Return to Context workspace: ${rootPath}`}
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

          {!isSearching ? <p className="file-browser-hint">Drag an item onto a folder or ↑ .. to move it.</p> : null}

          {error ? <p className="error-text">{error}</p> : null}
          {searchError ? <p className="error-text">{searchError}</p> : null}
          {isSearching && searchTruncated ? (
            <p className="file-browser-hint">Showing first matches only — refine your search.</p>
          ) : null}
          </div>

          <div className="file-browser-list">
            <div className="file-browser-columns" role="row">
              <button
                type="button"
                className={sortKey === 'name' ? 'active' : ''}
                onClick={() => toggleSort('name')}
                aria-label={`Sort by filename ${sortKey === 'name' && sortDirection === 'asc' ? 'descending' : 'ascending'}`}
              >
                FileName <span aria-hidden>{sortArrow('name')}</span>
              </button>
              <button
                type="button"
                className={sortKey === 'modifiedAt' ? 'active' : ''}
                onClick={() => toggleSort('modifiedAt')}
                aria-label={`Sort by date ${sortKey === 'modifiedAt' && sortDirection === 'desc' ? 'ascending' : 'descending'}`}
              >
                Date <span aria-hidden>{sortArrow('modifiedAt')}</span>
              </button>
              <button
                type="button"
                className={sortKey === 'size' ? 'active' : ''}
                onClick={() => toggleSort('size')}
                aria-label={`Sort by size ${sortKey === 'size' && sortDirection === 'desc' ? 'ascending' : 'descending'}`}
              >
                Size <span aria-hidden>{sortArrow('size')}</span>
              </button>
            </div>
            {loading || (isSearching && searching) ? (
              <div className="file-browser-empty">{isSearching ? 'Searching…' : 'Loading…'}</div>
            ) : (isSearching ? searchResults !== null : Boolean(listing)) && (dirsToShow.length || filesToShow.length) ? (
              <>
                {sortedDirs.map((dir) => (
                  <div
                    role="button"
                    tabIndex={0}
                    key={dir.path}
                    className={`file-row dir ${draggingPath === dir.path ? 'dragging' : ''} ${dragOverPath === dir.path ? 'drop-target' : ''} ${mutatingPath === dir.path ? 'moving' : ''} ${renamingEntry?.path === dir.path ? 'renaming' : ''}`}
                    title={dir.name}
                    draggable={renamingEntry?.path !== dir.path && mutatingPath !== dir.path}
                    onDragStart={(event) => {
                      setDraggingPath(dir.path)
                      setFilePathDragData(event, dir.path, 'dir')
                    }}
                    onDragEnd={() => {
                      setDraggingPath(null)
                      setDragOverPath(null)
                    }}
                    onDragOver={(event) => allowEntryDrop(event, dir.path)}
                    onDragLeave={() => setDragOverPath((current) => current === dir.path ? null : current)}
                    onDrop={(event) => dropEntry(event, dir.path)}
                    onClick={() => void load(dir.path)}
                    onContextMenu={(event) => openFileContextMenu(event, { ...dir, type: 'dir', size: null })}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      void load(dir.path)
                    }}
                  >
                    <span className="file-row-name">
                      <span className="file-row-icon dir" aria-hidden>DIR</span>
                      {renamingEntry?.path === dir.path ? (
                        <>
                          <input
                            className="file-row-rename-input"
                            value={renameValue}
                            autoFocus
                            aria-label={`Rename ${dir.name}`}
                            onChange={(event) => setRenameValue(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            onDragStart={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              event.stopPropagation()
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                void confirmRename()
                              } else if (event.key === 'Escape') {
                                setRenamingEntry(null)
                              }
                            }}
                          />
                          <span className="file-row-edit-actions">
                            <button type="button" disabled={Boolean(mutatingPath)} onClick={(event) => { event.stopPropagation(); void confirmRename() }}>Save</button>
                            <button type="button" disabled={Boolean(mutatingPath)} onClick={(event) => { event.stopPropagation(); setRenamingEntry(null) }}>Cancel</button>
                          </span>
                        </>
                      ) : <span className="file-row-label">{dir.name}</span>}
                    </span>
                    <span className="file-row-date">{formatFileDate(dir.modifiedAt)}</span>
                    <span className="file-row-size">—</span>
                  </div>
                ))}
                {sortedFiles.map((file) => (
                  <div
                    role="button"
                    tabIndex={0}
                    key={file.path}
                    className={`file-row file ${previews.some((preview) => preview.path === file.path) ? 'active' : ''} ${draggingPath === file.path ? 'dragging' : ''} ${mutatingPath === file.path ? 'moving' : ''} ${renamingEntry?.path === file.path ? 'renaming' : ''}`}
                    title={file.path}
                    draggable={renamingEntry?.path !== file.path && mutatingPath !== file.path}
                    onDragStart={(event) => {
                      setDraggingPath(file.path)
                      setFilePathDragData(event, file.path, 'file')
                    }}
                    onDragEnd={() => {
                      setDraggingPath(null)
                      setDragOverPath(null)
                    }}
                    onClick={() => void openFile(file.path)}
                    onContextMenu={(event) => openFileContextMenu(event, { ...file, type: 'file' })}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      void openFile(file.path)
                    }}
                  >
                    <span className="file-row-name">
                      <span className="file-row-icon file" aria-hidden>{fileTypeIcon(file.name)}</span>
                      {renamingEntry?.path === file.path ? (
                        <>
                          <input
                            className="file-row-rename-input"
                            value={renameValue}
                            autoFocus
                            aria-label={`Rename ${file.name}`}
                            onChange={(event) => setRenameValue(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            onDragStart={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              event.stopPropagation()
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                void confirmRename()
                              } else if (event.key === 'Escape') {
                                setRenamingEntry(null)
                              }
                            }}
                          />
                          <span className="file-row-edit-actions">
                            <button type="button" disabled={Boolean(mutatingPath)} onClick={(event) => { event.stopPropagation(); void confirmRename() }}>Save</button>
                            <button type="button" disabled={Boolean(mutatingPath)} onClick={(event) => { event.stopPropagation(); setRenamingEntry(null) }}>Cancel</button>
                          </span>
                        </>
                      ) : <span className="file-row-label">{file.name}</span>}
                    </span>
                    <span className="file-row-date">{formatFileDate(file.modifiedAt)}</span>
                    <span className="file-row-size">{formatBytes(file.size)}</span>
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

      {contextMenuNode}

      {pendingMove ? (
        <div className="confirm-overlay" onClick={() => setPendingMove(null)}>
          <form
            className="confirm-dialog card"
            onSubmit={(event) => {
              event.preventDefault()
              void confirmMove()
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="picker-head">
              <div>
                <div className="eyebrow">Move item</div>
                <h3>{pendingMove.name}</h3>
              </div>
              <button type="button" className="picker-close" onClick={() => setPendingMove(null)} aria-label="Close">
                ×
              </button>
            </div>
            <label className="file-move-field">
              <span>Destination folder</span>
              <input
                value={moveDestination}
                onChange={(event) => setMoveDestination(event.target.value)}
                autoFocus
                spellCheck={false}
                aria-label="Destination folder path"
              />
            </label>
            <div className="picker-actions confirm-actions">
              <button type="button" className="picker-cancel" onClick={() => setPendingMove(null)}>Cancel</button>
              <button
                type="submit"
                className="send-button"
                disabled={!moveDestination.trim() || moveDestination.trim() === parentDirectory(pendingMove.path)}
              >
                Move
              </button>
            </div>
          </form>
        </div>
      ) : null}

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
const DRAG_EXCLUDE = 'input, textarea, select, button, a, iframe, [contenteditable="true"], .win-body, .win-promptbar, .conv-agent-terminal, .terminal-screen, .file-browser, .file-preview, .agent-app-body'

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

type PaneDividerAxis = 'x' | 'y'

interface PaneDividerConfig {
  trackIndex: number
  beforePane: number
  afterPane: number
  /** Restrict the divider's cross-axis span to this pane (master-stack rows). */
  crossPane?: number
}

interface PaneDividerPosition {
  main: number
  crossStart: number
  crossSize: number
}

function fittedPaneSizes(
  saved: number[] | undefined,
  count: number,
  defaults: number[] = [],
): number[] {
  return Array.from({ length: count }, (_, index) => {
    const savedSize = saved?.[index]
    if (typeof savedSize === 'number' && Number.isFinite(savedSize) && savedSize > 0) return savedSize
    return defaults[index] ?? 1
  })
}

function paneGridTracks(sizes: number[]) {
  return sizes.map((size) => `minmax(0, ${size}fr)`).join(' ')
}

function PaneDividerLayer({
  containerRef,
  axis,
  sizes,
  dividers,
  minPaneSize,
  onSizesChange,
}: {
  containerRef: { current: HTMLElement | null }
  axis: PaneDividerAxis
  sizes: number[]
  dividers: PaneDividerConfig[]
  minPaneSize: number
  onSizesChange: (sizes: number[]) => void
}) {
  const [positions, setPositions] = useState<Array<PaneDividerPosition | null>>([])
  const [activeDivider, setActiveDivider] = useState<number | null>(null)
  const dragRef = useRef<{
    pointerId: number
    dividerIndex: number
    startPointer: number
    beforePixels: number
    afterPixels: number
    sizes: number[]
  } | null>(null)

  const paneElement = useCallback((paneIndex: number) => (
    containerRef.current?.querySelector<HTMLElement>(`:scope > [data-pane-index="${paneIndex}"]`) ?? null
  ), [containerRef])

  const syncPositions = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const next = dividers.map((divider): PaneDividerPosition | null => {
      const before = paneElement(divider.beforePane)?.getBoundingClientRect()
      const after = paneElement(divider.afterPane)?.getBoundingClientRect()
      if (!before || !after) return null
      const cross = divider.crossPane === undefined
        ? null
        : paneElement(divider.crossPane)?.getBoundingClientRect() ?? null
      return {
        main: axis === 'x'
          ? (before.right + after.left) / 2 - containerRect.left
          : (before.bottom + after.top) / 2 - containerRect.top,
        crossStart: cross
          ? (axis === 'x' ? cross.top - containerRect.top : cross.left - containerRect.left)
          : 0,
        crossSize: cross
          ? (axis === 'x' ? cross.height : cross.width)
          : (axis === 'x' ? containerRect.height : containerRect.width),
      }
    })
    setPositions((current) => (
      current.length === next.length
      && current.every((position, index) => {
        const candidate = next[index]
        return position === null || candidate === null
          ? position === candidate
          : Math.abs(position.main - candidate.main) < 0.25
            && Math.abs(position.crossStart - candidate.crossStart) < 0.25
            && Math.abs(position.crossSize - candidate.crossSize) < 0.25
      })
        ? current
        : next
    ))
  }, [axis, containerRef, dividers, paneElement])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    syncPositions()
    const observer = new ResizeObserver(syncPositions)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, sizes, syncPositions])

  useEffect(() => () => {
    document.body.classList.remove('pane-resizing-x', 'pane-resizing-y')
  }, [])

  function resizedPair(
    divider: PaneDividerConfig,
    startSizes: number[],
    beforePixels: number,
    afterPixels: number,
    delta: number,
  ) {
    const pairPixels = beforePixels + afterPixels
    if (pairPixels <= 0) return startSizes
    const minimum = Math.min(minPaneSize, Math.max(24, pairPixels / 2 - 4))
    const nextBeforePixels = Math.min(pairPixels - minimum, Math.max(minimum, beforePixels + delta))
    const pairWeight = startSizes[divider.trackIndex] + startSizes[divider.trackIndex + 1]
    const nextBeforeWeight = pairWeight * (nextBeforePixels / pairPixels)
    const next = [...startSizes]
    next[divider.trackIndex] = nextBeforeWeight
    next[divider.trackIndex + 1] = pairWeight - nextBeforeWeight
    return next
  }

  function dividerRects(divider: PaneDividerConfig) {
    const before = paneElement(divider.beforePane)?.getBoundingClientRect()
    const after = paneElement(divider.afterPane)?.getBoundingClientRect()
    if (!before || !after) return null
    return {
      beforePixels: axis === 'x' ? before.width : before.height,
      afterPixels: axis === 'x' ? after.width : after.height,
    }
  }

  function finishResize() {
    dragRef.current = null
    setActiveDivider(null)
    document.body.classList.remove('pane-resizing-x', 'pane-resizing-y')
  }

  return (
    <div className="pane-divider-layer" aria-hidden={dividers.length === 0}>
      {dividers.map((divider, dividerIndex) => {
        const position = positions[dividerIndex]
        if (!position) return null
        const style: CSSProperties = axis === 'x'
          ? { left: position.main, top: position.crossStart, height: position.crossSize }
          : { top: position.main, left: position.crossStart, width: position.crossSize }
        return (
          <div
            key={`${divider.trackIndex}-${divider.beforePane}-${divider.afterPane}`}
            className={`pane-divider-handle pane-divider-${axis} ${activeDivider === dividerIndex ? 'active' : ''}`}
            style={style}
            role="separator"
            aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
            aria-label={axis === 'x' ? 'Resize panes left or right' : 'Resize panes up or down'}
            tabIndex={0}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              const rects = dividerRects(divider)
              if (!rects) return
              event.preventDefault()
              event.stopPropagation()
              event.currentTarget.setPointerCapture(event.pointerId)
              dragRef.current = {
                pointerId: event.pointerId,
                dividerIndex,
                startPointer: axis === 'x' ? event.clientX : event.clientY,
                ...rects,
                sizes: [...sizes],
              }
              setActiveDivider(dividerIndex)
              document.body.classList.add(axis === 'x' ? 'pane-resizing-x' : 'pane-resizing-y')
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (!drag || drag.pointerId !== event.pointerId || drag.dividerIndex !== dividerIndex) return
              event.preventDefault()
              const pointer = axis === 'x' ? event.clientX : event.clientY
              onSizesChange(resizedPair(
                divider,
                drag.sizes,
                drag.beforePixels,
                drag.afterPixels,
                pointer - drag.startPointer,
              ))
            }}
            onPointerUp={(event) => {
              if (dragRef.current?.pointerId !== event.pointerId) return
              event.currentTarget.releasePointerCapture(event.pointerId)
              finishResize()
            }}
            onPointerCancel={finishResize}
            onLostPointerCapture={finishResize}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
              const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
              if ((axis === 'x') !== (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return
              const rects = dividerRects(divider)
              if (!rects) return
              event.preventDefault()
              onSizesChange(resizedPair(divider, sizes, rects.beforePixels, rects.afterPixels, direction * 24))
            }}
          />
        )
      })}
    </div>
  )
}

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
  paneIndex,
  paneWeight,
  dragging,
  dragActive,
  onDragStartPanel,
  onDragEndPanel,
  onDropOnPanel,
  enableDesktopContextMenu,
  children,
}: {
  panelId: string
  paneIndex?: number
  paneWeight?: number
  dragging: boolean
  dragActive: boolean
  onDragStartPanel: () => void
  onDragEndPanel: () => void
  onDropOnPanel: (after: boolean) => void
  enableDesktopContextMenu: boolean
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [dragOverAfter, setDragOverAfter] = useState(false)
  const dragOverAfterRef = useRef(false)
  return (
    <div
      ref={ref}
      data-desktop-context-key={enableDesktopContextMenu ? panelId : undefined}
      data-pane-index={paneIndex}
      style={paneWeight === undefined ? undefined : { '--pane-weight': paneWeight } as CSSProperties}
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

type BrowserConnectionState = 'starting' | 'ready' | 'closed' | 'error'

interface BrowserNavigationResult {
  ok?: boolean
  url?: string
  mode?: BrowserResolvedMode
  requestedMode?: BrowserModePreference
  opencliSession?: string | null
  opencliProfile?: string | null
  externalSite?: Pick<ExternalSiteRule, 'id' | 'label' | 'reason'> | null
  error?: string
}

interface OpenCliComponentStatus {
  installed: boolean
  ready: boolean
  installable: boolean
  state: string
  path?: string
  version?: string
  source?: string
  nodeVersion?: string
  daemonRunning?: boolean
  daemonVersion?: string
  nodeChromeRunning?: boolean
  profile?: string
  extensionConnected?: boolean
  extensionVersion?: string
  message?: string
  error?: string | null
}

async function loadOpenCliStatus(): Promise<OpenCliComponentStatus> {
  const response = await fetch('/store/browser/opencli/status')
  const status = await response.json() as OpenCliComponentStatus
  if (!response.ok) throw new Error(status.error || 'Unable to check OpenCLI Browser Bridge')
  return status
}

function waitForBrowserSetup(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
}

type BrowserBookmarkDraft = {
  id: string | null
  title: string
  url: string
  createdAt: string
}

function BrowserBookmarkStarIcon({ filled = false }: { filled?: boolean }) {
  return (
    <svg
      className="browser-bookmark-star-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 1.65l1.92 3.9 4.3.62-3.11 3.03.73 4.28L8 11.46l-3.84 2.02.73-4.28-3.11-3.03 4.3-.62L8 1.65z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function BrowserBookmarksIcon() {
  return (
    <svg
      className="browser-bookmarks-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5.25 2.25h7c.55 0 1 .45 1 1v10.5L9.25 11.3l-4 2.45V3.25c0-.55.45-1 1-1z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M2.75 4v10.25l3.7-2.25"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity=".72"
      />
    </svg>
  )
}

function BrowserView({
  sessionId,
  modePreference,
  persistedAddress,
  persistedDisplayAddress,
  onModePreferenceChange,
  onAddressStateChange,
  onConnectionStateChange,
  bookmarks,
  bookmarksReady,
  bookmarksError,
  onBookmarksChange,
  pasteControlRef,
  onPasteAvailabilityChange,
}: {
  sessionId: string
  modePreference: BrowserModePreference
  persistedAddress?: string
  persistedDisplayAddress?: string
  onModePreferenceChange: (mode: BrowserModePreference) => void
  onAddressStateChange: (address: string, displayAddress: string) => void
  onConnectionStateChange?: (state: BrowserConnectionState) => void
  bookmarks: BrowserBookmark[]
  bookmarksReady: boolean
  bookmarksError: string | null
  onBookmarksChange: (bookmarks: BrowserBookmark[]) => Promise<void>
  pasteControlRef: { current: (() => void) | null }
  onPasteAvailabilityChange: (available: boolean) => void
}) {
  const initialAddressStateRef = useRef<BrowserAddressState | null>(null)
  if (initialAddressStateRef.current === null) {
    initialAddressStateRef.current = initialBrowserAddressState(persistedAddress, persistedDisplayAddress)
  }
  const initialRouteRef = useRef(
    initialAddressStateRef.current.displayAddress === 'about:blank'
      ? initialAddressStateRef.current.address
      : initialAddressStateRef.current.displayAddress,
  )
  const initialResolvedModeRef = useRef<BrowserResolvedMode>(
    resolveBrowserMode(modePreference, initialRouteRef.current).mode,
  )
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const selkiesRef = useRef<SelkiesClient | null>(null)
  const modePreferenceRef = useRef(modePreference)
  const resolvedModeRef = useRef<BrowserResolvedMode>(initialResolvedModeRef.current)
  const navigationSequenceRef = useRef(0)
  const openCliSetupPromiseRef = useRef<Promise<boolean> | null>(null)
  const onModePreferenceChangeRef = useRef(onModePreferenceChange)
  const onAddressStateChangeRef = useRef(onAddressStateChange)
  const [browserAddressState, setBrowserAddressState] = useState<BrowserAddressState>(
    initialAddressStateRef.current,
  )
  const browserAddressStateRef = useRef(browserAddressState)
  const { address, displayAddress } = browserAddressState
  const [resolvedMode, setResolvedMode] = useState<BrowserResolvedMode>(
    initialResolvedModeRef.current,
  )
  const [sessionRestoreComplete, setSessionRestoreComplete] = useState(false)
  const [opencliSession, setOpencliSession] = useState<string | null>(null)
  const [opencliProfile, setOpencliProfile] = useState<string | null>(null)
  const [openCliSetup, setOpenCliSetup] = useState<OpenCliComponentStatus | null>(null)
  const [connectionState, setConnectionState] = useState<BrowserConnectionState>('starting')
  const [statusMessage, setStatusMessage] = useState('Restoring Browser session...')
  const [externalDisplayOwned, setExternalDisplayOwned] = useState(false)
  const bookmarkMenuRef = useRef<HTMLDivElement | null>(null)
  const [bookmarkMenuOpen, setBookmarkMenuOpen] = useState(false)
  const [bookmarkSearch, setBookmarkSearch] = useState('')
  const [bookmarkDraft, setBookmarkDraft] = useState<BrowserBookmarkDraft | null>(null)
  const [bookmarkBusy, setBookmarkBusy] = useState(false)
  const [bookmarkActionError, setBookmarkActionError] = useState<string | null>(null)
  const externalControlReady = resolvedMode === 'external'
    && externalBrowserControlReady(opencliSession, Boolean(openCliSetup))
  const effectiveConnectionState = externalControlReady ? 'ready' : connectionState
  const currentPageUrl = normalizeBrowserBookmarkUrl(
    displayAddress === 'about:blank' ? address : displayAddress,
  )
  const currentBookmark = currentPageUrl
    ? browserBookmarkForUrl(bookmarks, currentPageUrl)
    : null
  const filteredBookmarks = bookmarks.filter((bookmark) => (
    browserBookmarkMatches(bookmark, bookmarkSearch)
  ))

  useEffect(() => {
    if (!bookmarkMenuOpen) return
    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      if (!bookmarkMenuRef.current?.contains(event.target as Node)) {
        setBookmarkMenuOpen(false)
        setBookmarkDraft(null)
      }
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setBookmarkMenuOpen(false)
      setBookmarkDraft(null)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [bookmarkMenuOpen])

  function editBookmark(bookmark: BrowserBookmark | null) {
    if (!bookmarksReady) return
    const now = new Date().toISOString()
    if (bookmark) {
      setBookmarkDraft({
        id: bookmark.id,
        title: bookmark.title,
        url: bookmark.url,
        createdAt: bookmark.createdAt,
      })
    } else {
      setBookmarkDraft({
        id: null,
        title: currentPageUrl ? browserBookmarkTitle(currentPageUrl) : '',
        url: currentPageUrl ?? '',
        createdAt: now,
      })
    }
    setBookmarkActionError(null)
    setBookmarkMenuOpen(true)
  }

  async function saveBookmarkDraft() {
    if (!bookmarkDraft || bookmarkBusy) return
    const title = bookmarkDraft.title.trim()
    const url = normalizeBrowserBookmarkUrl(bookmarkDraft.url)
    if (!title) {
      setBookmarkActionError('Enter a bookmark name.')
      return
    }
    if (!url) {
      setBookmarkActionError('Enter a valid http or https URL.')
      return
    }
    const duplicate = bookmarks.find((bookmark) => (
      bookmark.url === url && bookmark.id !== bookmarkDraft.id
    ))
    if (duplicate) {
      setBookmarkActionError(`This URL is already saved as “${duplicate.title}”.`)
      return
    }
    const now = new Date().toISOString()
    const bookmark: BrowserBookmark = {
      id: bookmarkDraft.id ?? makeId('bookmark'),
      title,
      url,
      createdAt: bookmarkDraft.createdAt || now,
      updatedAt: now,
    }
    setBookmarkBusy(true)
    setBookmarkActionError(null)
    try {
      await onBookmarksChange(upsertBrowserBookmark(bookmarks, bookmark))
      setBookmarkDraft(null)
    } catch (error) {
      setBookmarkActionError(error instanceof Error ? error.message : 'Unable to save bookmark')
    } finally {
      setBookmarkBusy(false)
    }
  }

  async function removeBookmark(bookmark: BrowserBookmark) {
    if (bookmarkBusy || !window.confirm(`Delete bookmark “${bookmark.title}”?`)) return
    setBookmarkBusy(true)
    setBookmarkActionError(null)
    try {
      await onBookmarksChange(bookmarks.filter((candidate) => candidate.id !== bookmark.id))
      if (bookmarkDraft?.id === bookmark.id) setBookmarkDraft(null)
    } catch (error) {
      setBookmarkActionError(error instanceof Error ? error.message : 'Unable to delete bookmark')
    } finally {
      setBookmarkBusy(false)
    }
  }

  useEffect(() => {
    modePreferenceRef.current = modePreference
  }, [modePreference])

  useEffect(() => {
    onModePreferenceChangeRef.current = onModePreferenceChange
  }, [onModePreferenceChange])

  useEffect(() => {
    onAddressStateChangeRef.current = onAddressStateChange
  }, [onAddressStateChange])

  useEffect(() => {
    onConnectionStateChange?.(effectiveConnectionState)
  }, [effectiveConnectionState, onConnectionStateChange])

  const send = useCallback((payload: Record<string, unknown>) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
  }, [])

  const applyBrowserAddressState = useCallback((next: BrowserAddressState) => {
    const current = browserAddressStateRef.current
    if (current.address === next.address && current.displayAddress === next.displayAddress && current.draft === next.draft) {
      return
    }
    browserAddressStateRef.current = next
    setBrowserAddressState(next)
    onAddressStateChangeRef.current(next.address, next.displayAddress)
  }, [])

  useEffect(() => {
    let mounted = true
    const restore = async () => {
      let snapshot = null
      try {
        const response = await fetch('/store/browser/sessions', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        })
        if (response.ok) {
          snapshot = findBrowserSessionSnapshot(await response.json(), sessionId)
        }
      } catch {
        // A failed listing must not prevent Embedded Browser from reconnecting
        // through its normal control socket. External mode remains idle so the
        // user can explicitly start a genuinely missing session with Go.
      }
      if (!mounted) return

      if (snapshot) {
        if (snapshot.requestedMode && snapshot.requestedMode !== modePreferenceRef.current) {
          modePreferenceRef.current = snapshot.requestedMode
          onModePreferenceChangeRef.current(snapshot.requestedMode)
        }
        resolvedModeRef.current = snapshot.mode
        setResolvedMode(snapshot.mode)
        applyBrowserAddressState(observeBrowserAddress(browserAddressStateRef.current, snapshot.url))
        setOpencliSession(snapshot.opencliSession ?? null)
        setOpencliProfile(snapshot.opencliProfile ?? null)
        setOpenCliSetup(null)
        setConnectionState('starting')
        setStatusMessage(snapshot.mode === 'external'
          ? 'Reattaching to existing External Chrome...'
          : 'Reattaching to existing Embedded Browser...')
      } else if (resolvedModeRef.current === 'external') {
        setConnectionState('closed')
        setStatusMessage('No running External Chrome session. Press Go to open this address.')
      } else {
        setStatusMessage('Preparing WebRTC browser...')
      }
      setSessionRestoreComplete(true)
    }
    void restore()
    return () => {
      mounted = false
    }
  }, [applyBrowserAddressState, sessionId])

  const ensureOpenCliReady = useCallback((): Promise<boolean> => {
    if (openCliSetupPromiseRef.current) return openCliSetupPromiseRef.current
    const setup = (async () => {
      let status = await loadOpenCliStatus()
      if (status.ready) {
        setOpenCliSetup(null)
        return true
      }
      setOpenCliSetup(status)

      if (!status.installed && !status.installable) {
        throw new Error(status.error || status.message || 'OpenCLI cannot be installed automatically on this host')
      }

      const approved = window.confirm(status.installed
        ? 'Start Agent Rider’s node-local External Chrome in this Browser panel? If its OpenCLI Browser Bridge is not enabled yet, Chrome will show the official Web Store and ask you to approve the extension once.'
        : 'Install OpenCLI in Agent Rider’s node user-data directory and start its node-local External Chrome in this Browser panel? No sudo is required. Chrome will ask you to approve the Browser Bridge extension once.')
      if (!approved) {
        setStatusMessage('OpenCLI setup cancelled. Choose Embedded mode or retry External Chrome when ready.')
        return false
      }

      setConnectionState('starting')
      setStatusMessage(status.installed
        ? 'Starting node-local External Chrome...'
        : 'Installing OpenCLI and starting node-local External Chrome...')
      const response = await fetch('/store/browser/opencli/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId: sessionId }),
      })
      status = await response.json() as OpenCliComponentStatus
      setOpenCliSetup(status)
      if (!response.ok || !status.installed) {
        throw new Error(status.error || 'Automatic OpenCLI installation failed')
      }

      if (status.ready) {
        setOpenCliSetup(null)
        return true
      }

      setStatusMessage(status.message || 'Waiting for OpenCLI Browser Bridge...')
      for (let attempt = 0; attempt < 150; attempt += 1) {
        if (resolvedModeRef.current !== 'external') return false
        await waitForBrowserSetup(2000)
        status = await loadOpenCliStatus()
        setOpenCliSetup(status)
        setStatusMessage(status.message || 'Waiting for OpenCLI Browser Bridge...')
        if (status.ready) {
          setOpenCliSetup(null)
          return true
        }
      }
      throw new Error(status.message || 'OpenCLI is installed, but Browser Bridge did not connect in time')
    })()
    const tracked = setup.finally(() => {
      if (openCliSetupPromiseRef.current === tracked) {
        openCliSetupPromiseRef.current = null
      }
    })
    openCliSetupPromiseRef.current = tracked
    return tracked
  }, [sessionId])

  const navigateBrowser = useCallback(async (
    destination: string,
    preference: BrowserModePreference = modePreferenceRef.current,
  ) => {
    const sequence = ++navigationSequenceRef.current
    const predicted = resolveBrowserMode(preference, destination)
    if (predicted.mode === 'external' || resolvedModeRef.current === 'embedded') {
      resolvedModeRef.current = predicted.mode
      setResolvedMode(predicted.mode)
    }
    setConnectionState('starting')
    setStatusMessage(
      predicted.mode === 'external'
        ? `Opening ${predicted.rule?.label ?? 'page'} in External Chrome...`
        : 'Navigating Embedded Browser...',
    )
    try {
      if (predicted.mode === 'external') {
        const ready = await ensureOpenCliReady()
        if (sequence !== navigationSequenceRef.current || !ready) {
          if (!ready && sequence === navigationSequenceRef.current) {
            setConnectionState('error')
          }
          return
        }
      } else {
        setOpenCliSetup(null)
      }
      const response = await fetch('/store/browser/navigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          windowId: sessionId,
          url: destination,
          mode: preference,
        }),
      })
      const result = await response.json() as BrowserNavigationResult
      if (sequence !== navigationSequenceRef.current) return
      if (!response.ok || !result.ok || !result.mode || !result.url) {
        throw new Error(result.error || 'Browser navigation failed')
      }
      resolvedModeRef.current = result.mode
      setResolvedMode(result.mode)
      applyBrowserAddressState(commitBrowserAddress(result.url))
      setOpencliSession(result.opencliSession ?? null)
      setOpencliProfile(result.opencliProfile ?? null)
      setOpenCliSetup(null)
      setConnectionState('ready')
      if (result.mode === 'external') externalBrowserDisplayCoordinator.activate(sessionId)
      setStatusMessage(
        result.mode === 'external'
          ? 'External Chrome is open and available to agents through OpenCLI'
          : 'Embedded Browser navigation ready',
      )
    } catch (error) {
      if (sequence !== navigationSequenceRef.current) return
      setConnectionState('error')
      setStatusMessage(error instanceof Error ? error.message : String(error))
    }
  }, [applyBrowserAddressState, ensureOpenCliReady, sessionId])

  const reloadBrowser = useCallback(() => {
    if (resolvedMode === 'external') {
      externalBrowserDisplayCoordinator.activate(sessionId)
      void navigateBrowser(displayAddress === 'about:blank' ? address : displayAddress)
      return
    }
    send({ type: 'reload' })
    requestAnimationFrame(() => selkiesRef.current?.requestResize())
    window.setTimeout(() => selkiesRef.current?.requestResize(), 250)
  }, [address, displayAddress, navigateBrowser, resolvedMode, send, sessionId])

  const pasteIntoBrowser = useCallback(async () => {
    let clipboardText: string
    try {
      clipboardText = await readClipboardText()
    } catch {
      setStatusMessage('Browser clipboard read was denied. Click the page and press Ctrl+V instead.')
      return
    }

    const plan = prepareBrowserPaste(clipboardText)
    if (plan.text === null) {
      setStatusMessage(plan.error ?? 'Browser clipboard is empty')
      return
    }

    if (resolvedMode === 'external') {
      // External Chrome has no control socket; its paste rides the shared
      // WebRTC data channel, so claim the display before sending the chord.
      externalBrowserDisplayCoordinator.activate(sessionId)
      if (!selkiesRef.current?.paste(plan.text)) {
        setStatusMessage('External Chrome display is not connected yet')
        return
      }
    } else {
      send({ type: 'paste', text: plan.text })
    }
    setStatusMessage('Pasted clipboard text into the focused page field')
  }, [resolvedMode, send, sessionId])

  useEffect(() => {
    pasteControlRef.current = () => { void pasteIntoBrowser() }
    return () => {
      pasteControlRef.current = null
    }
  }, [pasteControlRef, pasteIntoBrowser])

  useEffect(() => {
    if (!sessionRestoreComplete || resolvedMode !== 'embedded') {
      return
    }
    let mounted = true
    let reconnectTimer: number | null = null
    let rtcReconnectTimer: number | null = null
    let reconnectAttempt = 0
    let rtcReconnectAttempt = 0
    let controlReady = false

    const scheduleRtcReconnect = () => {
      if (!mounted || !controlReady || rtcReconnectTimer !== null) return
      rtcReconnectAttempt += 1
      const delay = Math.min(1000 * 2 ** (rtcReconnectAttempt - 1), 5000)
      rtcReconnectTimer = window.setTimeout(() => {
        rtcReconnectTimer = null
        startRtc()
      }, delay)
    }

    const startRtc = () => {
      const video = videoRef.current
      const viewport = viewportRef.current
      if (!mounted || !controlReady || !video || !viewport) return
      selkiesRef.current?.disconnect()
      setConnectionState('starting')
      setStatusMessage(rtcReconnectAttempt ? 'Reconnecting WebRTC browser...' : 'Negotiating WebRTC browser...')
      const client = new SelkiesClient(video, sessionId, {
        onStateChange: (state) => {
          if (!mounted || selkiesRef.current !== client) return
          if (state === 'connected') {
            rtcReconnectAttempt = 0
            setConnectionState('ready')
          } else if (state === 'failed') {
            setConnectionState('error')
            scheduleRtcReconnect()
          } else if (state === 'disconnected') {
            setConnectionState('closed')
            scheduleRtcReconnect()
          }
        },
        onStatus: (message) => {
          if (mounted && selkiesRef.current === client) setStatusMessage(message)
        },
        onError: (message) => {
          if (!mounted || selkiesRef.current !== client) return
          setConnectionState('error')
          setStatusMessage(message)
          scheduleRtcReconnect()
        },
        onClipboard: (text) => {
          if (!mounted || selkiesRef.current !== client) return
          void copyToClipboard(text)
            .then(() => setStatusMessage('Copied browser selection'))
            .catch(() => setStatusMessage('Browser clipboard copy was denied'))
        },
        onPaste: (text) => {
          if (!mounted || selkiesRef.current !== client) return
          send({ type: 'paste', text })
          // Ctrl/Cmd+V leaves no visible trace when the page swallows the text,
          // so report it the same way the toolbar Paste button does.
          setStatusMessage('Pasted clipboard text into the focused page field')
        },
      }, viewport)
      selkiesRef.current = client
      void client.connect().catch((error) => {
        if (!mounted || selkiesRef.current !== client) return
        setConnectionState('error')
        setStatusMessage(error instanceof Error ? error.message : String(error))
        scheduleRtcReconnect()
      })
    }

    const connect = () => {
      if (!mounted) return
      controlReady = false
      setConnectionState('starting')
      setStatusMessage(reconnectAttempt ? 'Reconnecting browser control...' : 'Preparing WebRTC browser...')
      const endpoint = new URL('/store/browser/ws', window.location.href)
      endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
      endpoint.searchParams.set('window', sessionId)
      const socket = new WebSocket(endpoint)
      socketRef.current = socket
      socket.onopen = () => {
        reconnectAttempt = 0
      }
      socket.onmessage = (event) => {
        if (!mounted || socketRef.current !== socket) return
        if (typeof event.data !== 'string') return
        try {
          const message = JSON.parse(event.data) as { type?: string; message?: string; url?: string }
          if (message.type === 'ready') {
            controlReady = true
            startRtc()
          }
          if (message.type === 'error') setConnectionState('error')
          if (message.message) setStatusMessage(message.message)
          if ((message.type === 'ready' || message.type === 'url') && message.url) {
            applyBrowserAddressState(observeBrowserAddress(browserAddressStateRef.current, message.url))
            const resolution = resolveBrowserMode(modePreferenceRef.current, message.url)
            if (resolution.mode === 'external') {
              void navigateBrowser(message.url, modePreferenceRef.current)
            }
          }
        } catch {
          setConnectionState('error')
          setStatusMessage('Invalid browser control response')
        }
      }
      socket.onclose = () => {
        if (!mounted || socketRef.current !== socket) return
        controlReady = false
        selkiesRef.current?.disconnect()
        selkiesRef.current = null
        socketRef.current = null
        setConnectionState('closed')
        reconnectAttempt += 1
        const delay = Math.min(500 * 2 ** (reconnectAttempt - 1), 5000)
        setStatusMessage(`Browser control disconnected; reconnecting in ${Math.ceil(delay / 1000)}s...`)
        reconnectTimer = window.setTimeout(connect, delay)
      }
      socket.onerror = () => {
        if (!mounted || socketRef.current !== socket) return
        setConnectionState('error')
        setStatusMessage('Unable to connect to browser session')
      }
    }

    connect()
    return () => {
      mounted = false
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      if (rtcReconnectTimer !== null) window.clearTimeout(rtcReconnectTimer)
      selkiesRef.current?.disconnect()
      selkiesRef.current = null
      const socket = socketRef.current
      socketRef.current = null
      socket?.close()
    }
  }, [applyBrowserAddressState, navigateBrowser, resolvedMode, sessionId, sessionRestoreComplete])

  const externalStreamReady = resolvedMode === 'external'
    && Boolean(openCliSetup?.nodeChromeRunning || opencliSession)
  const externalSetupActive = Boolean(openCliSetup)
  const pasteAvailable = browserPasteAvailable(
    resolvedMode,
    connectionState === 'ready',
    externalStreamReady,
    externalDisplayOwned,
  )

  useEffect(() => {
    onPasteAvailabilityChange(pasteAvailable)
  }, [onPasteAvailabilityChange, pasteAvailable])

  useEffect(() => {
    if (!sessionRestoreComplete || !externalStreamReady) {
      setExternalDisplayOwned(false)
      return
    }
    return externalBrowserDisplayCoordinator.register(
      sessionId,
      opencliSession ? 'session' : 'setup',
      setExternalDisplayOwned,
    )
  }, [externalStreamReady, opencliSession, sessionId, sessionRestoreComplete])

  useEffect(() => {
    if (!sessionRestoreComplete || !externalStreamReady || externalDisplayOwned) return
    setConnectionState('closed')
    setStatusMessage(opencliSession
      ? 'Browser display is active in another Browser window. Click here to show it; page control and Reload remain available.'
      : 'External Chrome setup is visible in another Browser window. Click here to move the setup display.')
  }, [externalDisplayOwned, externalStreamReady, opencliSession, sessionRestoreComplete])

  useEffect(() => {
    if (!sessionRestoreComplete || !externalStreamReady || !externalDisplayOwned) return
    let mounted = true
    let reconnectTimer: number | null = null
    let reconnectAttempt = 0

    const connect = () => {
      const video = videoRef.current
      const viewport = viewportRef.current
      if (!mounted || !video || !viewport) return
      selkiesRef.current?.disconnect()
      const client = new SelkiesClient(video, sessionId, {
        onStateChange: (state) => {
          if (!mounted || selkiesRef.current !== client) return
          if (state === 'connected') {
            reconnectAttempt = 0
            if (!externalSetupActive) setConnectionState('ready')
          } else if (state === 'failed' || state === 'disconnected') {
            if (!externalSetupActive) {
              setConnectionState(state === 'failed' ? 'error' : 'closed')
              setStatusMessage(state === 'failed'
                ? 'Browser display failed; page control and Reload remain available. Reconnecting...'
                : 'Browser display disconnected; page control and Reload remain available. Reconnecting...')
            }
            scheduleReconnect()
          }
        },
        onStatus: (message) => {
          if (mounted && selkiesRef.current === client && !externalSetupActive) {
            setStatusMessage(message)
          }
        },
        onError: (message) => {
          if (!mounted || selkiesRef.current !== client) return
          if (!externalSetupActive) {
            setConnectionState('error')
            setStatusMessage(opencliSession
              ? `${message}. Page control and Reload remain available.`
              : message)
          }
          scheduleReconnect()
        },
        onClipboard: (text) => {
          if (!mounted || selkiesRef.current !== client) return
          void copyToClipboard(text)
            .then(() => setStatusMessage('Copied External Chrome selection'))
            .catch(() => setStatusMessage('External Chrome clipboard copy was denied'))
        },
      }, viewport)
      selkiesRef.current = client
      void client.connect().catch((error) => {
        if (!mounted || selkiesRef.current !== client) return
        if (!externalSetupActive) {
          setConnectionState('error')
          const message = error instanceof Error ? error.message : String(error)
          setStatusMessage(opencliSession
            ? `${message}. Page control and Reload remain available.`
            : message)
        }
        scheduleReconnect()
      })
    }

    const scheduleReconnect = () => {
      if (!mounted || reconnectTimer !== null) return
      reconnectAttempt += 1
      const delay = Math.min(1000 * 2 ** (reconnectAttempt - 1), 5000)
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    connect()
    return () => {
      mounted = false
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      selkiesRef.current?.disconnect()
      selkiesRef.current = null
    }
  }, [externalDisplayOwned, externalSetupActive, externalStreamReady, opencliSession, sessionId, sessionRestoreComplete])

  function changeMode(nextMode: BrowserModePreference) {
    modePreferenceRef.current = nextMode
    onModePreferenceChange(nextMode)
    void navigateBrowser(displayAddress === 'about:blank' ? address : displayAddress, nextMode)
  }

  const modeLabel = resolvedMode === 'external' ? 'External Chrome' : 'Embedded Browser'

  return (
    <div className="conversation-browser">
      <div ref={bookmarkMenuRef} className="browser-toolbar-shell">
        <form
          className="browser-toolbar"
          onSubmit={(event) => {
            event.preventDefault()
            void navigateBrowser(address)
          }}
        >
          <span className={`browser-state ${effectiveConnectionState}`} title={statusMessage} />
          <select
            value={modePreference}
            onChange={(event) => changeMode(event.target.value as BrowserModePreference)}
            aria-label="Browser mode"
            title={`Current route: ${modeLabel}`}
          >
            <option value="auto">Auto</option>
            <option value="embedded">Embedded</option>
            <option value="external">External Chrome</option>
          </select>
          <input
            value={address}
            onChange={(event) => applyBrowserAddressState(editBrowserAddress(browserAddressStateRef.current, event.target.value))}
            aria-label="Browser address"
            spellCheck={false}
          />
          <button type="submit" className="browser-go" disabled={connectionState === 'starting'}>Go</button>
          <button
            type="button"
            className={`browser-bookmark-current ${currentBookmark ? 'active' : ''}`}
            disabled={!bookmarksReady || !currentPageUrl}
            aria-label={currentBookmark ? 'Edit bookmark for current page' : 'Bookmark current page'}
            aria-pressed={Boolean(currentBookmark)}
            title={currentBookmark ? `Edit bookmark “${currentBookmark.title}”` : 'Bookmark current page'}
            onClick={() => editBookmark(currentBookmark)}
          >
            <BrowserBookmarkStarIcon filled={Boolean(currentBookmark)} />
          </button>
          <button
            type="button"
            className={`browser-bookmarks-toggle ${bookmarkMenuOpen ? 'active' : ''}`}
            aria-label={`Open bookmarks (${bookmarks.length} saved)`}
            aria-expanded={bookmarkMenuOpen}
            aria-controls={`browser-bookmarks-${sessionId}`}
            disabled={!bookmarksReady && !bookmarksError}
            title={!bookmarksReady && !bookmarksError
              ? 'Loading Browser bookmarks'
              : bookmarksError ?? `Open ${bookmarks.length} saved bookmarks`}
            onClick={() => {
              setBookmarkDraft(null)
              setBookmarkActionError(null)
              setBookmarkMenuOpen((open) => !open)
            }}
          >
            <BrowserBookmarksIcon />
            {bookmarks.length ? (
              <span className="browser-bookmarks-count" aria-hidden="true">{bookmarks.length}</span>
            ) : null}
          </button>
          <button
            type="button"
            className="browser-reload"
            disabled={!browserReloadAvailable(
              resolvedMode,
              connectionState === 'ready',
              opencliSession,
              externalSetupActive,
            )}
            onClick={reloadBrowser}
          >Reload</button>
        </form>
        {bookmarkMenuOpen ? (
          <div
            id={`browser-bookmarks-${sessionId}`}
            className="browser-bookmark-menu"
            role="dialog"
            aria-label="Browser bookmarks"
          >
            <div className="browser-bookmark-head">
              <div>
                <strong>Bookmarks</strong>
                <span>{bookmarks.length} saved</span>
              </div>
              <button
                type="button"
                aria-label="Close bookmarks"
                onClick={() => {
                  setBookmarkMenuOpen(false)
                  setBookmarkDraft(null)
                }}
              >×</button>
            </div>
            {bookmarkDraft ? (
              <form
                className="browser-bookmark-editor"
                onSubmit={(event) => {
                  event.preventDefault()
                  void saveBookmarkDraft()
                }}
              >
                <label>
                  <span>Name</span>
                  <input
                    value={bookmarkDraft.title}
                    maxLength={200}
                    autoFocus
                    onChange={(event) => setBookmarkDraft({ ...bookmarkDraft, title: event.target.value })}
                  />
                </label>
                <label>
                  <span>URL</span>
                  <input
                    value={bookmarkDraft.url}
                    spellCheck={false}
                    onChange={(event) => setBookmarkDraft({ ...bookmarkDraft, url: event.target.value })}
                  />
                </label>
                {bookmarkActionError ? <div className="browser-bookmark-error">{bookmarkActionError}</div> : null}
                <div className="browser-bookmark-editor-actions">
                  <button type="button" disabled={bookmarkBusy} onClick={() => setBookmarkDraft(null)}>Cancel</button>
                  <button type="submit" className="primary" disabled={bookmarkBusy}>
                    {bookmarkBusy ? 'Saving…' : bookmarkDraft.id ? 'Save changes' : 'Add bookmark'}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <div className="browser-bookmark-tools">
                  <input
                    type="search"
                    value={bookmarkSearch}
                    onChange={(event) => setBookmarkSearch(event.target.value)}
                    placeholder="Search bookmarks"
                    aria-label="Search bookmarks"
                  />
                  <button type="button" disabled={!bookmarksReady} onClick={() => editBookmark(currentBookmark)}>
                    {currentBookmark ? 'Edit current' : currentPageUrl ? 'Add current' : 'New bookmark'}
                  </button>
                </div>
                {bookmarkActionError || bookmarksError ? (
                  <div className="browser-bookmark-error">{bookmarkActionError ?? bookmarksError}</div>
                ) : null}
                <div className="browser-bookmark-list">
                  {filteredBookmarks.map((bookmark) => (
                    <div key={bookmark.id} className="browser-bookmark-item">
                      <button
                        type="button"
                        className="browser-bookmark-open"
                        title={`Open ${bookmark.url}`}
                        onClick={() => {
                          setBookmarkMenuOpen(false)
                          void navigateBrowser(bookmark.url)
                        }}
                      >
                        <strong>{bookmark.title}</strong>
                        <span>{bookmark.url}</span>
                      </button>
                      <div className="browser-bookmark-actions">
                        <button type="button" disabled={bookmarkBusy} onClick={() => editBookmark(bookmark)}>Edit</button>
                        <button type="button" className="danger" disabled={bookmarkBusy} onClick={() => { void removeBookmark(bookmark) }}>Delete</button>
                      </div>
                    </div>
                  ))}
                  {!filteredBookmarks.length ? (
                    <div className="browser-bookmark-empty">
                      {bookmarks.length ? 'No bookmarks match this search.' : 'No bookmarks yet. Save the current page to get started.'}
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
      <div
        ref={viewportRef}
        className={`browser-viewport ${resolvedMode}`}
        onPointerDownCapture={() => {
          if (externalStreamReady) externalBrowserDisplayCoordinator.activate(sessionId)
        }}
        onFocusCapture={() => {
          if (externalStreamReady) externalBrowserDisplayCoordinator.activate(sessionId)
        }}
      >
        {resolvedMode === 'embedded' || externalStreamReady ? (
          <video
            ref={videoRef}
            tabIndex={0}
            aria-label={resolvedMode === 'external'
              ? 'Interactive node-local External Chrome'
              : 'Interactive browser page'}
            autoPlay
            muted
            playsInline
          />
        ) : null}
        {resolvedMode === 'external' && openCliSetup ? (
          <div className="browser-external-setup">
            <strong>Finish setup in this node-local Chrome</strong>
            <span>{openCliSetup.message}</span>
            {openCliSetup.installed ? (
              <code>
                OpenCLI {openCliSetup.version ? `v${openCliSetup.version}` : 'installed'}
                {' · '}
                {openCliSetup.extensionConnected ? 'Browser Bridge connected' : 'waiting for Browser Bridge'}
              </code>
            ) : null}
            <small>
              Chrome requires one explicit extension-permission approval. Agent Rider detects it automatically and then opens the requested page in this same Browser panel.
            </small>
          </div>
        ) : null}
        {resolvedMode === 'external' && opencliSession && !openCliSetup ? (
          <div className="browser-external-session" title="Exact OpenCLI agent-control session">
            <span>Node Chrome · agent control active</span>
            <code>
              opencli {opencliProfile ? `--profile ${opencliProfile} ` : ''}
              browser {opencliSession} state
            </code>
          </div>
        ) : null}
        {connectionState !== 'ready' && !openCliSetup ? (
          <div className={`browser-status ${connectionState}`}>{statusMessage}</div>
        ) : null}
      </div>
      <div className="browser-footer" title={displayAddress}>
        <span className={`browser-mode-badge ${resolvedMode}`}>{modeLabel}</span>
        <span>{displayAddress}</span>
      </div>
    </div>
  )
}

function BrowserPanel({
  panelId,
  onClose,
  collapsed = false,
  fullWindow = false,
  browserMode = 'auto',
  browserAddress,
  browserUrl,
  bookmarks,
  bookmarksReady,
  bookmarksError,
  onBookmarksChange,
  onStateChange,
}: {
  panelId: string
  onClose: () => void
  collapsed?: boolean
  fullWindow?: boolean
  browserMode?: BrowserModePreference
  browserAddress?: string
  browserUrl?: string
  bookmarks: BrowserBookmark[]
  bookmarksReady: boolean
  bookmarksError: string | null
  onBookmarksChange: (bookmarks: BrowserBookmark[]) => Promise<void>
  onStateChange: (patch: WorkspacePanelState) => void
}) {
  const [connectionState, setConnectionState] = useState<BrowserConnectionState>('starting')
  const [pasteAvailable, setPasteAvailable] = useState(false)
  const [idCopyState, setIdCopyState] = useState<'copied' | 'error' | null>(null)
  const [promptCopyState, setPromptCopyState] = useState<'copied' | 'error' | null>(null)
  const pasteControlRef = useRef<(() => void) | null>(null)
  const idCopyResetTimerRef = useRef<number | null>(null)
  const promptCopyResetTimerRef = useRef<number | null>(null)
  const terminalState: TerminalConnectionState = connectionState === 'ready'
    ? 'connected'
    : connectionState === 'starting'
      ? 'connecting'
      : connectionState
  const tone = connectionStatusTone(terminalState)

  useEffect(() => () => {
    if (idCopyResetTimerRef.current !== null) window.clearTimeout(idCopyResetTimerRef.current)
    if (promptCopyResetTimerRef.current !== null) window.clearTimeout(promptCopyResetTimerRef.current)
  }, [])

  async function copyBrowserId() {
    try {
      await copyToClipboard(panelId)
      setIdCopyState('copied')
    } catch {
      setIdCopyState('error')
    }
    if (idCopyResetTimerRef.current !== null) window.clearTimeout(idCopyResetTimerRef.current)
    idCopyResetTimerRef.current = window.setTimeout(() => {
      setIdCopyState(null)
      idCopyResetTimerRef.current = null
    }, 1400)
  }

  async function copyBrowserPrompt() {
    try {
      await copyToClipboard(browserControlPrompt(panelId))
      setPromptCopyState('copied')
    } catch {
      setPromptCopyState('error')
    }
    if (promptCopyResetTimerRef.current !== null) window.clearTimeout(promptCopyResetTimerRef.current)
    promptCopyResetTimerRef.current = window.setTimeout(() => {
      setPromptCopyState(null)
      promptCopyResetTimerRef.current = null
    }, 1800)
  }

  function toggleCollapsed() {
    const next = !collapsed
    onStateChange({ collapsed: next, ...(next && fullWindow ? { fullWindow: false } : {}) })
  }

  function toggleFullWindow() {
    onStateChange({
      fullWindow: !fullWindow,
      ...(collapsed ? { collapsed: false } : {}),
    })
  }

  function closeBrowserWindow() {
    const endpoint = new URL('/store/browser/session', window.location.href)
    endpoint.searchParams.set('window', panelId)
    void fetch(endpoint, { method: 'DELETE' })
    onClose()
  }

  return (
    <section
      className={`web-terminal browser-panel ${collapsed ? 'collapsed' : ''} ${fullWindow ? 'full-window' : ''}`}
      aria-label={`Browser window ${panelId}`}
      data-browser-window-id={panelId}
    >
      <div className="win-titlebar">
        <WinGrip />
        <span className="win-dot" style={{ background: tone.dot }} aria-hidden />
        <span className="win-title browser-window-title">
          Browser ·{' '}
          <button
            type="button"
            className={`browser-id-copy ${idCopyState ?? ''}`}
            draggable
            title={`Click to copy or drag browser window ID: ${panelId}`}
            aria-label={`Copy browser window ID ${panelId}`}
            onDragStart={(event) => setInputTextDragData(event, panelId)}
            onClick={(event) => {
              event.stopPropagation()
              void copyBrowserId()
            }}
          >
            {panelId}
          </button>
        </span>
        <span className={`win-meta browser-id-copy-status ${idCopyState ?? ''}`} aria-live="polite">
          {idCopyState === 'copied' ? 'Copied' : idCopyState === 'error' ? 'Copy failed' : 'Window ID'}
        </span>
        <div className="win-spacer" />
        <span className="win-status" style={{ color: tone.color }}>{tone.label}</span>
        <button
          type="button"
          className="win-btn browser-menu-paste-btn"
          title="Paste clipboard text into the focused input on the page"
          aria-label={`Paste clipboard text into browser window ${panelId}`}
          disabled={collapsed || !pasteAvailable}
          onClick={(event) => {
            event.stopPropagation()
            pasteControlRef.current?.()
          }}
        >Paste</button>
        <button
          type="button"
          className={`win-btn browser-prompt-copy-btn ${promptCopyState ?? ''}`}
          title={promptCopyState === 'copied'
            ? 'Browser prompt copied'
            : promptCopyState === 'error'
              ? 'Prompt copy failed'
              : 'Prompt Copy'}
          aria-label={`Prompt Copy for browser window ${panelId}`}
          onClick={(event) => {
            event.stopPropagation()
            void copyBrowserPrompt()
          }}
        >
          {promptCopyState === 'copied' ? '✓' : <WinPromptIcon />}
        </button>
        <button
          type="button"
          className="win-btn"
          title={collapsed ? 'Expand window' : 'Collapse window'}
          aria-label={collapsed ? 'Expand window' : 'Collapse window'}
          aria-expanded={!collapsed}
          onClick={toggleCollapsed}
        >
          {collapsed ? <WinConversationExpandIcon /> : <WinConversationCollapseIcon />}
        </button>
        <button
          type="button"
          className="win-btn"
          title={fullWindow ? 'Exit full window' : 'Expand to full window'}
          aria-label={fullWindow ? 'Exit full window' : 'Expand to full window'}
          onClick={(event) => {
            event.stopPropagation()
            toggleFullWindow()
          }}
        >
          <WinFullscreenIcon active={fullWindow} />
        </button>
        <button
          type="button"
          className="win-btn win-btn-close"
          title="Close Browser"
          aria-label="Close Browser"
          onClick={(event) => {
            event.stopPropagation()
            closeBrowserWindow()
          }}
        >
          <WinCloseIcon />
        </button>
      </div>
      <div className="browser-panel-body" aria-hidden={collapsed}>
        <BrowserView
          sessionId={panelId}
          modePreference={browserMode}
          persistedAddress={browserAddress}
          persistedDisplayAddress={browserUrl}
          bookmarks={bookmarks}
          bookmarksReady={bookmarksReady}
          bookmarksError={bookmarksError}
          onBookmarksChange={onBookmarksChange}
          pasteControlRef={pasteControlRef}
          onPasteAvailabilityChange={setPasteAvailable}
          onModePreferenceChange={(mode) => onStateChange({ browserMode: mode })}
          onAddressStateChange={(address, displayAddress) => onStateChange({
            browserAddress: address,
            browserUrl: displayAddress,
          })}
          onConnectionStateChange={setConnectionState}
        />
      </div>
    </section>
  )
}

type TerminalInputSender = (value: string, submit?: boolean) => boolean

function AgentCollaborationControls({
  agentId,
  inputSenderRef,
}: {
  agentId: string
  inputSenderRef: { current: TerminalInputSender | null }
}) {
  const [promptSendState, setPromptSendState] = useState<'idle' | 'sent' | 'error'>('idle')

  return (
    <div className="agent-collaboration" onDoubleClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="agent-collaboration-id"
        draggable
        title={`Click to copy or drag Agent ID: ${agentId}`}
        aria-label={`Copy or drag Agent ID ${agentId}`}
        onDragStart={(event) => setInputTextDragData(event, agentId)}
        onClick={(event) => { event.stopPropagation(); void copyToClipboard(agentId) }}
      >
        {agentId}
      </button>
      <button
        type="button"
        className={`agent-collaboration-prompt ${promptSendState}`}
        title={promptSendState === 'sent'
          ? 'Prompt sent to this TUI'
          : promptSendState === 'error'
            ? 'TUI is not connected; click to retry'
            : 'Send collaboration prompt to this TUI'}
        onClick={(event) => {
          event.stopPropagation()
          const sent = sendAgentCollaborationPrompt(agentId, inputSenderRef.current)
          setPromptSendState(sent ? 'sent' : 'error')
        }}
      >
        {promptSendState === 'sent' ? 'Sent ✓' : promptSendState === 'error' ? 'Retry' : 'Prompt'}
      </button>
    </div>
  )
}

function AgentAppPanel({
  panelId,
  appId,
  appName = 'New App',
  appPort,
  appSplit = AGENT_APP_DEFAULT_SPLIT,
  appChatCollapsed = false,
  notepad,
  agentCommand,
  agentLabel,
  agentCommands,
  agentCommandAvailability,
  usedPorts,
  workspaceRoot,
  onNameCommit,
  onClose,
  collapsed = false,
  fullWindow = false,
  maximized = false,
  onToggleMaximize,
  onStateChange,
}: {
  panelId: string
  appId?: string
  appName?: string
  appPort?: number
  appSplit?: number
  appChatCollapsed?: boolean
  notepad?: string
  agentCommand: string
  agentLabel: string
  agentCommands: AgentCommand[]
  agentCommandAvailability: AgentCommandAvailability
  usedPorts: number[]
  workspaceRoot: string
  onNameCommit: (name: string) => void
  onClose: () => void
  collapsed?: boolean
  fullWindow?: boolean
  maximized?: boolean
  onToggleMaximize: () => void
  onStateChange: (patch: WorkspacePanelState) => void
}) {
  const panelRef = useRef<HTMLElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const inputSenderRef = useRef<TerminalInputSender | null>(null)
  const dragSplitRef = useRef<number | null>(null)
  const allocationRequestedRef = useRef(false)
  const [orientation, setOrientation] = useState<AgentAppOrientation>('wide')
  const [dragSplit, setDragSplit] = useState<number | null>(null)
  const [portError, setPortError] = useState('')
  const [appReady, setAppReady] = useState(false)
  const [frameKey, setFrameKey] = useState(() => Date.now())
  const [connectionState, setConnectionState] = useState<TerminalConnectionState>('connecting')
  const [promptStatus, setPromptStatus] = useState<'idle' | 'sent' | 'error'>('idle')
  const [promptAttention, setPromptAttention] = useState(true)
  const chatCollapsed = appChatCollapsed
  const split = clampAgentAppSplit(dragSplit ?? appSplit)
  const proxyUrl = agentAppProxyUrl(appPort, frameKey)
  const selectedAgentCommand = agentCommands.find((command) => command.command === agentCommand)
  const chatToggleDirection = orientation === 'wide'
    ? chatCollapsed ? 'right' : 'left'
    : chatCollapsed ? 'up' : 'down'

  useEffect(() => {
    setPromptStatus('idle')
  }, [agentCommand])

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const update = () => {
      const rect = panel.getBoundingClientRect()
      setOrientation(agentAppOrientation(rect.width, rect.height))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (appPort || allocationRequestedRef.current) return
    allocationRequestedRef.current = true
    let cancelled = false
    setPortError('')
    void allocateAgentAppPort(panelId, usedPorts)
      .then((allocation) => {
        if (!cancelled) onStateChange({ appPort: allocation.port })
      })
      .catch((error) => {
        if (cancelled) return
        allocationRequestedRef.current = false
        setPortError(error instanceof Error ? error.message : 'Unable to allocate an Agent App port')
      })
    return () => {
      cancelled = true
    }
    // The current exclusion list is a creation-time snapshot. Later allocations
    // must not cancel this request while it is in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appPort, panelId])

  useEffect(() => {
    if (!appPort) {
      setAppReady(false)
      return
    }
    let cancelled = false
    let timer: number | undefined
    const check = async () => {
      const ready = await agentAppPortReady(appPort)
      if (cancelled) return
      setAppReady((current) => {
        if (ready && !current) setFrameKey((key) => nextAgentAppFrameRevision(key))
        return ready
      })
      timer = window.setTimeout(check, 1500)
    }
    void check()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [appPort])

  useEffect(() => () => {
    document.body.classList.remove('agent-app-resizing-x', 'agent-app-resizing-y')
  }, [])

  function setCollapsed(next: boolean) {
    onStateChange({ collapsed: next, ...(next && fullWindow ? { fullWindow: false } : {}) })
  }

  function toggleFullWindow() {
    onStateChange({
      collapsed: false,
      fullWindow: collapsed ? true : !fullWindow,
    })
  }

  function ratioFromPointer(clientX: number, clientY: number) {
    const body = bodyRef.current
    if (!body) return null
    const rect = body.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return clampAgentAppSplit(
      orientation === 'wide'
        ? 1 - ((clientX - rect.left) / rect.width)
        : (clientY - rect.top) / rect.height,
    )
  }

  function finishSplitResize(pointerId?: number, handle?: HTMLElement) {
    if (pointerId !== undefined && handle?.hasPointerCapture(pointerId)) {
      handle.releasePointerCapture(pointerId)
    }
    const next = dragSplitRef.current
    if (next !== null) onStateChange({ appSplit: next })
    dragSplitRef.current = null
    setDragSplit(null)
    document.body.classList.remove('agent-app-resizing-x', 'agent-app-resizing-y')
  }

  function sendLaunchPrompt() {
    if (!appPort) return
    const sent = inputSenderRef.current?.(agentAppLaunchPrompt(appName, appPort), true) ?? false
    setPromptStatus(sent ? 'sent' : 'error')
    if (sent) setPromptAttention(false)
    window.setTimeout(() => setPromptStatus('idle'), 1800)
  }

  function commitName() {
    const name = appName.trim() || 'New App'
    if (name !== appName) onStateChange({ appName: name })
    onNameCommit(name)
  }

  const stateTone = connectionStatusTone(connectionState)
  const bodyStyle = {
    '--agent-app-view-share': `${split}fr`,
    '--agent-app-chat-share': `${1 - split}fr`,
  } as CSSProperties

  return (
    <section
      ref={panelRef}
      className={`agent-app-panel web-terminal ${orientation} ${collapsed ? 'collapsed' : ''} ${fullWindow ? 'full-window' : ''}`}
      aria-label={appName.trim() || 'New App'}
    >
      <div className="win-titlebar" onDoubleClick={() => setCollapsed(!collapsed)}>
        <WinGrip />
        <span className="win-dot" style={{ background: appReady ? '#46c98b' : stateTone.dot }} aria-hidden />
        <input
          className="win-title-input agent-app-title-input"
          value={appName}
          onChange={(event) => onStateChange({ appName: event.target.value.slice(0, 120) })}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
          }}
          placeholder="New App"
          aria-label="Agent App name"
          size={Math.max(8, Math.min(32, (appName || 'New App').length + 1))}
        />
        <span className="agent-app-kind-title">Agent App</span>
        <span className="win-meta">
          {appId ? `${appId} · ` : ''}{appPort ? `PORT ${appPort}` : portError ? 'PORT ERROR' : 'ALLOCATING PORT'} · {agentLabel}
        </span>
        <AgentCollaborationControls agentId={`${panelId}-agent`} inputSenderRef={inputSenderRef} />
        <div className="win-spacer" />
        <span className="win-status" style={{ color: appReady ? '#5fd39b' : stateTone.color }}>
          {appReady ? 'app ready' : portError ? 'port error' : stateTone.label}
        </span>
        <button
          type="button"
          className={`win-btn agent-app-prompt-btn ${promptStatus} ${
            promptAttention && appPort && connectionState === 'connected' ? 'attention' : ''
          }`}
          title={promptStatus === 'sent'
            ? 'Launch prompt sent'
            : promptStatus === 'error'
              ? 'TUI is not ready'
              : appPort
                ? `Ask the agent to launch ${appName.trim() || 'this app'} on port ${appPort}`
                : 'Waiting for an allocated port'}
          aria-label="Prompt agent to launch App View"
          disabled={!appPort || connectionState !== 'connected'}
          onAnimationEnd={(event) => {
            if (event.animationName === 'agent-app-prompt-blink') setPromptAttention(false)
          }}
          onClick={(event) => {
            event.stopPropagation()
            sendLaunchPrompt()
          }}
        >
          {promptStatus === 'sent' ? '✓' : <WinPromptIcon />}
        </button>
        <button
          type="button"
          className="win-btn"
          title={collapsed ? 'Expand window' : 'Collapse window'}
          aria-label={collapsed ? 'Expand window' : 'Collapse window'}
          aria-expanded={!collapsed}
          onClick={(event) => {
            event.stopPropagation()
            setCollapsed(!collapsed)
          }}
        >
          {collapsed ? <WinConversationExpandIcon /> : <WinConversationCollapseIcon />}
        </button>
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
        <button
          type="button"
          className="win-btn"
          title={fullWindow ? 'Exit full window' : 'Expand to full window'}
          aria-label={fullWindow ? 'Exit full window' : 'Expand to full window'}
          onClick={(event) => {
            event.stopPropagation()
            toggleFullWindow()
          }}
        >
          <WinFullscreenIcon active={fullWindow} />
        </button>
        <button
          type="button"
          className="win-btn win-btn-close"
          title="Close Agent App"
          aria-label="Close Agent App"
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          <WinCloseIcon />
        </button>
      </div>

      <div
        ref={bodyRef}
        className={`agent-app-body ${chatCollapsed ? 'chat-collapsed' : ''}`}
        style={bodyStyle}
        aria-hidden={collapsed}
      >
        <section className="agent-app-chat" aria-label="TUI agent chat">
          <div className="agent-app-sectionbar">
            <select
              className="conv-input conv-agent-select"
              value={selectedAgentCommand?.id ?? 'current'}
              aria-label="Agent App TUI agent"
              title={selectedAgentCommand?.command ?? agentCommand}
              onChange={(event) => {
                const command = agentCommands.find((item) => item.id === event.target.value)
                if (command) onStateChange({ agentCommand: command.command })
              }}
            >
              {!selectedAgentCommand ? (
                <option value="current" disabled>
                  {agentLabel ? `${agentLabel} (current)` : agentCommands.length ? 'Select a command…' : 'Add commands in Settings'}
                </option>
              ) : null}
              {agentCommands.map((command) => (
                <option
                  key={command.id}
                  value={command.id}
                  disabled={agentCommandAvailability[command.id] === false}
                >
                  {command.name}{agentCommandAvailability[command.id] === false ? ' — unavailable' : ''}
                </option>
              ))}
            </select>
            <span>{stateTone.label}</span>
          </div>
          <WebTerminal
            key={`${panelId}:${agentCommand}`}
            initialCwd={workspaceRoot}
            agent="custom"
            customCommand={agentCommand}
            sessionKey={`${panelId}-agent`}
            collaborationKind="agent_app"
            collaborationLabel={appName.trim() || 'Agent App'}
            eyebrow="Agent App"
            title="TUI Agent"
            showClose={false}
            showCopyText={false}
            collapsible={false}
            onClose={() => {}}
            onConnectionStateChange={setConnectionState}
            frameless
            refreshToken={`${orientation}:${fullWindow}:${chatCollapsed}`}
            inputSenderRef={inputSenderRef}
            notepad={notepad}
            onNotepadChange={(text) => onStateChange({ notepad: text })}
            onStateChange={onStateChange}
          />
        </section>

        <div
          className="agent-app-divider"
          role="separator"
          aria-label={orientation === 'wide' ? 'Resize TUI and App View horizontally' : 'Resize App View and TUI vertically'}
          aria-orientation={orientation === 'wide' ? 'vertical' : 'horizontal'}
          aria-valuemin={Math.round(AGENT_APP_MIN_SPLIT * 100)}
          aria-valuemax={Math.round(AGENT_APP_MAX_SPLIT * 100)}
          aria-valuenow={Math.round(split * 100)}
          tabIndex={chatCollapsed ? -1 : 0}
          onPointerDown={(event) => {
            if (chatCollapsed) return
            if (event.button !== 0) return
            const next = ratioFromPointer(event.clientX, event.clientY)
            if (next === null) return
            event.preventDefault()
            event.stopPropagation()
            event.currentTarget.setPointerCapture(event.pointerId)
            dragSplitRef.current = next
            setDragSplit(next)
            document.body.classList.add(orientation === 'wide' ? 'agent-app-resizing-x' : 'agent-app-resizing-y')
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            const next = ratioFromPointer(event.clientX, event.clientY)
            if (next === null) return
            dragSplitRef.current = next
            setDragSplit(next)
          }}
          onPointerUp={(event) => finishSplitResize(event.pointerId, event.currentTarget)}
          onPointerCancel={(event) => finishSplitResize(event.pointerId, event.currentTarget)}
          onLostPointerCapture={() => finishSplitResize()}
          onKeyDown={(event) => {
            if (chatCollapsed) return
            const step = 0.05
            let delta = 0
            if (orientation === 'wide' && event.key === 'ArrowLeft') delta = step
            if (orientation === 'wide' && event.key === 'ArrowRight') delta = -step
            if (orientation === 'tall' && event.key === 'ArrowUp') delta = -step
            if (orientation === 'tall' && event.key === 'ArrowDown') delta = step
            if (!delta) return
            event.preventDefault()
            onStateChange({ appSplit: clampAgentAppSplit(split + delta) })
          }}
        >
          <button
            type="button"
            className="agent-app-chat-toggle"
            title={chatCollapsed ? 'Expand TUI chat' : 'Collapse TUI chat'}
            aria-label={chatCollapsed ? 'Expand TUI chat' : 'Collapse TUI chat and focus on App View'}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onStateChange({ appChatCollapsed: !chatCollapsed })
            }}
          >
            <svg
              className={`agent-app-chat-toggle-icon direction-${chatToggleDirection}`}
              viewBox="0 0 18 18"
              fill="none"
              aria-hidden
            >
              <path d="M8.25 4.5 3.75 9l4.5 4.5M14.25 4.5 9.75 9l4.5 4.5" />
            </svg>
          </button>
          <span aria-hidden />
        </div>

        <section className="agent-app-view" aria-label="App View">
          <div className="agent-app-sectionbar">
            <span>App View</span>
            <span>{appPort ? `127.0.0.1:${appPort}` : 'allocating port…'}</span>
            <button
              type="button"
              title="Reload App View"
              aria-label="Reload App View"
              disabled={!appReady}
              onClick={() => setFrameKey((key) => nextAgentAppFrameRevision(key))}
            >
              ↻
            </button>
          </div>
          <div className="agent-app-frame-shell">
            {appReady ? (
              <iframe
                key={`${appPort}-${frameKey}`}
                className="agent-app-frame"
                title={`${appName.trim() || 'New App'} App View`}
                src={proxyUrl}
                allow="clipboard-write; microphone"
                onPointerDown={(event) => event.currentTarget.focus()}
              />
            ) : (
              <div className={`agent-app-waiting ${portError ? 'error' : ''}`}>
                <strong>{portError ? 'Port allocation failed' : appPort ? `Waiting for port ${appPort}` : 'Allocating a local port'}</strong>
                <span>
                  {portError
                    ? portError
                    : appPort
                      ? 'Use the ✦ title-bar button to ask the TUI agent to launch the development server.'
                      : 'Agent Rider is selecting an available loopback port for this App View.'}
                </span>
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  )
}

function ConversationCard({
  run,
  paneIndex,
  paneWeight,
  filePreviews,
  onFilePreviewsChange,
  collapsed,
  metaCollapsed,
  active,
  isNewDone,
  onToggle,
  onMetaCollapsedChange,
  onTitleChange,
  onCategoryChange,
  onProjectChange,
  agentCommands,
  agentCommandAvailability,
  onAgentCommandSelect,
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
  paneIndex?: number
  paneWeight?: number
  filePreviews: FilePreviewWindow[]
  onFilePreviewsChange: Dispatch<SetStateAction<FilePreviewWindow[]>>
  collapsed: boolean
  metaCollapsed: boolean
  active: boolean
  isNewDone: boolean
  onToggle: () => void
  onMetaCollapsedChange: (collapsed: boolean) => void
  onTitleChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onProjectChange: (value: string) => void
  agentCommands: AgentCommand[]
  agentCommandAvailability: AgentCommandAvailability
  onAgentCommandSelect: (command: AgentCommand) => void
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
  const storedAgentCommand = (run.agentCommand ?? '').trim()
  const selectedAgentCommand = run.agentType === 'custom'
    ? agentCommands.find((item) => item.command === storedAgentCommand)
    : undefined
  const customAgentCommand = selectedAgentCommand?.command ?? storedAgentCommand
  const agentDisplayLabel = selectedAgentCommand?.name ?? (run.agentType === 'custom' ? customAgentCommand : agentLabel(run.agentType))
  const agentSelectValue = selectedAgentCommand ? `command:${selectedAgentCommand.id}` : 'current'
  const selectedAgentUnavailable = Boolean(selectedAgentCommand && agentCommandAvailability[selectedAgentCommand.id] === false)
  const cardRef = useRef<HTMLElement | null>(null)
  const inputSenderRef = useRef<TerminalInputSender | null>(null)
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [dragOverAfter, setDragOverAfter] = useState(false)
  const [terminalConnectionState, setTerminalConnectionState] = useState<TerminalConnectionState>('connecting')
  const dragOverAfterRef = useRef(false)
  const tone = connectionStatusTone(terminalConnectionState)
  const openTerminalFilePreview = useCallback(
    (filePath: string) => openFilePreviewWindow(filePath, onFilePreviewsChange),
    [onFilePreviewsChange],
  )

  const conversationTitleBar = (
    <div className="win-titlebar" onDoubleClick={onToggle} title="Drag to reorder · double-click to collapse">
      <WinGrip />
      <span
        className="win-dot"
        style={{ background: tone.dot }}
        role="status"
        aria-label={`Terminal ${tone.label}`}
        title={`Terminal ${tone.label}`}
      />
      <input
        className="win-title-input"
        value={run.task}
        size={Math.max(run.task.length, 8)}
        onChange={(event) => onTitleChange(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        placeholder="untitled"
        aria-label="Conversation title"
      />
      <span className="win-meta" title={timeLabel(run.createdAt)}>{run.category || '···'} | {run.project || '···'}</span>
      <AgentCollaborationControls agentId={run.id} inputSenderRef={inputSenderRef} />
      <div className="win-spacer" />
      {isNewDone ? <span className="new-dot" title="New result" /> : null}
      <button type="button" className={`win-btn ${fileBrowserOpen ? 'active' : ''}`} title={fileBrowserOpen ? 'Hide file browser' : 'Browse files'} onClick={(event) => { event.stopPropagation(); setFileBrowserOpen((current) => !current) }}><WinFilesIcon /></button>
      <button type="button" className={`win-btn ${metaCollapsed ? '' : 'active'}`} title={metaCollapsed ? 'Show context' : 'Hide context'} onClick={(event) => { event.stopPropagation(); onMetaCollapsedChange(!metaCollapsed) }}><WinContextIcon /></button>
      <button type="button" className="win-btn" title={collapsed ? 'Expand window' : 'Collapse window'} onClick={(event) => { event.stopPropagation(); onToggle() }}>{collapsed ? <WinConversationExpandIcon /> : <WinConversationCollapseIcon />}</button>
      {onToggleMaximize ? <button type="button" className="win-btn" title={maximized || agentTerminalState?.fullWindow ? 'Restore' : 'Full window'} onClick={(event) => { event.stopPropagation(); onToggleMaximize() }}><WinFullscreenIcon active={Boolean(agentTerminalState?.fullWindow)} /></button> : null}
      <button type="button" className="win-btn win-btn-close" title="Close window" onClick={(event) => { event.stopPropagation(); onClose() }}><WinCloseIcon /></button>
    </div>
  )

  return (
    <article
      id={`conversation-${run.id}`}
      ref={cardRef}
      data-desktop-context-key={run.id}
      data-pane-index={paneIndex}
      style={paneWeight === undefined ? undefined : { '--pane-weight': paneWeight } as CSSProperties}
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
      {/* The terminal's fixed fullscreen overlay must own the titlebar while
          expanded; otherwise the overlay covers the card-level menu. */}
      {agentTerminalState?.fullWindow ? null : conversationTitleBar}

      {!collapsed ? (
        <div className="conv-card-body">
          {!metaCollapsed ? (
            <div className="conv-meta">
              <div className="conv-meta-fields">
                <div className="conv-meta-row"><span className="tree-label">Category</span><input className="conv-input" list="known-categories" value={run.category} onChange={(event) => onCategoryChange(event.target.value)} /></div>
                <div className="conv-meta-row"><span className="tree-label">Project</span><input className="conv-input" list="known-projects" value={run.project} onChange={(event) => onProjectChange(event.target.value)} /></div>
                <div className="conv-meta-row">
                  <span className="tree-label">Agent</span>
                  <select
                    className={`conv-input conv-agent-select ${selectedAgentUnavailable ? 'unavailable' : ''}`}
                    value={agentSelectValue}
                    onChange={(event) => {
                      const id = event.target.value.replace(/^command:/, '')
                      const command = agentCommands.find((item) => item.id === id)
                      if (command) onAgentCommandSelect(command)
                    }}
                  >
                    {!selectedAgentCommand ? (
                      <option value="current" disabled>
                        {agentDisplayLabel ? `${agentDisplayLabel} (current)` : agentCommands.length ? 'Select a command…' : 'Add commands in Settings'}
                      </option>
                    ) : null}
                    {agentCommands.map((item) => (
                      <option
                        key={item.id}
                        value={`command:${item.id}`}
                        disabled={agentCommandAvailability[item.id] === false}
                      >
                        {item.name}{agentCommandAvailability[item.id] === false ? ' — unavailable' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="conv-meta-row"><span className="tree-label">Workspace</span><button type="button" className="conv-workspace-btn" onClick={onOpenPicker} title={run.workspacePath}><span className="conv-workspace-path">{run.workspacePath}</span><span className="conv-workspace-action">Change…</span></button></div>
              </div>
            </div>
          ) : null}
          <div className="conv-content-shell tui-content-shell">
            {run.agentType !== 'custom' || customAgentCommand ? (
              <div className="conv-agent-terminal"><WebTerminal key={`${run.agentType}:${customAgentCommand}:${run.workspacePath}`} agent={run.agentType} customCommand={run.agentType === 'custom' ? customAgentCommand : undefined} sessionKey={run.id} collaborationKind="conversation" collaborationLabel={run.task || agentDisplayLabel} initialCwd={run.workspacePath} eyebrow={`Agent · ${agentDisplayLabel} · persistent`} title={run.agentType === 'custom' ? customAgentCommand : `${run.agentType} — interactive`} showClose={false} showCopyText={false} onClose={() => {}} collapsible={false} frameless titleBar={conversationTitleBar} fullWindow={agentTerminalState?.fullWindow} onStateChange={onAgentTerminalStateChange} onConnectionStateChange={setTerminalConnectionState} refreshToken={metaCollapsed} inputSenderRef={inputSenderRef} notepad={agentTerminalState?.notepad} onNotepadChange={(text) => onAgentTerminalStateChange({ notepad: text })} onOpenFilePreview={openTerminalFilePreview} screenOverlay={<FileBrowser rootPath={run.workspacePath} open={fileBrowserOpen} onToggle={() => setFileBrowserOpen((current) => !current)} previews={filePreviews} onPreviewsChange={onFilePreviewsChange} showOwnToggle={false} />} /></div>
            ) : <div className="conv-agent-command-empty">Add an agent command in Settings, then select it here.</div>}
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
  const [searchQuery, setSearchQuery] = useState('')
  const searchTerm = searchQuery.trim().toLocaleLowerCase()
  const filteredTree = useMemo<ConversationTreeCategory[]>(() => {
    if (!searchTerm) return tree

    return tree.flatMap((category) => {
      const categoryMatches = category.category.toLocaleLowerCase().includes(searchTerm)
      const projects = category.projects.flatMap((project) => {
        const projectMatches = project.project.toLocaleLowerCase().includes(searchTerm)
        const runs = categoryMatches || projectMatches
          ? project.runs
          : project.runs.filter((run) => conversationTitle(run).toLocaleLowerCase().includes(searchTerm))

        return runs.length ? [{ ...project, runs }] : []
      })

      return projects.length ? [{ ...category, projects }] : []
    })
  }, [searchTerm, tree])
  const visibleTotal = filteredTree.reduce((sum, category) => sum + category.projects.reduce((projectSum, project) => projectSum + project.runs.length, 0), 0)

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
        <span
          className="sidebar-count"
          title={searchTerm ? `${visibleTotal} of ${total} conversations` : `${total} conversations`}
        >
          {searchTerm ? visibleTotal : total}
        </span>
      </div>

      <label className="conversation-tree-search">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        <input
          type="search"
          placeholder="Search conversations…"
          aria-label="Search conversations"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </label>

      <div className="sidebar-body">
        {filteredTree.length ? (
          <div className="tree-nav">
            {filteredTree.map((category) => {
              const categoryCollapsed = !searchTerm && collapsedCategories.has(category.category)

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
                      const projectCollapsed = !searchTerm && collapsedProjects.has(projectKey)

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
          <div className="tree-empty">{searchTerm ? 'No matching conversations' : 'No conversations'}</div>
        )}
      </div>
    </nav>
  )
}

/**
 * Tracks whether the viewport is portrait enough for the mobile layout (see
 * `isMobileViewport`). `orientationchange` fires before the new dimensions are
 * always readable on mobile Safari, so a resize listener does the real work and
 * the orientation event is only a nudge.
 */
function useMobileView() {
  const [mobileView, setMobileView] = useState(() => isMobileViewport(window.innerWidth, window.innerHeight))

  useEffect(() => {
    const update = () => setMobileView(isMobileViewport(window.innerWidth, window.innerHeight))
    update()
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])

  useEffect(() => {
    // The To-Do List and file previews portal to document.body, so they sit
    // outside `.app-shell` and its `mobile` class never reaches them. Mirror the
    // flag onto the body so those windows can be styled for portrait too.
    document.body.classList.toggle('mobile-view', mobileView)
    return () => document.body.classList.remove('mobile-view')
  }, [mobileView])

  return mobileView
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
  create: () => Promise<AgentApp | null>
  duplicate: (slug: string) => Promise<AgentApp | null>
  remove: (slug: string) => Promise<boolean>
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

  async function create() {
    const created = await createAgentAppWorkspace()
    if (!created) return null
    hashRef.current = created.listing.hash
    setListing(created.listing)
    return created.app
  }

  async function duplicate(slug: string) {
    const duplicated = await duplicateAgentApp(slug)
    if (!duplicated) return null
    hashRef.current = duplicated.listing.hash
    setListing(duplicated.listing)
    return duplicated.app
  }

  async function remove(slug: string) {
    const next = await deleteAgentApp(slug)
    if (!next) return false
    hashRef.current = next.hash
    setListing(next)
    return true
  }

  return { listing, reorder, rename, create, duplicate, remove }
}

function AgentAppGlyph({ app }: { app: AgentApp }) {
  const iconUrl = agentAppIconUrl(app.id, app.icon)
  const [failedUrl, setFailedUrl] = useState<string>()

  useEffect(() => {
    setFailedUrl(undefined)
  }, [iconUrl])

  if (iconUrl && failedUrl !== iconUrl) {
    return <img src={iconUrl} alt="" onError={() => setFailedUrl(iconUrl)} />
  }
  if (app.icon === 'app-window' || iconUrl) {
    return (
      <svg viewBox="0 0 32 32" fill="none" aria-hidden>
        <rect x="5" y="4.5" width="22" height="23" rx="5" stroke="currentColor" strokeWidth="2" />
        <path d="M5 11h22" stroke="currentColor" strokeWidth="2" />
        <circle cx="9" cy="8" r="1" fill="currentColor" />
        <circle cx="13" cy="8" r="1" fill="currentColor" />
        <path d="M10 17.5h12M10 22h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect x="5" y="5" width="9" height="9" rx="2.5" fill="currentColor" />
      <rect x="18" y="5" width="9" height="9" rx="2.5" fill="currentColor" opacity=".82" />
      <rect x="5" y="18" width="9" height="9" rx="2.5" fill="currentColor" opacity=".82" />
      <rect x="18" y="18" width="9" height="9" rx="2.5" fill="currentColor" opacity=".64" />
    </svg>
  )
}

function AgentAppLauncher({
  apps,
  position,
  openAppIds,
  busy,
  error,
  onCreate,
  onLaunch,
  onRename,
  onDuplicate,
  onDelete,
  onClose,
}: {
  apps: AgentApp[]
  position: { left: number; top: number }
  openAppIds: Set<string>
  busy: boolean
  error: string
  onCreate: () => void
  onLaunch: (app: AgentApp) => void
  onRename: (app: AgentApp) => void
  onDuplicate: (app: AgentApp) => void
  onDelete: (app: AgentApp) => void
  onClose: () => void
}) {
  const [contextMenu, setContextMenu] = useState<{ app: AgentApp; left: number; top: number } | null>(null)

  return createPortal(
    <div className="agent-app-launcher-scrim" onPointerDown={onClose}>
      <section
        className="agent-app-launcher"
        style={position}
        role="dialog"
        aria-modal="true"
        aria-label="Agent Apps"
        onPointerDown={(event) => {
          event.stopPropagation()
          setContextMenu(null)
        }}
      >
        <div className="agent-app-launcher-speaker" aria-hidden />
        <header>
          <span>Agent Rider</span>
          <strong>Apps</strong>
          <button type="button" onClick={onClose} aria-label="Close Apps">×</button>
        </header>
        <div className="agent-app-launcher-grid">
          <button
            type="button"
            className="agent-app-launcher-item"
            disabled={busy}
            onClick={onCreate}
            title="Create a new Agent App project"
          >
            <span className="agent-app-launcher-icon new-app">
              {busy ? <span className="spinner" aria-hidden /> : <span aria-hidden>＋</span>}
            </span>
            <span>New App</span>
          </button>
          {apps.map((app) => (
            <button
              key={app.id}
              type="button"
              className={`agent-app-launcher-item ${openAppIds.has(app.id) ? 'open' : ''}`}
              onClick={() => onLaunch(app)}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setContextMenu({
                  app,
                  left: Math.min(event.clientX, window.innerWidth - 132),
                  top: Math.min(event.clientY, window.innerHeight - 122),
                })
              }}
              title={`${openAppIds.has(app.id) ? 'Open' : 'Launch'} ${app.label}\n${app.location}`}
            >
              <span
                className="agent-app-launcher-icon"
                style={{ '--agent-app-icon-hue': agentAppIconHue(app.id) } as CSSProperties}
              >
                <AgentAppGlyph app={app} />
                {openAppIds.has(app.id) ? <span className="agent-app-open-dot" aria-label="Open" /> : null}
              </span>
              <span>{app.label}</span>
            </button>
          ))}
        </div>
        {error ? <p className="agent-app-launcher-error" role="alert">{error}</p> : null}
        {!apps.length && !error ? <p className="agent-app-launcher-empty">Create your first Agent App.</p> : null}
        <div className="agent-app-launcher-home" aria-hidden />
        {contextMenu ? (
          <div
            className="agent-app-launcher-context-menu"
            role="menu"
            aria-label={`${contextMenu.app.label} actions`}
            style={{ left: contextMenu.left, top: contextMenu.top }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                const app = contextMenu.app
                setContextMenu(null)
                onRename(app)
              }}
            >
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                const app = contextMenu.app
                setContextMenu(null)
                onDuplicate(app)
              }}
            >
              Duplicate
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              disabled={busy}
              onClick={() => {
                const app = contextMenu.app
                setContextMenu(null)
                onDelete(app)
              }}
            >
              Delete
            </button>
          </div>
        ) : null}
      </section>
    </div>,
    document.body,
  )
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
  onLaunchApp: (app: AgentApp) => void
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
                        onLaunch={() => onLaunchApp(app)}
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

function terminalFileLinkRows(terminal: XTermTerminal, bufferLineNumber: number) {
  const buffer = terminal.buffer.active
  let logicalFirstRow = bufferLineNumber - 1
  while (logicalFirstRow > 0 && buffer.getLine(logicalFirstRow)?.isWrapped) logicalFirstRow -= 1
  let logicalLastRow = logicalFirstRow
  while (logicalLastRow + 1 < buffer.length && buffer.getLine(logicalLastRow + 1)?.isWrapped) logicalLastRow += 1

  // Include one adjacent logical line in each direction so the pure detector
  // can recognize a long filename split by an explicit newline and indentation.
  let firstRow = logicalFirstRow
  if (firstRow > 0) {
    firstRow -= 1
    while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) firstRow -= 1
  }
  let lastRow = logicalLastRow
  if (lastRow + 1 < buffer.length) {
    lastRow += 1
    while (lastRow + 1 < buffer.length && buffer.getLine(lastRow + 1)?.isWrapped) lastRow += 1
  }

  const rows: TerminalLinkRow[] = []
  for (let rowIndex = firstRow; rowIndex <= lastRow; rowIndex += 1) {
    const line = buffer.getLine(rowIndex)
    if (!line) continue
    const cells = []
    for (let column = 0; column < terminal.cols; column += 1) {
      const cell = line.getCell(column)
      cells.push({ chars: cell?.getChars() ?? '', width: cell?.getWidth() ?? 1 })
    }
    rows.push({ cells, isWrapped: line.isWrapped })
  }
  return { rows, firstBufferLine: firstRow + 1 }
}

function terminalFileLinksForBufferLine(
  terminal: XTermTerminal,
  bufferLineNumber: number,
  workspacePath: string,
  onHover: (path: string | null) => void,
  onActivate: (path: string) => void,
): ILink[] {
  const { rows, firstBufferLine } = terminalFileLinkRows(terminal, bufferLineNumber)
  return detectTerminalFileLinks(rows, firstBufferLine, bufferLineNumber, workspacePath).map((link) => ({
    range: { start: link.start, end: link.end },
    text: link.label,
    decorations: { pointerCursor: true, underline: true },
    hover: () => onHover(link.path),
    leave: () => onHover(null),
    activate: (event) => {
      event.preventDefault()
      event.stopPropagation()
      onActivate(link.path)
    },
  }))
}

function WebTerminal({
  initialCwd,
  onClose,
  agent,
  customCommand,
  sessionKey,
  collaborationKind,
  collaborationLabel,
  eyebrow = 'Resource · Tools',
  title = 'Local Terminal',
  showClose = true,
  showCopyText = true,
  collapsible = true,
  collapsed,
  fullWindow,
  onStateChange,
  onConnectionStateChange,
  headerLeading,
  frameless = false,
  titleBar,
  refreshToken,
  notepad,
  onNotepadChange,
  onOpenFilePreview,
  screenOverlay,
  inputSenderRef,
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
  /** Public directory metadata for a persistent TUI agent binding. */
  collaborationKind?: 'conversation' | 'agent_app'
  collaborationLabel?: string
  eyebrow?: string
  title?: string
  showClose?: boolean
  /** Whether to show the terminal's click-to-select copy mode in its footer. */
  showCopyText?: boolean
  /** When false, the terminal always stays expanded and its header isn't collapsible. */
  collapsible?: boolean
  collapsed?: boolean
  fullWindow?: boolean
  onStateChange?: (patch: WorkspacePanelState) => void
  /** Reports WebSocket lifecycle changes to host chrome rendered outside this terminal. */
  onConnectionStateChange?: (state: TerminalConnectionState) => void
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
  /** Re-attach an agent TUI when its surrounding card chrome changes size. */
  refreshToken?: unknown
  /** Persisted scratch draft (see WorkspacePanelState.notepad). */
  notepad?: string
  onNotepadChange?: (text: string) => void
  /** Opens a detected workspace file through the conversation's shared preview state. */
  onOpenFilePreview?: (path: string) => Promise<string | null>
  /** Content layered over only the terminal screen, never its Notepad/footer. */
  screenOverlay?: ReactNode
  /** Imperative paste-and-submit bridge for explicit host-window actions. */
  inputSenderRef?: { current: TerminalInputSender | null }
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<XTermTerminal | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<() => void>(() => {})
  const resetOnNextConnectRef = useRef(false)
  const wheelPageAccumulatorRef = useRef(0)
  const touchScrollAccumulatorRef = useRef(0)
  const retainedClaudeSelectionRef = useRef<{ column: number; row: number; length: number } | null>(null)
  const restoringClaudeSelectionRef = useRef(false)
  const terminalSelectionDragRef = useRef(false)
  const tmuxModeCheckRef = useRef<(delay?: number) => void>(() => {})
  const notepadInputRef = useRef<HTMLTextAreaElement | null>(null)
  const openFilePreviewRef = useRef(onOpenFilePreview)
  openFilePreviewRef.current = onOpenFilePreview
  const [connectionState, setConnectionState] = useState<TerminalConnectionState>('connecting')
  const [terminalKey, setTerminalKey] = useState(0)
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const [internalFullWindow, setInternalFullWindow] = useState(false)
  const terminalCollapsed = collapsible ? (collapsed ?? internalCollapsed) : false
  const terminalFullWindow = fullWindow ?? internalFullWindow
  const agentTerminal = Boolean(agent)
  const notepadEnabled = typeof onNotepadChange === 'function'
  const [notepadOpen, setNotepadOpen] = useState(false)
  const [notepadCopied, setNotepadCopied] = useState(false)
  const [copyMode, setCopyMode] = useState(false)
  const [selectionCopied, setSelectionCopied] = useState(false)
  const [tmuxScrollbackActive, setTmuxScrollbackActive] = useState(false)
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
    let hoveredFilePath: string | null = null
    let pressedFilePath: string | null = null
    const openDetectedFile = (path: string) => {
      const openFilePreview = openFilePreviewRef.current
      if (openFilePreview) void openFilePreview(path)
    }
    const fileLinkDisposable = terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        if (!openFilePreviewRef.current) {
          callback(undefined)
          return
        }
        const links = terminalFileLinksForBufferLine(
          terminal,
          bufferLineNumber,
          initialCwd,
          (path) => { hoveredFilePath = path },
          openDetectedFile,
        )
        callback(links.length ? links : undefined)
      },
    })
    // Full-screen TUIs usually enable mouse reporting. Intercept a click while
    // xterm's link provider says the pointer is over a filename so opening a
    // preview never also sends that click into the agent process.
    const interceptFileLinkMouseDown = (event: MouseEvent) => {
      if (!hoveredFilePath || event.button !== 0) return
      pressedFilePath = hoveredFilePath
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const interceptFileLinkMouseUp = (event: MouseEvent) => {
      const path = pressedFilePath
      pressedFilePath = null
      if (!path || event.button !== 0) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (path === hoveredFilePath) openDetectedFile(path)
    }
    container.addEventListener('mousedown', interceptFileLinkMouseDown, { capture: true })
    container.addEventListener('mouseup', interceptFileLinkMouseUp, { capture: true })
    terminal.attachCustomKeyEventHandler((event) => {
      const wantsCopy = event.type === 'keydown' && event.key.toLowerCase() === 'c' && (event.metaKey || event.ctrlKey)
      if (!wantsCopy) return true
      if (!terminal.hasSelection()) return true
      event.preventDefault()
      event.stopPropagation()
      void copyToClipboard(terminal.getSelection()).catch(() => {})
      return false
    })
    const selectionDisposable = terminal.onSelectionChange(() => {
      if (agent !== 'claude') return

      const position = terminal.getSelectionPosition()
      if (position && terminalSelectionDragRef.current) {
        retainedClaudeSelectionRef.current = {
          column: position.start.x,
          row: position.start.y,
          length: (position.end.y - position.start.y) * terminal.cols + position.end.x - position.start.x,
        }
        return
      }

      // Claude periodically reapplies its mouse-reporting mode while repainting.
      // xterm clears its selection whenever that protocol changes, including
      // immediately after a drag. Restore the user's completed selection unless
      // they have started another click or sent input to the terminal.
      const retained = retainedClaudeSelectionRef.current
      if (position || !retained || restoringClaudeSelectionRef.current) return
      restoringClaudeSelectionRef.current = true
      queueMicrotask(() => {
        try {
          if (
            terminalRef.current === terminal &&
            retainedClaudeSelectionRef.current === retained &&
            !terminal.hasSelection()
          ) {
            terminal.select(retained.column, retained.row, retained.length)
          }
        } finally {
          restoringClaudeSelectionRef.current = false
        }
      })
    })
    const selectionResizeDisposable = terminal.onResize(() => {
      // xterm intentionally clears selections on vertical resize because the
      // old buffer coordinates may no longer describe the same text.
      retainedClaudeSelectionRef.current = null
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
    const collaborationParam = collaborationKind
      ? `&kind=${encodeURIComponent(collaborationKind)}&label=${encodeURIComponent(collaborationLabel ?? sessionKey ?? '')}`
      : ''
    const resetParam = resetOnNextConnectRef.current ? '&reset=1' : ''
    resetOnNextConnectRef.current = false
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/store/terminal/ws?cwd=${encodeURIComponent(initialCwd)}&cols=${terminal.cols}&rows=${terminal.rows}${agentParam}${commandParam}${sessionParam}${collaborationParam}${resetParam}`,
    )
    // PTY output is sent as binary frames. Keep it as ArrayBuffer so frame
    // delivery stays synchronous and ordered all the way into xterm. Calling
    // Blob.text() for every frame lets those independent promises resolve out
    // of order during rapid TUI redraws, scrambling ANSI cursor operations.
    socket.binaryType = 'arraybuffer'
    socketRef.current = socket
    let disposed = false
    let socketErrored = false
    let pendingBlobWrite = Promise.resolve()
    let tmuxModeCheckTimer: number | undefined
    let reconnectTimer: number | undefined
    const scheduleTmuxModeCheck = (delay = 120) => {
      if (!agentTerminal || !sessionKey) return
      window.clearTimeout(tmuxModeCheckTimer)
      tmuxModeCheckTimer = window.setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'tmux-copy-mode-status' }))
        }
      }, delay)
    }
    tmuxModeCheckRef.current = scheduleTmuxModeCheck
    setTmuxScrollbackActive(false)
    const reportConnectionState = (state: TerminalConnectionState) => {
      if (disposed) return
      setConnectionState(state)
      onConnectionStateChange?.(state)
    }
    reportConnectionState('connecting')

    const inputDisposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'input', data }))
        scheduleTmuxModeCheck()
      }
    })

    // Only keystrokes may drop the retained selection; every broader signal
    // misfires. onData carries terminal query auto-replies (DA, DECRQM,
    // cursor position reports). xterm's internal onUserInput additionally
    // fires for forwarded mouse reports — and when the TUI requests
    // any-motion tracking (?1003h, which tmux passes through to this outer
    // terminal), simply moving the pointer after releasing a drag emits a
    // motion report, wipes the retention, and disarms the restore, so the
    // selection vanished the moment the mouse settled. xterm still clears
    // its own selection on those reports; the restore microtask in
    // onSelectionChange puts it back before the next paint. Paste, wheel,
    // and click paths clear the retention explicitly.
    const userInputDisposable = terminal.onKey(() => {
      retainedClaudeSelectionRef.current = null
    })

    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(container)
    window.addEventListener('resize', fit)

    socket.addEventListener('open', () => {
      reportConnectionState('connected')
      fit()
      scheduleTmuxModeCheck(200)
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as { type?: unknown; active?: unknown }
          if (message.type === 'tmux-copy-mode' && typeof message.active === 'boolean') {
            setTmuxScrollbackActive(message.active)
            return
          }
        } catch {
          // Text frames other than control messages are ordinary terminal output.
        }
        terminal.write(event.data)
        return
      }
      if (event.data instanceof ArrayBuffer) {
        // Passing bytes also lets xterm preserve UTF-8 sequences split across
        // WebSocket frames instead of decoding each frame in isolation.
        terminal.write(new Uint8Array(event.data))
        return
      }
      if (event.data instanceof Blob) {
        // Defensive fallback for WebSocket implementations that ignore
        // binaryType. Serialize conversion so even this path cannot reorder
        // terminal control sequences.
        const blob = event.data
        pendingBlobWrite = pendingBlobWrite.then(async () => {
          const bytes = new Uint8Array(await blob.arrayBuffer())
          if (!disposed) terminal.write(bytes)
        })
      }
    })
    socket.addEventListener('close', () => {
      if (!socketErrored) reportConnectionState('closed')
      if (sessionKey && !disposed && reconnectTimer === undefined) {
        terminal.writeln('\r\n\x1b[33mTerminal transport restarting; reattaching session…\x1b[0m')
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = undefined
          if (!disposed) setTerminalKey((current) => current + 1)
        }, 500)
      }
    })
    socket.addEventListener('error', () => {
      socketErrored = true
      reportConnectionState('error')
      terminal.writeln('\r\n\x1b[31mTerminal connection error\x1b[0m')
    })

    return () => {
      disposed = true
      window.clearTimeout(tmuxModeCheckTimer)
      window.clearTimeout(reconnectTimer)
      tmuxModeCheckRef.current = () => {}
      resizeObserver.disconnect()
      window.removeEventListener('resize', fit)
      selectionResizeDisposable.dispose()
      selectionDisposable.dispose()
      userInputDisposable.dispose()
      osc52Disposable.dispose()
      inputDisposable.dispose()
      fileLinkDisposable.dispose()
      container.removeEventListener('mousedown', interceptFileLinkMouseDown, { capture: true })
      container.removeEventListener('mouseup', interceptFileLinkMouseUp, { capture: true })
      socket.close()
      terminal.dispose()
      if (socketRef.current === socket) socketRef.current = null
      if (terminalRef.current === terminal) terminalRef.current = null
    }
  // The collaboration label is display metadata, not terminal connection identity.
  // Reconnecting here on every title edit recreates xterm and steals focus from
  // the Project/title input via terminal.focus() above. A later real reconnect
  // still uses the latest label from that render.
  }, [initialCwd, terminalKey, agent, customCommand, sessionKey, collaborationKind, onConnectionStateChange])

  useEffect(() => {
    if (!inputSenderRef) return
    const sender: TerminalInputSender = (value, submit = false) => {
      const terminal = terminalRef.current
      const socket = socketRef.current
      if (!terminal || socket?.readyState !== WebSocket.OPEN) return false
      retainedClaudeSelectionRef.current = null
      terminal.focus()
      terminal.paste(value)
      if (submit) socket.send(JSON.stringify({ type: 'input', data: '\r' }))
      tmuxModeCheckRef.current()
      return true
    }
    inputSenderRef.current = sender
    return () => {
      if (inputSenderRef.current === sender) inputSenderRef.current = null
    }
  }, [inputSenderRef, terminalKey])

  useEffect(() => {
    if (!terminalCollapsed) window.requestAnimationFrame(() => fitRef.current())
  }, [terminalCollapsed, terminalFullWindow, terminalKey])

  const didInitRefreshTokenRef = useRef(false)
  useEffect(() => {
    if (!didInitRefreshTokenRef.current) {
      didInitRefreshTokenRef.current = true
      return
    }
    if (!agentTerminal || terminalCollapsed) return
    setTerminalKey((current) => current + 1)
  }, [refreshToken])

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
    // Use xterm's paste path so newlines are normalized and, when the TUI has
    // enabled bracketed-paste mode, the whole draft arrives as one paste
    // instead of the first newline acting like Enter and submitting early.
    retainedClaudeSelectionRef.current = null
    const terminal = terminalRef.current
    terminal?.focus()
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      terminal?.paste(value)
    }
  }

  function dropInputTextIntoNotepad(event: DragEvent<HTMLElement>) {
    const value = inputTextFromDrag(event)
    if (!value) return
    event.preventDefault()
    event.stopPropagation()

    const textarea = notepadInputRef.current
    if (textarea) {
      onNotepadChange?.(insertIntoTextarea(textarea, value))
    } else {
      const current = notepad ?? ''
      const separator = current && !/\s$/.test(current) ? ' ' : ''
      onNotepadChange?.(`${current}${separator}${value}`)
    }

    setNotepadOpen(true)
    window.requestAnimationFrame(() => {
      const input = notepadInputRef.current
      if (!input) return
      input.focus()
      if (!textarea) input.setSelectionRange(input.value.length, input.value.length)
    })
  }

  function beginTerminalSelection(event: React.MouseEvent<HTMLDivElement>) {
    if (event.button !== 0) return

    const terminal = terminalRef.current
    if (!terminal) return
    retainedClaudeSelectionRef.current = null
    terminalSelectionDragRef.current = true
    if (terminal.modes.mouseTrackingMode !== 'none') {
      forceTerminalSelectionModifier(event.nativeEvent)
    }

    // Plain left-button drags should select in every terminal without making
    // users discover or hold xterm's TUI-specific Shift/Option modifier. Copy
    // mode only adds automatic clipboard copying after that selection finishes.
    // xterm finishes its drag selection on document mouseup. Window receives
    // the same event afterwards, so the final selection is ready to retain or
    // copy here.
    window.addEventListener('mouseup', () => {
      terminalSelectionDragRef.current = false
      if (!terminal.hasSelection()) return

      if (agent === 'claude') {
        const position = terminal.getSelectionPosition()
        if (position) {
          retainedClaudeSelectionRef.current = {
            column: position.start.x,
            row: position.start.y,
            length: (position.end.y - position.start.y) * terminal.cols + position.end.x - position.start.x,
          }
        }
      }

      if (!copyMode) return
      void copyToClipboard(terminal.getSelection()).then(() => {
        setCopyMode(false)
        setSelectionCopied(true)
        window.setTimeout(() => setSelectionCopied(false), 1200)
      }).catch(() => {})
    }, { once: true })
  }

  function pageThroughTuiFromWheel(event: WheelEvent) {
    if (!agentTerminal || terminalCollapsed) return

    // Scrolling moves the TUI's content, so a restored selection would cover
    // different text. Drop the retention; keystroke handling can't see wheel
    // events (they reach the app as forwarded mouse reports, not key input).
    retainedClaudeSelectionRef.current = null

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
    tmuxModeCheckRef.current()
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

  /**
   * A one-finger swipe over the terminal has to scroll the terminal. Touch never
   * produces wheel events, so without this the gesture fell through to the mobile
   * window column: agent TUIs (which run under tmux on the alternate screen) had
   * no reachable scrollback on a phone at all.
   *
   * The swipe is replayed as a wheel event on the element the finger is actually
   * over, which keeps every downstream path identical to a trackpad scroll — xterm
   * encodes mouse-reporting TUIs' wheel reports for tmux, and `pageThroughTuiFromWheel`
   * still supplies the PageUp/PageDown fallback when mouse reporting is off. Only a
   * plain shell, whose scrollback lives in xterm's own buffer, is scrolled directly.
   */
  function scrollTerminalFromTouch(target: EventTarget | null, deltaY: number, clientX: number, clientY: number) {
    const terminal = terminalRef.current
    if (!terminal || terminalCollapsed) return

    if (agentTerminal || terminal.modes.mouseTrackingMode !== 'none') {
      const node = target instanceof Element ? target : containerRef.current?.querySelector('.xterm-screen')
      node?.dispatchEvent(new WheelEvent('wheel', {
        deltaY,
        deltaMode: 0,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      }))
      return
    }

    const screen = containerRef.current?.querySelector<HTMLElement>('.xterm-screen')
    const cell = screen && terminal.rows ? Math.max(1, screen.clientHeight / terminal.rows) : TOUCH_SCROLL_FALLBACK_LINE
    touchScrollAccumulatorRef.current += deltaY
    const lines = Math.trunc(touchScrollAccumulatorRef.current / cell)
    if (!lines) return
    touchScrollAccumulatorRef.current -= lines * cell
    retainedClaudeSelectionRef.current = null
    terminal.scrollLines(lines)
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    let panning = false
    let lastY = 0
    let originY = 0

    const handleTouchStart = (event: TouchEvent) => {
      // Pinch-zoom and two-finger gestures stay with the browser.
      panning = event.touches.length === 1
      if (!panning) return
      lastY = originY = event.touches[0].clientY
      touchScrollAccumulatorRef.current = 0
    }

    const handleTouchMove = (event: TouchEvent) => {
      if (!panning || event.touches.length !== 1) return
      const touch = event.touches[0]
      // Below the slop a touch is still a tap (or the start of a long press for
      // the native paste menu), so nothing is claimed from the browser yet.
      if (Math.abs(touch.clientY - originY) < TOUCH_SCROLL_SLOP) return
      const deltaY = lastY - touch.clientY
      lastY = touch.clientY
      if (event.cancelable) event.preventDefault()
      scrollTerminalFromTouch(event.target, deltaY, touch.clientX, touch.clientY)
    }

    const endTouch = () => { panning = false }

    container.addEventListener('touchstart', handleTouchStart, { passive: true })
    container.addEventListener('touchmove', handleTouchMove, { passive: false })
    container.addEventListener('touchend', endTouch, { passive: true })
    container.addEventListener('touchcancel', endTouch, { passive: true })
    return () => {
      container.removeEventListener('touchstart', handleTouchStart)
      container.removeEventListener('touchmove', handleTouchMove)
      container.removeEventListener('touchend', endTouch)
      container.removeEventListener('touchcancel', endTouch)
    }
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
        <div className="terminal-view-layout">
          <div className="terminal-primary">
            <div className="terminal-screen-shell">
              <div
                className={`terminal-screen ${copyMode ? 'copy-mode' : ''}`}
                ref={containerRef}
                role="application"
                aria-label="Interactive shell terminal"
                onMouseDownCapture={beginTerminalSelection}
                onClick={() => terminalRef.current?.focus()}
                onDragOver={allowInputTextDrop}
                onDrop={(event) => {
                  const value = inputTextFromDrag(event)
                  if (!value) return
                  event.preventDefault()
                  event.stopPropagation()
                  pasteIntoTerminal(value)
                }}
              />
              {screenOverlay}
              {agentTerminal && tmuxScrollbackActive ? (
                <button
                  type="button"
                  className="terminal-quit-scroll"
                  title="Exit tmux scrollback and return to the live terminal"
                  onClick={() => {
                    setTmuxScrollbackActive(false)
                    if (socketRef.current?.readyState === WebSocket.OPEN) {
                      socketRef.current.send(JSON.stringify({ type: 'tmux-copy-mode-quit' }))
                    }
                    terminalRef.current?.focus()
                  }}
                >
                  Exit Scrollback
                </button>
              ) : null}
            </div>

            {notepadEnabled && notepadOpen ? (
              <div className="terminal-notepad">
                <div className="terminal-notepad-head">
                  <span className="terminal-notepad-title">Notepad</span>
                  <span className="terminal-notepad-hint">Draft safely — Enter adds a line, nothing is sent until you Insert.</span>
                </div>
                <textarea
                  ref={notepadInputRef}
                  className="terminal-notepad-input"
                  value={notepad ?? ''}
                  onChange={(event) => onNotepadChange?.(event.target.value)}
                  onDragOver={allowInputTextDrop}
                  onDrop={dropInputTextIntoNotepad}
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
          </div>
        </div>

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
              onDragOver={allowInputTextDrop}
              onDrop={dropInputTextIntoNotepad}
              onClick={() => setNotepadOpen((current) => !current)}
            >
              Notepad{(notepad ?? '').trim().length ? ' •' : ''}
            </button>
          ) : null}
          {showCopyText ? (
            <button
              type="button"
              className={`terminal-clear ${copyMode ? 'active' : ''}`}
              title={
                copyMode
                  ? 'Drag over terminal text to copy it; click again to cancel'
                  : 'Copy terminal text without holding Shift or Option'
              }
              aria-pressed={copyMode}
              onClick={() => {
                setSelectionCopied(false)
                setCopyMode((current) => !current)
              }}
            >
              {selectionCopied ? 'Copied' : copyMode ? 'Drag to copy…' : 'Copy text'}
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

function WorkspaceReconnectOverlay({
  title = 'Restoring workspace…',
  message = 'Waiting for the application service and saved window layout.',
  onReload,
}: {
  title?: string
  message?: string
  onReload?: () => void
}) {
  return (
    <div className="password-overlay" role="status" aria-live="polite">
      <div className="password-panel">
        <div>
          <div className="eyebrow">Agent Rider</div>
          <h2>{title}</h2>
        </div>
        <p>{message}</p>
        {onReload ? (
          <button type="button" className="send-button password-submit" onClick={onReload}>
            Reload saved workspace
          </button>
        ) : null}
      </div>
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

function AgentCommandsDialog({
  commands,
  onClose,
  onSave,
}: {
  commands: AgentCommand[]
  onClose: () => void
  onSave: (commands: AgentCommand[]) => void
}) {
  const [drafts, setDrafts] = useState<AgentCommand[]>(() => commands.map((item) => ({ ...item })))
  const normalizedCommands = drafts.map((item) => ({
    ...item,
    name: item.name.trim(),
    command: item.command.trim(),
  }))
  const hasIncompleteCommand = normalizedCommands.some((item) => !item.name || !item.command)
  const hasDuplicateCommand = new Set(normalizedCommands.map((item) => item.command)).size !== normalizedCommands.length

  function updateDraft(id: string, patch: Partial<AgentCommand>) {
    setDrafts((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (hasIncompleteCommand || hasDuplicateCommand) return
    onSave(normalizedCommands)
    onClose()
  }

  return (
    <div className="password-overlay" role="dialog" aria-modal="true" aria-label="Agent commands">
      <form className="password-panel agent-commands-panel" onSubmit={submit}>
        <div className="password-head">
          <div>
            <div className="eyebrow">Conversation Card</div>
            <h2>Agent Commands</h2>
          </div>
          <button type="button" className="card-close" onClick={onClose} aria-label="Close agent commands dialog">
            ×
          </button>
        </div>

        <p className="agent-commands-help">
          These commands become the options in every Conversation Card’s Agent selector.
          {' '}Recognized Codex, Claude, Agy, Devin, and Hermes commands automatically receive general Agent Rider platform instructions when a new session starts.
        </p>

        <div className="agent-command-list">
          {drafts.length ? drafts.map((item, index) => (
            <div className="agent-command-editor" key={item.id}>
              <div className="agent-command-editor-head">
                <span>Command {index + 1}</span>
                <button
                  type="button"
                  className="agent-command-remove"
                  onClick={() => setDrafts((current) => current.filter((candidate) => candidate.id !== item.id))}
                  aria-label={`Remove ${item.name || `command ${index + 1}`}`}
                >
                  Remove
                </button>
              </div>
              <label className="password-field">
                <span>Name</span>
                <input
                  value={item.name}
                  onChange={(event) => updateDraft(item.id, { name: event.target.value })}
                  placeholder="Codex"
                  autoFocus={index === drafts.length - 1 && !item.name}
                />
              </label>
              <label className="password-field">
                <span>Command</span>
                <input
                  className="agent-command-input"
                  value={item.command}
                  onChange={(event) => updateDraft(item.id, { command: event.target.value })}
                  placeholder="codex --yolo"
                  maxLength={2000}
                  spellCheck={false}
                />
              </label>
            </div>
          )) : (
            <div className="agent-command-empty">No commands defined yet.</div>
          )}
        </div>

        {hasDuplicateCommand ? <div className="password-error">Each command must be unique.</div> : null}

        <div className="password-actions agent-command-actions">
          <button
            type="button"
            className="password-secondary"
            onClick={() => setDrafts((current) => [...current, { id: makeId('agent-command'), name: '', command: '' }])}
          >
            + Add command
          </button>
          <button type="submit" className="send-button password-submit" disabled={hasIncompleteCommand || hasDuplicateCommand}>
            Save commands
          </button>
        </div>
      </form>
    </div>
  )
}

function UsageSettingsDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: () => void
}) {
  const [settings, setSettings] = useState<UsageCredentialSettings | null>(null)
  const [openCodeCookie, setOpenCodeCookie] = useState('')
  const [openCodeWorkspaceId, setOpenCodeWorkspaceId] = useState('')
  const [clearOpenCodeCookie, setClearOpenCodeCookie] = useState(false)
  const [miniMaxCookie, setMiniMaxCookie] = useState('')
  const [miniMaxGroupId, setMiniMaxGroupId] = useState('')
  const [miniMaxModels, setMiniMaxModels] = useState('')
  const [clearMiniMaxCookie, setClearMiniMaxCookie] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void loadUsageCredentialSettings()
      .then((value) => {
        if (cancelled) return
        setSettings(value)
        setOpenCodeWorkspaceId(value.openCodeWorkspaceId)
        setMiniMaxGroupId(value.miniMaxGroupId)
        setMiniMaxModels(value.miniMaxModels)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Usage settings could not be loaded')
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const saved = await persistUsageCredentialSettings({
        openCodeCookie,
        openCodeWorkspaceId,
        clearOpenCodeCookie,
        miniMaxCookie,
        miniMaxGroupId,
        miniMaxModels,
        clearMiniMaxCookie,
      })
      setSettings(saved)
      onSaved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Usage settings could not be saved')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="password-overlay" role="dialog" aria-modal="true" aria-label="Usage providers">
      <form className="password-panel agent-commands-panel" onSubmit={submit}>
        <div className="password-head">
          <div>
            <div className="eyebrow">Usage</div>
            <h2>Usage Providers</h2>
          </div>
          <button type="button" className="card-close" onClick={onClose} aria-label="Close usage providers dialog">×</button>
        </div>
        <p className="agent-commands-help">
          CLI credentials for Gemini, Agy, Kimi, and Grok are detected automatically.
          OpenCode Go and MiniMax require web session cookies stored only in the local Agent Rider database.
        </p>
        <div className="agent-command-list">
          <div className="agent-command-editor">
            <div className="agent-command-editor-head"><span>OpenCode Go</span></div>
            <label className="password-field">
              <span>Session cookie {settings?.openCodeConfigured ? '(configured)' : ''}</span>
              <input
                type="password"
                value={openCodeCookie}
                onChange={(event) => setOpenCodeCookie(event.target.value)}
                placeholder={settings?.openCodeConfigured ? 'Leave blank to keep saved cookie' : 'auth=…'}
                autoComplete="off"
              />
            </label>
            <label className="password-field">
              <span>Workspace ID override</span>
              <input value={openCodeWorkspaceId} onChange={(event) => setOpenCodeWorkspaceId(event.target.value)} placeholder="wrk_…" />
            </label>
            {settings?.openCodeConfigured ? (
              <label className="password-field">
                <span><input type="checkbox" checked={clearOpenCodeCookie} onChange={(event) => setClearOpenCodeCookie(event.target.checked)} /> Remove saved cookie</span>
              </label>
            ) : null}
          </div>
          <div className="agent-command-editor">
            <div className="agent-command-editor-head"><span>MiniMax</span></div>
            <label className="password-field">
              <span>Session cookie {settings?.miniMaxConfigured ? '(configured)' : ''}</span>
              <input
                type="password"
                value={miniMaxCookie}
                onChange={(event) => setMiniMaxCookie(event.target.value)}
                placeholder={settings?.miniMaxConfigured ? 'Leave blank to keep saved cookie' : '_token=…'}
                autoComplete="off"
              />
            </label>
            <label className="password-field">
              <span>Group ID override</span>
              <input value={miniMaxGroupId} onChange={(event) => setMiniMaxGroupId(event.target.value)} />
            </label>
            <label className="password-field">
              <span>Preferred models</span>
              <input value={miniMaxModels} onChange={(event) => setMiniMaxModels(event.target.value)} placeholder="MiniMax-M2.1, MiniMax-M2" />
            </label>
            {settings?.miniMaxConfigured ? (
              <label className="password-field">
                <span><input type="checkbox" checked={clearMiniMaxCookie} onChange={(event) => setClearMiniMaxCookie(event.target.checked)} /> Remove saved cookie</span>
              </label>
            ) : null}
          </div>
        </div>
        {error ? <div className="password-error">{error}</div> : null}
        <div className="password-actions">
          <button type="button" className="password-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="send-button password-submit" disabled={busy || settings === null}>
            {busy ? 'Saving…' : 'Save providers'}
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

function VersionDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<VersionInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    void loadVersionInfo().then((result) => {
      if (cancelled) return
      if ('error' in result) setError(result.error)
      else setInfo(result)
    })
    return () => { cancelled = true }
  }, [])

  async function copyVersionInfo() {
    if (!info) return
    const lines = [
      `Agent Rider ${info.app.displayVersion}`,
      `Application commit: ${info.app.sourceCommit}`,
      `Platform: ${info.app.platform}`,
    ]
    if (info.runtime && !info.sameBuild) {
      lines.push(
        `Session runtime: ${info.runtime.displayVersion}`,
        `Runtime commit: ${info.runtime.sourceCommit}`,
      )
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied(true)
    } catch {
      setError('Unable to copy version information')
    }
  }

  return (
    <div className="password-overlay" role="dialog" aria-modal="true" aria-label="Version information">
      <div className="password-panel version-panel">
        <div className="password-head">
          <div>
            <div className="eyebrow">Agent Rider</div>
            <h2>Version</h2>
          </div>
          <button type="button" className="card-close" onClick={onClose} aria-label="Close version dialog">
            ×
          </button>
        </div>

        {!info && !error ? <div className="version-loading">Loading version information…</div> : null}
        {error ? <div className="password-error">{error}</div> : null}
        {info ? (
          <>
            <div className="version-build">
              <span>Application</span>
              <strong>{info.app.displayVersion}</strong>
              <code>{info.app.sourceCommit}</code>
            </div>
            {info.runtime && !info.sameBuild ? (
              <div className="version-build">
                <span>Session runtime</span>
                <strong>{info.runtime.displayVersion}</strong>
                <code>{info.runtime.sourceCommit}</code>
              </div>
            ) : null}
            <div className="version-platform">
              <span>Platform</span>
              <code>{info.app.platform}</code>
            </div>
            <div className="password-actions">
              <button type="button" className="password-secondary" onClick={copyVersionInfo}>
                {copied ? 'Copied' : 'Copy version info'}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

export default function App() {
  const hydratedRef = useRef(false)
  const runsRef = useRef<RunNode[]>([])
  const usageRefreshPromiseRef = useRef<Promise<void> | null>(null)
  const upgradeReloadStartedRef = useRef(false)
  const upgradePrepareStartedRef = useRef(false)
  const upgradePreparedRef = useRef(false)
  const deletedRunIdsRef = useRef<Set<string>>(new Set())
  const stateSaveQueueRef = useRef<StateSaveQueue<WorkspaceLayout> | null>(null)
  const [workspaceSaveIssue, setWorkspaceSaveIssue] = useState<string | null>(null)
  const [workspaceUpgradePreparing, setWorkspaceUpgradePreparing] = useState(false)
  if (!stateSaveQueueRef.current) {
    stateSaveQueueRef.current = new StateSaveQueue(
      (snapshot, revision) =>
        persistState(
          snapshot.runs,
          snapshot.turns,
          snapshot.sessionId,
          snapshot.layout,
          revision,
          snapshot.deletedRunIds,
          snapshot.deletedTurnIds,
        ),
      {
        debounceMs: 0,
        onSaved: (snapshot) => {
          for (const runId of snapshot.deletedRunIds ?? []) {
            deletedRunIdsRef.current.delete(runId)
          }
          setWorkspaceSaveIssue(null)
        },
        onStatusChange: (status) => {
          if (status === 'conflict') {
            setWorkspaceSaveIssue(
              'This workspace changed in another Agent Rider window. Saving stopped to protect the newer window list.',
            )
          }
        },
      },
    )
  }

  const [runs, setRuns] = useState<RunNode[]>([])
  const [resources, setResources] = useState<ResourceItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [workspaceRoot, setWorkspaceRoot] = useState(DEFAULT_WORKSPACE_CWD)
  const [passwordStatus, setPasswordStatus] = useState<PasswordStatus | null>(null)
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)
  const [agentCommandsDialogOpen, setAgentCommandsDialogOpen] = useState(false)
  const [usageSettingsDialogOpen, setUsageSettingsDialogOpen] = useState(false)
  const [versionDialogOpen, setVersionDialogOpen] = useState(false)
  const [todoOpen, setTodoOpen] = useState(false)
  const [todoMinimized, setTodoMinimized] = useState(false)
  const [agentCommands, setAgentCommands] = useState<AgentCommand[]>(defaultAgentCommands)
  const [agentCommandsHydrated, setAgentCommandsHydrated] = useState(false)
  const [browserBookmarks, setBrowserBookmarks] = useState<BrowserBookmark[]>([])
  const [browserBookmarksReady, setBrowserBookmarksReady] = useState(false)
  const [browserBookmarksError, setBrowserBookmarksError] = useState<string | null>(null)
  const [agentCommandAvailability, setAgentCommandAvailability] = useState<AgentCommandAvailability>({})
  const [usageState, setUsageState] = useState<UsageState | null>(null)
  const [usageRefreshing, setUsageRefreshing] = useState(false)
  const [usageRequestError, setUsageRequestError] = useState<string | null>(null)

  const requestUsageRefresh = useCallback((force = false) => {
    if (usageRefreshPromiseRef.current) return usageRefreshPromiseRef.current
    setUsageRefreshing(true)
    setUsageRequestError(null)
    const request = refreshUsageState(force)
      .then(setUsageState)
      .catch((cause: unknown) => {
        setUsageRequestError(cause instanceof Error ? cause.message : 'Usage refresh failed')
      })
      .finally(() => {
        if (usageRefreshPromiseRef.current === request) usageRefreshPromiseRef.current = null
        setUsageRefreshing(false)
      })
    usageRefreshPromiseRef.current = request
    return request
  }, [])

  useEffect(() => {
    if (!passwordStatus?.authenticated) {
      setBrowserBookmarks([])
      setBrowserBookmarksReady(false)
      setBrowserBookmarksError(null)
      return
    }
    let cancelled = false
    setBrowserBookmarksReady(false)
    setBrowserBookmarksError(null)
    void loadBrowserBookmarks()
      .then((bookmarks) => {
        if (cancelled) return
        setBrowserBookmarks(bookmarks)
        setBrowserBookmarksReady(true)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setBrowserBookmarksError(cause instanceof Error ? cause.message : 'Unable to load Browser bookmarks')
      })
    return () => { cancelled = true }
  }, [passwordStatus?.authenticated])

  const saveBrowserBookmarks = useCallback(async (bookmarks: BrowserBookmark[]) => {
    try {
      const saved = await persistBrowserBookmarks(bookmarks)
      setBrowserBookmarks(saved)
      setBrowserBookmarksError(null)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to save Browser bookmarks'
      setBrowserBookmarksError(message)
      throw new Error(message)
    }
  }, [])

  // Per-conversation UI state.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [metaCollapsedIds, setMetaCollapsedIds] = useState<Set<string>>(new Set())
  const [newDoneIds, setNewDoneIds] = useState<Set<string>>(new Set())
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  // Four macOS-style desktops share the Navigator, while each card/panel is
  // displayed on exactly one workspace. Legacy saves default to Desktop 1.
  const [activeDesktop, setActiveDesktop] = useState<DesktopId>(1)
  // Each desktop remembers its own tiling preset and free-grid dimensions.
  // Legacy global layout saves are expanded to all four desktops on hydration.
  const [desktopLayouts, setDesktopLayouts] = useState<Record<DesktopId, DesktopLayoutSettings>>(makeDesktopLayouts)
  const { layoutPreset, freeRows, freeCols } = desktopLayouts[activeDesktop]
  const paneSizes = desktopLayouts[activeDesktop].paneSizes?.[layoutPreset] ?? {}
  const setLayoutPreset = (layoutPreset: LayoutPreset) => {
    setDesktopLayouts((current) => ({
      ...current,
      [activeDesktop]: { ...current[activeDesktop], layoutPreset },
    }))
  }
  const setFreeRows = (value: number | ((current: number) => number)) => {
    setDesktopLayouts((current) => {
      const settings = current[activeDesktop]
      const freeRows = typeof value === 'function' ? value(settings.freeRows) : value
      return { ...current, [activeDesktop]: { ...settings, freeRows } }
    })
  }
  const setFreeCols = (value: number | ((current: number) => number)) => {
    setDesktopLayouts((current) => {
      const settings = current[activeDesktop]
      const freeCols = typeof value === 'function' ? value(settings.freeCols) : value
      return { ...current, [activeDesktop]: { ...settings, freeCols } }
    })
  }
  const setPaneTrackSizes = (axis: 'columns' | 'rows', sizes: number[]) => {
    setDesktopLayouts((current) => {
      const settings = current[activeDesktop]
      const presetSizes = settings.paneSizes?.[layoutPreset] ?? {}
      return {
        ...current,
        [activeDesktop]: {
          ...settings,
          paneSizes: {
            ...settings.paneSizes,
            [layoutPreset]: { ...presetSizes, [axis]: sizes },
          },
        },
      }
    })
  }
  const setPaneColumnRowSizes = (column: number, sizes: number[]) => {
    setDesktopLayouts((current) => {
      const settings = current[activeDesktop]
      const presetSizes = settings.paneSizes?.[layoutPreset] ?? {}
      return {
        ...current,
        [activeDesktop]: {
          ...settings,
          paneSizes: {
            ...settings.paneSizes,
            [layoutPreset]: {
              ...presetSizes,
              columnRows: { ...presetSizes.columnRows, [column]: sizes },
            },
          },
        },
      }
    })
  }
  const [desktopAssignments, setDesktopAssignments] = useState<Record<string, DesktopId>>({})
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
  const [railPanel, setRailPanel] = useState<RailPanel>('navigator')
  // Portrait viewports move the rail to a bottom tab bar and turn its menus into
  // a sheet, so the workspace keeps the full width. Which menu the sheet shows
  // (null = closed); transient, and reset whenever the layout leaves mobile.
  const mobileView = useMobileView()
  const [mobileSheet, setMobileSheet] = useState<RailPanel | null>(null)
  const closeMobileSheet = useCallback(() => setMobileSheet(null), [])
  // What the workspace actually renders with: portrait collapses every
  // multi-pane preset to the single scrolling column.
  const workspacePreset = viewportLayoutPreset(layoutPreset, mobileView)
  // Desktop highlights the menu the (always-present) panel is showing; mobile
  // highlights only the menu whose sheet is actually open.
  const railMenuActive = (panel: RailPanel) => (mobileView ? mobileSheet === panel : railPanel === panel)
  // Hovering a rail icon previews its menu: switches the panel, and (while
  // collapsed) floats it out on peek. Touch has no hover, so mobile leaves the
  // sheet alone until an actual tap.
  const showRailPanel = useCallback(
    (panel: RailPanel) => {
      if (mobileView) return
      setRailPanel(panel)
      if (sidebarCollapsed) setSidebarPeek(true)
    },
    [mobileView, sidebarCollapsed],
  )
  // Clicking pins the menu open — or collapses the rail if it's already the
  // pinned menu, so the same icon toggles. On mobile the same tap toggles the
  // bottom sheet instead, leaving the saved sidebar state untouched.
  const openRailPanel = useCallback(
    (panel: RailPanel) => {
      setRailPanel(panel)
      if (mobileView) {
        setMobileSheet((current) => nextRailSheet(current, panel))
        return
      }
      setSidebarPeek(false)
      setSidebarCollapsed((current) => (current ? false : railPanel === panel))
    },
    [mobileView, railPanel],
  )
  // Bottom-left settings gear popover.
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Empty tile placeholder → conversation picker overlay. Transient view state.
  const [openWindowPickerOpen, setOpenWindowPickerOpen] = useState(false)
  // Key of the block (card or panel) currently being dragged. Block keys: a
  // run id (`run-…`) for a card, or a panel id (`terminal-…`, `browser-…`,
  // `embed-…`, `plugin:…`, `app:…`). One drag system freely interleaves both kinds.
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [desktopContextMenu, setDesktopContextMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  // Unified display order of all blocks (cards + panels) across both columns.
  // Persisted in layout.layoutOrder; column membership is per-block (run.column
  // for cards, panelColumns for panels). New blocks append at the end.
  const [layoutOrder, setLayoutOrder] = useState<string[]>([])
  // A newly opened block spans several independent React states: its existence,
  // Desktop, order, and column. Keep its intended 2-up column synchronous until
  // runs.column/panelColumns confirms it, so the first render cannot fall back
  // to column 0 and stack under an existing left-side window.
  const pendingNewBlockColumnsRef = useRef(new Map<string, TwoUpColumn>())
  const singleColumnRef = useRef<HTMLDivElement | null>(null)
  const twoUpGridRef = useRef<HTMLDivElement | null>(null)
  const twoUpLeftRef = useRef<HTMLDivElement | null>(null)
  const twoUpRightRef = useRef<HTMLDivElement | null>(null)
  const tileGridRef = useRef<HTMLDivElement | null>(null)
  // Which conversation's workspace picker is open (null = closed).
  const [pickerRunId, setPickerRunId] = useState<string | null>(null)
  const [deletePromptRunId, setDeletePromptRunId] = useState<string | null>(null)
  // Closed (hidden) conversation cards — re-launchable from the Navigator.
  const [closedRunIds, setClosedRunIds] = useState<Set<string>>(new Set())
  // Whether the Local Terminal window is open — re-launchable from Resources.
  // Single source of truth for which workspace panels are open AND their order.
  // Panel ids: `terminal`, `terminal-…`, `browser-…`, `embed-…`, `plugin:<id>`,
  // `app:<slug>`. Persisted as layout.panelOrder so the arrangement survives
  // a reload.
  const [panelOrder, setPanelOrder] = useState<string[]>([])
  // Which column (0 = left, 1 = right) each panel sits in, so panels can be
  // dragged to sit side-by-side with conversation cards in two-column mode.
  const [panelColumns, setPanelColumns] = useState<Record<string, number>>({})
  // Collapsed/full-window chrome state for Tools and Apps, keyed by panel id.
  const [panelStates, setPanelStates] = useState<Record<string, WorkspacePanelState>>({})
  const allocatedAgentAppPorts = useMemo(
    () => Object.values(panelStates)
      .map((state) => state.appPort)
      .filter((port): port is number => typeof port === 'number'),
    [panelStates],
  )
  // File previews outlive the currently mounted Desktop. FloatingPreview owns
  // transient geometry/minimize state and stays mounted from this App scope.
  const [filePreviewsByRun, setFilePreviewsByRun] = useState<Record<string, FilePreviewWindow[]>>({})
  // Runtime Agent Apps (auto-discovered from the store backend).
  const {
    listing: appListing,
    reorder: reorderApps,
    rename: renameAppLabel,
    create: createNewAppWorkspace,
    duplicate: duplicateAppWorkspace,
    remove: removeAppWorkspace,
  } = useAgentApps(Boolean(passwordStatus?.authenticated))
  const [appLauncherOpen, setAppLauncherOpen] = useState(false)
  const [appLauncherBusy, setAppLauncherBusy] = useState(false)
  const [appLauncherError, setAppLauncherError] = useState('')
  const [appLauncherPosition, setAppLauncherPosition] = useState({ left: 64, top: 120 })

  useEffect(() => {
    if (!appLauncherOpen) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setAppLauncherOpen(false)
    }
    const closeOnResize = () => setAppLauncherOpen(false)
    document.addEventListener('keydown', closeOnEscape)
    window.addEventListener('resize', closeOnResize)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('resize', closeOnResize)
    }
  }, [appLauncherOpen])

  // Rotating back to landscape restores the pinned rail, so a sheet left open
  // must not linger as a floating panel over the desktop layout.
  useEffect(() => {
    if (!mobileView) setMobileSheet(null)
  }, [mobileView])

  useEffect(() => {
    if (!mobileSheet) return
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMobileSheet(null)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [mobileSheet])

  const updateRunFilePreviews = useCallback((runId: string, update: SetStateAction<FilePreviewWindow[]>) => {
    setFilePreviewsByRun((current) => {
      const currentPreviews = current[runId] ?? []
      const nextPreviews = typeof update === 'function' ? update(currentPreviews) : update
      if (nextPreviews === currentPreviews) return current
      if (nextPreviews.length) return { ...current, [runId]: nextPreviews }
      if (!(runId in current)) return current
      const next = { ...current }
      delete next[runId]
      return next
    })
  }, [])

  useEffect(() => {
    runsRef.current = runs
  }, [runs])

  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => {
      // A long press on Android raises the platform's Paste/Select bubble through
      // this same contextmenu event. Suppressing it everywhere left phones with no
      // way to paste into a prompt at all, so editable targets — the notepad, and
      // the transparent xterm input that touch devices stretch over the terminal
      // (see the `pointer: coarse` block in styles.css) — keep their native menu.
      const target = event.target as HTMLElement | null
      if (target?.closest?.('textarea, input, select, [contenteditable=""], [contenteditable="true"]')) return
      event.preventDefault()
    }
    document.addEventListener('contextmenu', preventNativeContextMenu, true)
    return () => document.removeEventListener('contextmenu', preventNativeContextMenu, true)
  }, [])

  useEffect(() => {
    if (!desktopContextMenu) return
    const closeMenu = () => setDesktopContextMenu(null)
    const closeMenuOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    document.addEventListener('keydown', closeMenuOnEscape)
    window.addEventListener('blur', closeMenu)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)
    return () => {
      document.removeEventListener('keydown', closeMenuOnEscape)
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [desktopContextMenu])

  function openDesktopContextMenu(key: string, clientX: number, clientY: number) {
    const menuWidth = 220
    const menuHeight = isCardKey(key) ? 246 : 206
    setDesktopContextMenu({
      key,
      x: Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8)),
    })
  }

  useEffect(() => {
    if (!passwordStatus?.authenticated) {
      setAgentCommandAvailability({})
      return
    }
    let cancelled = false
    setAgentCommandAvailability({})
    void loadAgentCommandAvailability(agentCommands).then((availability) => {
      if (!cancelled && availability) setAgentCommandAvailability(availability)
    })
    return () => {
      cancelled = true
    }
  }, [agentCommands, passwordStatus?.authenticated])

  const desktopForKey = useCallback(
    (key: string): DesktopId => desktopAssignments[key] ?? 1,
    [desktopAssignments],
  )
  const activePanelOrder = useMemo(
    () => panelOrder.filter((panelId) => desktopForKey(panelId) === activeDesktop),
    [panelOrder, desktopForKey, activeDesktop],
  )
  const terminalOpen = activePanelOrder.some(isLocalTerminalPanelId)
  const browserOpen = activePanelOrder.some(isBrowserPanelId)
  const agentAppOpen = activePanelOrder.some(isEmbedPanelId)
  const [browserLaunchState, setBrowserLaunchState] = useState<'idle' | 'checking' | 'installing'>('idle')
  const openPluginIds = useMemo(
    () => new Set(activePanelOrder.filter((p) => p.startsWith('plugin:')).map((p) => p.slice('plugin:'.length))),
    [activePanelOrder],
  )
  const openAppSlugs = useMemo(
    () =>
      new Set(
        activePanelOrder
          .filter((panelId) => panelId.startsWith('app:'))
          .map((panelId) => panelId.slice('app:'.length)),
      ),
    [activePanelOrder],
  )
  const openRegisteredAgentAppIds = useMemo(
    () => new Set(
      panelOrder
        .filter(isEmbedPanelId)
        .map((panelId) => panelStates[panelId]?.appId)
        .filter((appId): appId is string => Boolean(appId)),
    ),
    [panelOrder, panelStates],
  )
  const launcherOpenAppIds = useMemo(
    () => new Set([...openAppSlugs, ...openRegisteredAgentAppIds]),
    [openAppSlugs, openRegisteredAgentAppIds],
  )

  function switchDesktop(desktop: DesktopId) {
    setActiveDesktop(desktop)
    setDraggingKey(null)
    setDesktopContextMenu(null)
    setMaximizedKey(null)
    setOpenWindowPickerOpen(false)
  }

  function openPanel(panelId: string) {
    if (panelOrder.includes(panelId)) {
      const panelDesktop = desktopForKey(panelId)
      if (panelDesktop !== activeDesktop) switchDesktop(panelDesktop)
    } else {
      placeNewBlock(panelId)
    }
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
  const launchLocalTerminal = () => openPanel(makeId('terminal'))
  const launchRegisteredAgentApp = (app: AgentApp) => {
    if (app.kind === 'static') {
      launchApp(app.id)
      return
    }
    const panelId = registeredAgentAppPanelId(app.id)
    const defaultAgentCommand = agentCommands.find((command) => agentCommandAvailability[command.id] !== false)
      ?? agentCommands[0]
      ?? DEFAULT_AGENT_COMMANDS.find((command) => command.id === 'default-codex')
    setPanelStates((current) => ({
      ...current,
      [panelId]: {
        ...(current[panelId] ?? {}),
        appId: app.id,
        appName: current[panelId]?.appName ?? app.label,
        appIcon: app.icon,
        appLocation: app.location,
        appSplit: current[panelId]?.appSplit ?? AGENT_APP_DEFAULT_SPLIT,
        agentCommand: current[panelId]?.agentCommand
          ?? defaultAgentCommand?.command
          ?? 'codex --yolo',
      },
    }))
    openPanel(panelId)
  }

  async function createAndLaunchAgentApp() {
    if (appLauncherBusy) return
    setAppLauncherBusy(true)
    setAppLauncherError('')
    const app = await createNewAppWorkspace()
    setAppLauncherBusy(false)
    if (!app) {
      setAppLauncherError('Could not create the Agent App workspace.')
      return
    }
    launchRegisteredAgentApp(app)
    setAppLauncherOpen(false)
  }

  async function deleteRegisteredAgentApp(app: AgentApp) {
    if (appLauncherBusy) return
    if (!window.confirm(`Delete "${app.label}" and all files in ${app.location}?`)) return
    setAppLauncherBusy(true)
    setAppLauncherError('')
    const removed = await removeAppWorkspace(app.id)
    setAppLauncherBusy(false)
    if (!removed) {
      setAppLauncherError(`Could not delete ${app.label}.`)
      return
    }
    const appPanelIds = new Set([`app:${app.id}`, registeredAgentAppPanelId(app.id)])
    setPanelOrder((current) => current.filter((panelId) => !appPanelIds.has(panelId)))
  }

  function renameRegisteredAgentApp(app: AgentApp) {
    const nextLabel = window.prompt('Rename Agent App', app.label)?.trim()
    if (!nextLabel || nextLabel === app.label) return
    renameAppLabel(app.id, nextLabel)
    const panelId = registeredAgentAppPanelId(app.id)
    setPanelStates((current) => current[panelId]
      ? { ...current, [panelId]: { ...current[panelId], appName: nextLabel } }
      : current)
  }

  async function duplicateRegisteredAgentApp(app: AgentApp) {
    if (appLauncherBusy) return
    setAppLauncherBusy(true)
    setAppLauncherError('')
    const duplicated = await duplicateAppWorkspace(app.id)
    setAppLauncherBusy(false)
    if (!duplicated) {
      setAppLauncherError(`Could not duplicate ${app.label}.`)
    }
  }

  function toggleAppLauncher(button: HTMLButtonElement) {
    if (appLauncherOpen) {
      setAppLauncherOpen(false)
      return
    }
    const rect = button.getBoundingClientRect()
    const menuWidth = Math.min(430, window.innerWidth - 24, (window.innerHeight - 24) * (9 / 19.5))
    const menuHeight = menuWidth * (19.5 / 9)
    setAppLauncherPosition(
      mobileView
        ? {
            // The tab bar sits at the bottom edge, so the phone-shaped launcher
            // is centred over the workspace instead of beside its icon.
            left: Math.max(12, (window.innerWidth - menuWidth) / 2),
            top: Math.max(12, (window.innerHeight - menuHeight) / 2 - 12),
          }
        : {
            left: Math.max(12, Math.min(rect.right + 10, window.innerWidth - menuWidth - 12)),
            top: Math.max(12, Math.min(rect.top - 110, window.innerHeight - menuHeight - 12)),
          },
    )
    setAppLauncherError('')
    setAppLauncherOpen(true)
  }

  function setPanelColumn(panelId: string, column: number) {
    setPanelColumns((current) => ({ ...current, [panelId]: column }))
  }

  function updatePanelState(panelId: string, patch: WorkspacePanelState) {
    setPanelStates((current) => {
      const nextState = { ...(current[panelId] ?? {}), ...patch }
      return { ...current, [panelId]: normalizeWorkspacePanelState(nextState, panelId) }
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
  const desktopVisibleRuns = useMemo(
    () => visibleRuns.filter((run) => desktopForKey(run.id) === activeDesktop),
    [visibleRuns, desktopForKey, activeDesktop],
  )
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
    const defaultAgentCommand = agentCommands.find((command) => agentCommandAvailability[command.id] !== false)
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
      agentType: 'custom',
      agentCommand: defaultAgentCommand?.command ?? '',
      cardKind: 'conversation',
      column: 0,
      createdAt: new Date().toISOString(),
    }
    setRuns((current) => [run, ...current])
    placeNewBlock(run.id)
    setActiveRunId(run.id)
  }

  // Duplicate a card's configuration into a fresh conversation/session. The
  // source's visible title is materialized before adding the suffix so even a
  // card whose title currently falls back to Project or Prompt gets the name
  // the user sees. Transient terminal state is intentionally not shared.
  function duplicateConversation(runId: string) {
    const source = runs.find((run) => run.id === runId)
    if (!source) return

    const duplicate: RunNode = {
      ...source,
      id: makeId('run'),
      task: `${conversationTitle(source)} - copy`,
      categoryTags: [...(source.categoryTags ?? [])],
      resourceIds: [...(source.resourceIds ?? [])],
      createdAt: new Date().toISOString(),
    }
    const sourceDesktop = desktopForKey(runId)

    setRuns((current) => [duplicate, ...current])
    setDesktopAssignments((current) => ({ ...current, [duplicate.id]: sourceDesktop }))
    setLayoutOrder((current) => {
      const withoutDuplicate = current.filter((key) => key !== duplicate.id)
      const sourceIndex = withoutDuplicate.indexOf(runId)
      if (sourceIndex < 0) return [...withoutDuplicate, duplicate.id]
      return [
        ...withoutDuplicate.slice(0, sourceIndex + 1),
        duplicate.id,
        ...withoutDuplicate.slice(sourceIndex + 1),
      ]
    })
    if (layoutPreset === 'free' && orderedKeys.length + 1 > freeRows * freeCols) {
      setFreeRows(Math.ceil((orderedKeys.length + 1) / freeCols))
    }
    setActiveRunId(duplicate.id)
  }

  async function launchBrowser() {
    if (browserLaunchState !== 'idle') return
    setBrowserLaunchState('checking')
    try {
      const statusResponse = await fetch('/store/browser/status')
      const status = await statusResponse.json() as {
        ready?: boolean
        available?: boolean
        embeddedReady?: boolean
        externalReady?: boolean
        installable?: boolean
        error?: string
        missingPrerequisites?: string[]
      }
      if (!statusResponse.ok) throw new Error(status.error || 'Unable to check browser dependencies')
      if (!status.available && !status.ready) {
        if (status.installable === false) throw new Error(status.error || 'Automatic browser installation is not available on this host')
        const approved = window.confirm('Download and install Google Chrome Stable and Selkies v1.6.2 into your user data directory now? No administrator access is required.')
        if (!approved) return
        setBrowserLaunchState('installing')
        const installResponse = await fetch('/store/browser/install', { method: 'POST' })
        const installed = await installResponse.json() as { ready?: boolean; error?: string }
        if (!installResponse.ok || !installed.ready) throw new Error(installed.error || 'Browser installation failed')
        window.alert('Browser installation completed.')
      }
      const panelId = makeId('browser')
      openPanel(panelId)
      if (status.externalReady && !status.embeddedReady && !status.ready) {
        updatePanelState(panelId, { browserMode: 'external' })
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    } finally {
      setBrowserLaunchState('idle')
    }
  }

  // Edit a conversation's Category / Project / Workspace in place.
  function updateRunContext(runId: string, patch: Partial<RunNode>) {
    setRuns((current) => current.map((run) => (run.id === runId ? { ...run, ...patch } : run)))
  }

  function saveAgentCommands(nextCommands: AgentCommand[]) {
    const nextById = new Map(nextCommands.map((item) => [item.id, item]))
    const editedCommands = new Map(
      agentCommands.flatMap((item) => {
        const replacement = nextById.get(item.id)
        return replacement && replacement.command !== item.command ? [[item.command, replacement.command] as const] : []
      }),
    )
    if (editedCommands.size) {
      setRuns((current) => current.map((run) => {
        if (run.agentType !== 'custom') return run
        const replacement = editedCommands.get((run.agentCommand ?? '').trim())
        return replacement ? { ...run, agentCommand: replacement } : run
      }))
      setPanelStates((current) => remapAgentAppPanelCommands(current, editedCommands))
    }
    setAgentCommands(nextCommands)
    void persistAgentCommandsSetting(nextCommands)
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
    updateRunFilePreviews(runId, [])
  }

  // ── Unified block ordering (cards + panels) ────────────────────────────────
  const isCardKey = (key: string) => key.startsWith('run-')
  const storedColumnOf = (key: string) =>
    isCardKey(key) ? runs.find((run) => run.id === key)?.column ?? 0 : panelColumns[key] ?? 0
  const columnOf = (key: string) => pendingNewBlockColumnsRef.current.get(key) ?? storedColumnOf(key)
  const setColumnOf = (key: string, column: number) => {
    if (isCardKey(key)) updateRunContext(key, { column })
    else setPanelColumn(key, column)
  }

  // The display order of every visible block. Honors layoutOrder, then appends
  // any newly-added block (card/panel) not yet placed.
  const orderedKeys = useMemo(() => {
    const live = [...activePanelOrder, ...desktopVisibleRuns.map((run) => run.id)]
    const liveSet = new Set(live)
    const placed = layoutOrder.filter((key) => liveSet.has(key))
    const placedSet = new Set(placed)
    const missing = live.filter((key) => !placedSet.has(key))
    return [...placed, ...missing]
  }, [activePanelOrder, desktopVisibleRuns, layoutOrder])

  useLayoutEffect(() => {
    const liveKeys = new Set(orderedKeys)
    for (const [key, column] of pendingNewBlockColumnsRef.current) {
      if (!liveKeys.has(key)) continue
      if (storedColumnOf(key) === column) {
        pendingNewBlockColumnsRef.current.delete(key)
      } else {
        // Re-apply after the block exists. This closes the race with an older
        // queued runs/panelColumns snapshot without changing later user drags.
        setColumnOf(key, column)
      }
    }
  }, [orderedKeys, runs, panelColumns])

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
    const liveSet = new Set(live)
    setLayoutOrder((current) => [
      ...current.filter((item) => item !== key && !liveSet.has(item)),
      ...live,
      key,
    ])
    setDesktopAssignments((current) => (
      current[key] === activeDesktop ? current : { ...current, [key]: activeDesktop }
    ))
    // The stack presets have no implicit slots, so the emptier column stands in
    // for "the pane with no window".
    if (layoutPreset === 'two-up') {
      const column = nextTwoUpColumn(live, columnOf)
      pendingNewBlockColumnsRef.current.set(key, column)
      setColumnOf(key, column)
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

  // The window context menu transfers a block to the requested Desktop and
  // puts it after the destination's existing windows.
  function sendBlockToDesktop(key: string, desktop: DesktopId) {
    if (desktopForKey(key) === desktop) return

    const destinationKeys = [
      ...panelOrder.filter((panelId) => panelId !== key && desktopForKey(panelId) === desktop),
      ...visibleRuns.filter((run) => run.id !== key && desktopForKey(run.id) === desktop).map((run) => run.id),
    ]
    const destinationLayout = desktopLayouts[desktop]
    if (destinationLayout.layoutPreset === 'two-up') {
      const left = destinationKeys.filter((item) => columnOf(item) === 0).length
      const right = destinationKeys.filter((item) => columnOf(item) === 1).length
      setColumnOf(key, right < left ? 1 : 0)
    }
    if (
      destinationLayout.layoutPreset === 'free'
      && destinationKeys.length + 1 > destinationLayout.freeRows * destinationLayout.freeCols
    ) {
      setDesktopLayouts((current) => ({
        ...current,
        [desktop]: {
          ...current[desktop],
          freeRows: Math.ceil((destinationKeys.length + 1) / current[desktop].freeCols),
        },
      }))
    }

    setDesktopAssignments((current) => ({ ...current, [key]: desktop }))
    setLayoutOrder((current) => [...current.filter((item) => item !== key), key])
  }

  // Drop the dragged block before/after a target block (any mix of card/panel),
  // inheriting the target's column in two-column mode. Tile presets ignore
  // per-block columns — grid position is implicit from layoutOrder.
  function handleDropOnBlock(targetKey: string, after: boolean) {
    if (!draggingKey || draggingKey === targetKey) return
    if (layoutPreset === 'two-up') setColumnOf(draggingKey, columnOf(targetKey))
    const reordered = reorderKeys(orderedKeys, draggingKey, targetKey, after)
    const activeKeys = new Set(orderedKeys)
    setLayoutOrder((current) => [...current.filter((key) => !activeKeys.has(key)), ...reordered])
    setDraggingKey(null)
  }

  // Drop onto a column's empty space → append to the end of that column.
  function handleDropToColumn(column: number) {
    if (!draggingKey) return
    if (layoutPreset === 'two-up') setColumnOf(draggingKey, column)
    const reordered = reorderKeys(orderedKeys, draggingKey, null, false)
    const activeKeys = new Set(orderedKeys)
    setLayoutOrder((current) => [...current.filter((key) => !activeKeys.has(key)), ...reordered])
    setDraggingKey(null)
  }

  // Drop onto the tile grid's empty space (not on a specific block) → append
  // to the end of the shared order.
  function handleDropToEnd() {
    if (!draggingKey) return
    const reordered = reorderKeys(orderedKeys, draggingKey, null, false)
    const activeKeys = new Set(orderedKeys)
    setLayoutOrder((current) => [...current.filter((key) => !activeKeys.has(key)), ...reordered])
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
    deletedRunIdsRef.current.add(runId)
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
    setDesktopAssignments((current) => {
      if (!(runId in current)) return current
      const next = { ...current }
      delete next[runId]
      return next
    })
    setPanelStates((current) => {
      const key = agentTerminalStateKey(runId)
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    updateRunFilePreviews(runId, [])
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
    const isClosed = closedRunIds.has(runId)
    // Re-launching a closed card gives it the first free pane; a card that's
    // already on screen keeps its slot and is only focused.
    if (isClosed) {
      placeNewBlock(runId)
    } else {
      const runDesktop = desktopForKey(runId)
      if (runDesktop !== activeDesktop) switchDesktop(runDesktop)
    }
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
    let retryHandle: number | null = null
    const loadStatus = async () => {
      const status = await loadPasswordStatus()
      if (cancelled) return
      if (status) {
        setPasswordStatus(status)
        return
      }
      retryHandle = window.setTimeout(() => {
        void loadStatus()
      }, 1_000)
    }
    void loadStatus()
    return () => {
      cancelled = true
      if (retryHandle !== null) window.clearTimeout(retryHandle)
    }
  }, [])

  // An already-open SPA keeps executing its old JavaScript after the application
  // service switches releases. Once the new backend is healthy, stop the old
  // client from writing and reload so the new bundle hydrates the durable
  // workspace topology from SQLite.
  useEffect(() => {
    if (!passwordStatus?.authenticated) return
    let cancelled = false
    const detectApplicationUpgrade = async () => {
      const info = await loadVersionInfo()
      const reloadUrl = 'error' in info
        ? null
        : applicationUpgradeReloadUrl(info.app.sourceCommit, window.location.href)
      if (cancelled || upgradeReloadStartedRef.current || 'error' in info) return

      if (reloadUrl) {
        upgradeReloadStartedRef.current = true
        const saved = await stateSaveQueueRef.current?.drainAndPause()
        if (!saved) {
          upgradeReloadStartedRef.current = false
          setWorkspaceSaveIssue(
            'Agent Rider stopped the reload because the newest workspace changes were not saved. It will keep the current page open.',
          )
          return
        }
        if (cancelled) return
        window.location.replace(reloadUrl)
        return
      }

      if (!info.upgradePreparing) {
        if (upgradePreparedRef.current) {
          upgradePreparedRef.current = false
          stateSaveQueueRef.current?.resume()
          setWorkspaceUpgradePreparing(false)
        }
        return
      }
      if (upgradePreparedRef.current || upgradePrepareStartedRef.current) return

      upgradePrepareStartedRef.current = true
      setWorkspaceUpgradePreparing(true)
      setWorkspaceSaveIssue(null)
      const saved = await stateSaveQueueRef.current?.drainAndPause()
      const revision = stateSaveQueueRef.current?.currentRevision()
      const acknowledged = Boolean(
        saved
        && revision !== undefined
        && await acknowledgeWorkspaceUpgrade(revision),
      )
      upgradePrepareStartedRef.current = false
      if (cancelled) return
      if (!acknowledged) {
        stateSaveQueueRef.current?.resume()
        setWorkspaceUpgradePreparing(false)
        setWorkspaceSaveIssue(
          'Agent Rider could not confirm the newest workspace revision to the updater. The current page and saved workspace remain open.',
        )
        return
      }
      upgradePreparedRef.current = true
    }
    void detectApplicationUpgrade()
    const interval = window.setInterval(() => {
      void detectApplicationUpgrade()
    }, APP_BUILD_CHECK_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [passwordStatus?.authenticated])

  useEffect(() => {
    if (!passwordStatus?.authenticated) {
      setUsageState(null)
      setUsageRequestError(null)
      return
    }
    let cancelled = false
    const refreshWhileVisible = () => {
      if (!cancelled && document.visibilityState === 'visible') void requestUsageRefresh(false)
    }
    const visibilityChanged = () => {
      if (document.visibilityState === 'visible') refreshWhileVisible()
    }
    void loadUsageState()
      .then((state) => {
        if (!cancelled) setUsageState(state)
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setUsageRequestError(cause instanceof Error ? cause.message : 'Usage state could not be loaded')
        }
      })
      .finally(refreshWhileVisible)
    const interval = window.setInterval(refreshWhileVisible, USAGE_POLL_INTERVAL_MS)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [passwordStatus?.authenticated, requestUsageRefresh])

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
    let retryHandle: number | null = null
    const hydrate = async () => {
      const bootstrap = await loadWorkspaceBootstrap()
      if (cancelled) return
      // A transient failure while agrider.service changes versions must never
      // be treated as a legitimate empty database. Stay read-only and retry;
      // only a successful /store/state response may arm the save queue.
      if (!bootstrap) {
        retryHandle = window.setTimeout(() => {
          void hydrate()
        }, 1_000)
        return
      }
      const { state, agentCommandsSetting } = bootstrap
      let legacyAgentCommands: AgentCommand[] | null = null
      const layout = state.layout
      const storedRuns = state.runs as RunNode[]
      const closedRunIds = new Set(Array.isArray(layout?.closedRunIds) ? layout.closedRunIds : [])
      const legacyBrowserRuns = storedRuns.filter((run) => isLegacyBrowserRunId(run.id) && !closedRunIds.has(run.id))
      const legacyBrowserPanelIds = legacyBrowserRuns.map((run) => legacyBrowserPanelId(run.id))
      // Merge defensively: never clobber content the user already created this session.
      if (state.runs.length) {
        // Legacy Hermes cards are migrated to Codex. Browser runs are moved
        // into standalone workspace panels instead of restoring as cards.
        const restored = storedRuns.filter((run) => !isLegacyBrowserRunId(run.id)).map((run) => {
          const cardKind: RunCardKind = isAppBuilderRunId(run.id) ? 'app-builder' : 'conversation'
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
        // Missing legacy visibility data means visible. Hiding every restored
        // Card except the first made a downgraded layout look like data loss.
        const restoredClosedRunIds = layoutRunIdSet(layout?.closedRunIds, restoredRunIds)
        if (restoredClosedRunIds) {
          setClosedRunIds((current) => (current.size ? current : restoredClosedRunIds))
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
      // Restore the complete workspace topology: open windows, their global
      // order, columns, Desktop assignments, and per-Desktop pane geometry.
      if (layout) {
        if (Array.isArray(layout.panelOrder) || legacyBrowserPanelIds.length) {
          const migratedOrder = [...new Set(
            [...(Array.isArray(layout.panelOrder) ? layout.panelOrder : []), ...legacyBrowserPanelIds]
              .filter((panelId) => !RETIRED_PLUGIN_PANEL_IDS.has(panelId))
              .map(migrateWorkspaceKey)
              .filter((panelId): panelId is string => Boolean(panelId)),
          )]
          setPanelOrder((current) => (current.length ? current : migratedOrder))
        }
        if ((layout.panelColumns && typeof layout.panelColumns === 'object') || legacyBrowserRuns.length) {
          const migratedColumns = {
            ...Object.fromEntries(
              Object.entries((layout.panelColumns ?? {}) as Record<string, number>)
                .filter(([key]) => !RETIRED_PLUGIN_PANEL_IDS.has(key))
                .flatMap(([key, column]) => {
                  const migratedKey = migrateWorkspaceKey(key)
                  return migratedKey ? [[migratedKey, column]] : []
                }),
            ),
            ...Object.fromEntries(legacyBrowserRuns.map((run) => [legacyBrowserPanelId(run.id), Number.isFinite(run.column) ? run.column : 0])),
          }
          setPanelColumns((current) => (Object.keys(current).length ? current : migratedColumns))
        }
        if (Array.isArray(layout.layoutOrder) || legacyBrowserPanelIds.length) {
          const migratedLayout = [...new Set(
            [...(Array.isArray(layout.layoutOrder) ? layout.layoutOrder : []), ...legacyBrowserPanelIds]
              .filter((panelId) => !RETIRED_PLUGIN_PANEL_IDS.has(panelId))
              .map(migrateWorkspaceKey)
              .filter((panelId): panelId is string => Boolean(panelId)),
          )]
          setLayoutOrder((current) => (current.length ? current : migratedLayout))
        }
        const legacyLayout: DesktopLayoutSettings = {
          layoutPreset: isLayoutPreset(layout.layoutPreset)
            ? layout.layoutPreset
            : layout.workspaceColumns === 2
              ? 'two-up'
              : 'single',
          freeRows: typeof layout.freeRows === 'number' && layout.freeRows > 0 ? layout.freeRows : DEFAULT_DESKTOP_LAYOUT.freeRows,
          freeCols: typeof layout.freeCols === 'number' && layout.freeCols > 0 ? layout.freeCols : DEFAULT_DESKTOP_LAYOUT.freeCols,
        }
        setDesktopLayouts(normalizeDesktopLayouts(layout.desktopLayouts, legacyLayout))
        if (typeof layout.sidebarCollapsed === 'boolean') {
          setSidebarCollapsed(layout.sidebarCollapsed)
        }
        if (isDesktopId(layout.activeDesktop)) setActiveDesktop(layout.activeDesktop)
        if (layout.desktopAssignments && typeof layout.desktopAssignments === 'object') {
          const restoredAssignments = normalizeDesktopAssignments(layout.desktopAssignments)
          setDesktopAssignments((current) => (
            Object.keys(current).length ? current : restoredAssignments
          ))
        }
        const restoredAgentCommands = normalizeAgentCommands(layout.agentCommands)
        legacyAgentCommands =
          layout.agentCommandsInitialized || restoredAgentCommands.length
            ? restoredAgentCommands
            : null
        if (layout.panelStates && typeof layout.panelStates === 'object') {
          setPanelStates((current) => (Object.keys(current).length ? current : normalizePanelStates(layout.panelStates)))
        }
      }
      const durableAgentCommands = normalizeAgentCommands(agentCommandsSetting.commands)
      const restoredAgentCommands = agentCommandsSetting.initialized
        ? durableAgentCommands
        : legacyAgentCommands ?? defaultAgentCommands()
      setAgentCommands(restoredAgentCommands)
      if (!agentCommandsSetting.initialized && legacyAgentCommands) {
        void persistAgentCommandsSetting(legacyAgentCommands)
      }
      stateSaveQueueRef.current?.initialize(state.revision)
      hydratedRef.current = true
      setAgentCommandsHydrated(true)
    }
    void hydrate()
    return () => {
      cancelled = true
      if (retryHandle !== null) window.clearTimeout(retryHandle)
    }
  }, [passwordStatus?.authenticated])

  // Queue the newest full snapshot. The queue debounces ordinary UI churn,
  // serializes writes, and retries across an application-service upgrade.
  useEffect(() => {
    if (
      upgradeReloadStartedRef.current
      || !hydratedRef.current
      || !agentCommandsHydrated
      || !passwordStatus?.authenticated
    ) return
    stateSaveQueueRef.current?.enqueue({
      runs,
      turns: [],
      sessionId: null,
      deletedRunIds: [...deletedRunIdsRef.current],
      layout: {
        panelOrder,
        panelColumns,
        layoutOrder,
        layoutPreset,
        freeRows,
        freeCols,
        desktopLayouts,
        sidebarCollapsed,
        activeDesktop,
        desktopAssignments,
        agentCommands,
        agentCommandsInitialized: true,
        closedRunIds: [...closedRunIds],
        collapsedRunIds: [...collapsedIds],
        cardMetaCollapsedIds: [...metaCollapsedIds],
        unreadRunIds: [...newDoneIds],
        panelStates,
      },
    })
  }, [runs, panelOrder, panelColumns, layoutOrder, layoutPreset, freeRows, freeCols, desktopLayouts, sidebarCollapsed, activeDesktop, desktopAssignments, agentCommands, closedRunIds, collapsedIds, metaCollapsedIds, newDoneIds, panelStates, passwordStatus?.authenticated])

  // A normal upgrade leaves the page mounted, so the queue's retry is the main
  // protection. Flushing on background/pagehide also shortens the window for a
  // user-initiated reload or tab close.
  useEffect(() => {
    const flush = () => {
      void stateSaveQueueRef.current?.flushNow()
    }
    const visibilityChanged = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [])

  const renderRunCard = (run: RunNode, paneIndex?: number, paneWeight?: number) => (
    <ConversationCard
      key={run.id}
      run={run}
      paneIndex={paneIndex}
      paneWeight={paneWeight}
      filePreviews={filePreviewsByRun[run.id] ?? []}
      onFilePreviewsChange={(update) => updateRunFilePreviews(run.id, update)}
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
      agentCommands={agentCommands}
      agentCommandAvailability={agentCommandAvailability}
      onAgentCommandSelect={(command) => updateRunContext(run.id, { agentType: 'custom', agentCommand: command.command })}
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

  const floatingPreviewNodes = Object.entries(filePreviewsByRun).flatMap(([runId, previews]) =>
    previews.map((preview) => (
      <FloatingPreview
        key={`${runId}\0${preview.path}`}
        preview={preview}
        visible={desktopForKey(runId) === activeDesktop && !closedRunIds.has(runId)}
        onPreviewChange={(nextPreview) => updateRunFilePreviews(
          runId,
          (current) => current.map((item) => item.path === preview.path
            ? mergeRefreshedFilePreview(item, nextPreview)
            : item),
        )}
        onClose={() => updateRunFilePreviews(
          runId,
          (current) => current.filter((item) => item.path !== preview.path),
        )}
      />
    )),
  )

  // Resolve a panel id to its content + draggable wrapper (null if the
  // referenced plugin/app no longer exists).
  const renderPanelBlock = (panelId: string, paneIndex?: number, paneWeight?: number) => {
    const panelMaximized = maximizedKey === panelId
    const togglePanelMaximize = () => setMaximizedKey((current) => (current === panelId ? null : panelId))
    let content: ReactNode = null
    if (isLocalTerminalPanelId(panelId)) {
      content = (
        <WebTerminal
          initialCwd={workspaceRoot}
          sessionKey={localTerminalSessionId(panelId)}
          onClose={() => closePanel(panelId)}
          collapsed={panelStates[panelId]?.collapsed}
          fullWindow={panelStates[panelId]?.fullWindow}
          onStateChange={(patch) => updatePanelState(panelId, patch)}
          notepad={panelStates[panelId]?.notepad}
          onNotepadChange={(text) => updatePanelState(panelId, { notepad: text })}
        />
      )
    } else if (isBrowserPanelId(panelId)) {
      content = (
        <BrowserPanel
          panelId={panelId}
          onClose={() => closePanel(panelId)}
          collapsed={panelStates[panelId]?.collapsed}
          fullWindow={panelStates[panelId]?.fullWindow}
          browserMode={panelStates[panelId]?.browserMode}
          browserAddress={panelStates[panelId]?.browserAddress}
          browserUrl={panelStates[panelId]?.browserUrl}
          bookmarks={browserBookmarks}
          bookmarksReady={browserBookmarksReady}
          bookmarksError={browserBookmarksError}
          onBookmarksChange={saveBrowserBookmarks}
          onStateChange={(patch) => updatePanelState(panelId, patch)}
        />
      )
    } else if (isEmbedPanelId(panelId)) {
      const state = panelStates[panelId] ?? {}
      const fallbackAgentCommand = agentCommands.find((command) => agentCommandAvailability[command.id] !== false)
        ?? agentCommands[0]
        ?? DEFAULT_AGENT_COMMANDS.find((command) => command.id === 'default-codex')
      const agentCommand = state.agentCommand
        || fallbackAgentCommand?.command
        || 'codex --yolo'
      const agentLabel = agentCommands.find((command) => command.command === agentCommand)?.name ?? 'TUI agent'
      const registeredApp = state.appId
        ? appListing.apps.find((app) => app.id === state.appId)
        : undefined
      content = (
        <AgentAppPanel
          panelId={panelId}
          appId={state.appId}
          appName={state.appName}
          appPort={state.appPort}
          appSplit={state.appSplit}
          appChatCollapsed={state.appChatCollapsed}
          notepad={state.notepad}
          agentCommand={agentCommand}
          agentLabel={agentLabel}
          agentCommands={agentCommands}
          agentCommandAvailability={agentCommandAvailability}
          usedPorts={allocatedAgentAppPorts}
          workspaceRoot={registeredApp?.location ?? state.appLocation ?? workspaceRoot}
          onNameCommit={(name) => {
            if (state.appId) renameAppLabel(state.appId, name)
          }}
          onClose={() => closePanel(panelId)}
          collapsed={state.collapsed}
          fullWindow={state.fullWindow}
          maximized={panelMaximized}
          onToggleMaximize={togglePanelMaximize}
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
        paneIndex={paneIndex}
        paneWeight={paneWeight}
        dragging={draggingKey === panelId}
        dragActive={draggingKey !== null && draggingKey !== panelId}
        onDragStartPanel={() => setDraggingKey(panelId)}
        onDragEndPanel={() => setDraggingKey(null)}
        onDropOnPanel={(after) => handleDropOnBlock(panelId, after)}
        enableDesktopContextMenu={isLocalTerminalPanelId(panelId) || isBrowserPanelId(panelId) || isEmbedPanelId(panelId)}
      >
        {content}
      </DraggablePanel>
    )
  }

  // Render one block (card or panel) by key.
  const renderBlock = (key: string, paneIndex?: number, paneWeight?: number) => {
    if (isCardKey(key)) {
      const run = visibleRuns.find((r) => r.id === key)
      return run ? renderRunCard(run, paneIndex, paneWeight) : null
    }
    return renderPanelBlock(key, paneIndex, paneWeight)
  }

  // One workspace column: its blocks (cards + panels interleaved) in display
  // order. `col` filters by column in two-column mode; pass null for the
  // single-column layout. The column is a drop zone that reassigns a dropped
  // block to this column and moves it to the end.
  const renderWorkspaceColumn = (
    col: number | null,
    containerRef: { current: HTMLDivElement | null },
  ) => {
    const keys = col === null ? orderedKeys : orderedKeys.filter((key) => columnOf(key) === col)
    const dragActive = draggingKey !== null
    const savedRows = col === null ? paneSizes.rows : paneSizes.columnRows?.[String(col)]
    const rowSizes = fittedPaneSizes(savedRows, keys.length)
    const dividers = keys.slice(0, -1).flatMap((key, index) => {
      const nextKey = keys[index + 1]
      const collapsed = isCardKey(key) ? collapsedIds.has(key) : Boolean(panelStates[key]?.collapsed)
      const nextCollapsed = isCardKey(nextKey) ? collapsedIds.has(nextKey) : Boolean(panelStates[nextKey]?.collapsed)
      return collapsed || nextCollapsed
        ? []
        : [{ trackIndex: index, beforePane: index, afterPane: index + 1 }]
    })
    return (
      <div
        key={col ?? 'single'}
        ref={containerRef}
        data-pane-index={col ?? undefined}
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
        {keys.map((key, index) => renderBlock(key, index, rowSizes[index]))}
        {/* Mobile gives each window a fixed screenful and scrolls the column, so
            there are no shared tracks to split — and an 8px drag handle is not a
            touch target worth aiming at. */}
        {mobileView ? null : (
          <PaneDividerLayer
            containerRef={containerRef}
            axis="y"
            sizes={rowSizes}
            dividers={dividers}
            minPaneSize={96}
            onSizesChange={(sizes) => (
              col === null ? setPaneTrackSizes('rows', sizes) : setPaneColumnRowSizes(col, sizes)
            )}
          />
        )}
      </div>
    )
  }

  // Grid template for the tile presets (quad / three-col / master-stack /
  // free). These are true CSS grids: the column count is fixed by the preset,
  // but rows auto-grow as more blocks open — closest to the old stack
  // behavior while giving each preset its distinctive shape.
  function tileGridStyle(columnSizes: number[], rowSizes: number[]): CSSProperties {
    // alignItems:stretch is set inline because `.ws-columns { align-items: start }`
    // otherwise wins the cascade over `.tile-grid { align-items: stretch }` (same
    // specificity, later in the file), leaving tile slots at content height so
    // cards can't fill their (full-height) grid row.
    const base: CSSProperties = { display: 'grid', columnGap: '2px', rowGap: '2px', alignItems: 'stretch' }
    // quad: the 4 canonical slots live in two explicit rows that split the
    // viewport 50/50 (no scroll); any blocks beyond 4 spill into auto rows
    // (fixed min → the page scrolls, preserving the auto-grow overflow model).
    if (layoutPreset === 'quad') return { ...base, gridTemplateColumns: paneGridTracks(columnSizes), gridTemplateRows: paneGridTracks(rowSizes), gridAutoRows: 'minmax(280px, 1fr)' }
    if (layoutPreset === 'three-col') return { ...base, gridTemplateColumns: paneGridTracks(columnSizes), gridTemplateRows: paneGridTracks(rowSizes), gridAutoRows: 'minmax(240px, 1fr)' }
    // master+stack: three explicit rows so the three stack panes each take a
    // third of the viewport height (master spans all three); extra stack panes
    // spill into auto rows and scroll.
    if (layoutPreset === 'master-stack') return { ...base, gridTemplateColumns: paneGridTracks(columnSizes), gridTemplateRows: paneGridTracks(rowSizes), gridAutoRows: 'minmax(160px, 1fr)' }
    return { ...base, gridTemplateColumns: paneGridTracks(columnSizes), gridTemplateRows: paneGridTracks(rowSizes), gridAutoRows: 'minmax(200px, 1fr)' }
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
    const columnCount = layoutPreset === 'three-col' ? 3 : layoutPreset === 'free' ? freeCols : 2
    const rowCount = layoutPreset === 'master-stack' ? 3 : layoutPreset === 'free' ? freeRows : layoutPreset === 'quad' ? 2 : 1
    const columnSizes = fittedPaneSizes(
      paneSizes.columns,
      columnCount,
      layoutPreset === 'master-stack' ? [1.9, 1] : [],
    )
    const rowSizes = fittedPaneSizes(paneSizes.rows, rowCount)
    const columnDividers = Array.from({ length: Math.max(0, columnCount - 1) }, (_, index) => ({
      trackIndex: index,
      beforePane: index,
      afterPane: index + 1,
    }))
    const rowDividers = Array.from({ length: Math.max(0, rowCount - 1) }, (_, index) => (
      layoutPreset === 'master-stack'
        ? { trackIndex: index, beforePane: index + 1, afterPane: index + 2, crossPane: index + 1 }
        : {
            trackIndex: index,
            beforePane: index * columnCount,
            afterPane: (index + 1) * columnCount,
          }
    ))
    return (
      <div
        ref={tileGridRef}
        className={`ws-columns tile-grid tile-grid-${layoutPreset}`}
        style={tileGridStyle(columnSizes, rowSizes)}
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
          <div key={key} data-pane-index={index} className="tile-slot" style={{ display: 'flex', minWidth: 0, minHeight: 0, ...tileSlotStyle(index) }}>
            {renderBlock(key)}
          </div>
        ))}
        {Array.from({ length: placeholderCount }, (_, index) => (
          <div
            key={`tile-empty-${index}`}
            data-pane-index={orderedKeys.length + index}
            className="tile-slot"
            style={{ display: 'flex', minWidth: 0, minHeight: 0, ...tileSlotStyle(orderedKeys.length + index) }}
          >
            <button type="button" className="tile-empty" onClick={() => setOpenWindowPickerOpen(true)} title="Open a conversation window in this slot">
              <span className="tile-empty-plus" aria-hidden>+</span>
              <span>open window</span>
            </button>
          </div>
        ))}
        <PaneDividerLayer
          containerRef={tileGridRef}
          axis="x"
          sizes={columnSizes}
          dividers={columnDividers}
          minPaneSize={160}
          onSizesChange={(sizes) => setPaneTrackSizes('columns', sizes)}
        />
        <PaneDividerLayer
          containerRef={tileGridRef}
          axis="y"
          sizes={rowSizes}
          dividers={rowDividers}
          minPaneSize={96}
          onSizesChange={(sizes) => setPaneTrackSizes('rows', sizes)}
        />
      </div>
    )
  }

  return (
    <div
      className={`app-shell ${hasContent ? 'has-content' : 'blank'} ${mobileView ? 'mobile' : ''}`}
      onPointerDownCapture={(event) => {
        if (event.button !== 2) return
        const target = event.target as HTMLElement
        if (!target.closest?.('.win-titlebar')) return
        if (!target.closest?.('[data-desktop-context-key]')) return
        event.stopPropagation()
      }}
      onPointerUpCapture={(event) => {
        if (event.button !== 2) return
        const target = event.target as HTMLElement
        if (!target.closest?.('.win-titlebar')) return
        if (!target.closest?.('[data-desktop-context-key]')) return
        event.stopPropagation()
      }}
      onContextMenuCapture={(event) => {
        const target = event.target as HTMLElement
        const titleBar = target.closest?.<HTMLElement>('.win-titlebar')
        const block = titleBar?.closest<HTMLElement>('[data-desktop-context-key]')
        const key = block?.dataset.desktopContextKey
        if (!key) return
        event.preventDefault()
        event.stopPropagation()
        openDesktopContextMenu(key, event.clientX, event.clientY)
      }}
    >
      {settingsOpen ? <div className="settings-popover-backdrop" onClick={() => setSettingsOpen(false)} /> : null}

      {desktopContextMenu ? (
        <>
          <div
            className="desktop-context-backdrop"
            onMouseDown={() => setDesktopContextMenu(null)}
            onContextMenu={(event) => event.preventDefault()}
          />
          <div
            className="desktop-context-menu"
            role="menu"
            aria-label="Window actions"
            style={{ left: desktopContextMenu.x, top: desktopContextMenu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            {isCardKey(desktopContextMenu.key) ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="desktop-context-item"
                  onClick={() => {
                    duplicateConversation(desktopContextMenu.key)
                    setDesktopContextMenu(null)
                  }}
                >
                  <span>Duplicate</span>
                </button>
                <div className="desktop-context-separator" role="separator" />
              </>
            ) : null}
            <div className="desktop-context-title">SEND TO DESKTOP</div>
            {DESKTOP_IDS.map((desktop) => {
              const current = desktopForKey(desktopContextMenu.key) === desktop
              return (
                <button
                  key={desktop}
                  type="button"
                  role="menuitem"
                  className="desktop-context-item"
                  disabled={current}
                  onClick={() => {
                    sendBlockToDesktop(desktopContextMenu.key, desktop)
                    setDesktopContextMenu(null)
                  }}
                >
                  <span>Desktop {desktop}</span>
                  {current ? <span className="desktop-context-current">CURRENT</span> : <span aria-hidden>›</span>}
                </button>
              )
            })}
          </div>
        </>
      ) : null}

      {passwordDialogOpen && passwordStatus ? (
        <PasswordDialog
          status={passwordStatus}
          onClose={() => setPasswordDialogOpen(false)}
          onStatusChange={setPasswordStatus}
        />
      ) : null}

      {agentCommandsDialogOpen ? (
        <AgentCommandsDialog
          commands={agentCommands}
          onClose={() => setAgentCommandsDialogOpen(false)}
          onSave={saveAgentCommands}
        />
      ) : null}

      {usageSettingsDialogOpen ? (
        <UsageSettingsDialog
          onClose={() => setUsageSettingsDialogOpen(false)}
          onSaved={() => {
            void requestUsageRefresh(true)
          }}
        />
      ) : null}

      {versionDialogOpen ? <VersionDialog onClose={() => setVersionDialogOpen(false)} /> : null}

      {todoOpen && passwordStatus?.authenticated ? (
        <TodoWindow
          minimized={todoMinimized}
          onMinimizedChange={setTodoMinimized}
          onClose={() => {
            setTodoOpen(false)
            setTodoMinimized(false)
          }}
        />
      ) : null}

      {passwordStatus && !passwordStatus.authenticated ? <PasswordUnlock onUnlocked={setPasswordStatus} /> : null}
      {!passwordStatus || (passwordStatus.authenticated && !agentCommandsHydrated)
        ? <WorkspaceReconnectOverlay />
        : null}
      {workspaceSaveIssue ? (
        <WorkspaceReconnectOverlay
          title="Workspace saving paused"
          message={workspaceSaveIssue}
          onReload={() => window.location.reload()}
        />
      ) : null}
      {workspaceUpgradePreparing && !workspaceSaveIssue ? (
        <WorkspaceReconnectOverlay
          title="Preparing workspace update…"
          message="Your window list and Desktop locations are saved. Waiting for the updated application service."
        />
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
        {/* Mobile: the menu sheet floats over the workspace, so a tap outside it
            (anywhere but the tab bar) has to dismiss it. */}
        {mobileView && mobileSheet ? (
          <div className="mobile-sheet-backdrop" onPointerDown={closeMobileSheet} aria-hidden />
        ) : null}

        <div className={`main-layout ${sidebarCollapsed || mobileView ? 'sidebar-collapsed' : ''}`}>
          <aside
            className={`left-rail ${!mobileView && !sidebarCollapsed ? 'pinned' : 'collapsed'} ${
              !mobileView && sidebarPeek ? 'peek' : ''
            } ${mobileView ? 'mobile-bar' : ''} ${mobileSheet ? 'sheet-open' : ''}`}
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
                className={`rail-icon-button ${railMenuActive('navigator') ? 'active' : ''}`}
                aria-label="Navigator"
                title="Navigator"
                onMouseEnter={() => showRailPanel('navigator')}
                onClick={() => openRailPanel('navigator')}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 3h4M3 6.5h7M3 10h5M3 13.5h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>

              {SHOW_RESOURCE_BUTTON ? (
                <button
                  type="button"
                  className={`rail-icon-button ${railMenuActive('resources') ? 'active' : ''}`}
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
              ) : null}

              <div className="rail-icon-divider" aria-hidden />

              <button
                type="button"
                className={`rail-icon-button ${browserOpen ? 'active' : ''}`}
                aria-label={browserLaunchState === 'installing' ? 'Installing browser' : browserLaunchState === 'checking' ? 'Checking browser' : 'Launch new browser page'}
                title={browserLaunchState === 'installing' ? 'Installing browser...' : browserLaunchState === 'checking' ? 'Checking browser...' : browserOpen ? 'Open another browser' : 'New browser page'}
                onClick={() => {
                  closeMobileSheet()
                  void launchBrowser()
                }}
                disabled={browserLaunchState !== 'idle'}
              >
                {browserLaunchState === 'installing' ? (
                  <span className="spinner" aria-hidden />
                ) : (
                  <svg width="17" height="17" viewBox="0 0 16 16" fill="none" aria-hidden>
                    <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
                    <path d="M1.75 8h12.5M8 1.75v12.5" stroke="currentColor" strokeWidth="1.15" />
                    <path d="M8 1.75C6.2 3.45 5.25 5.55 5.25 8S6.2 12.55 8 14.25M8 1.75c1.8 1.7 2.75 3.8 2.75 6.25S9.8 12.55 8 14.25M2.9 4.45C4.45 5.35 6.15 5.8 8 5.8s3.55-.45 5.1-1.35M2.9 11.55c1.55-.9 3.25-1.35 5.1-1.35s3.55.45 5.1 1.35" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
                  </svg>
                )}
              </button>

              <button
                type="button"
                className={`rail-icon-button ${agentAppOpen || appLauncherOpen ? 'active' : ''}`}
                aria-label="Open Agent Apps"
                aria-expanded={appLauncherOpen}
                title="Agent Apps"
                onClick={(event) => {
                  closeMobileSheet()
                  toggleAppLauncher(event.currentTarget)
                }}
              >
                <svg width="17" height="17" viewBox="0 0 17 17" fill="none" aria-hidden>
                  <rect x="1.75" y="1.75" width="5.5" height="5.5" rx="1.5" fill="currentColor" />
                  <rect x="9.75" y="1.75" width="5.5" height="5.5" rx="1.5" fill="currentColor" opacity=".85" />
                  <rect x="1.75" y="9.75" width="5.5" height="5.5" rx="1.5" fill="currentColor" opacity=".85" />
                  <rect x="9.75" y="9.75" width="5.5" height="5.5" rx="1.5" fill="currentColor" opacity=".65" />
                </svg>
              </button>

              <button
                type="button"
                className={`rail-icon-button ${terminalOpen ? 'active' : ''}`}
                aria-label={terminalOpen ? 'Local Terminal is open' : 'Launch Local Terminal'}
                title={terminalOpen ? 'Local Terminal is open' : 'Launch Local Terminal'}
                onClick={() => {
                  closeMobileSheet()
                  launchLocalTerminal()
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M4.3 6l2 2-2 2M8.4 10.2h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              <button
                type="button"
                className={`rail-icon-button ${todoOpen ? 'active' : ''}`}
                aria-label="Open To-Do List"
                title="To-Do List"
                onClick={() => {
                  closeMobileSheet()
                  setTodoOpen(true)
                  setTodoMinimized(false)
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
                  <path d="m4.3 5.2 1.1 1.1 1.8-2M8.7 5.3h3M4.3 9l1.1 1.1 1.8-2M8.7 9.1h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              <div className="settings-gear-anchor">
                <button
                  type="button"
                  className={`settings-gear-btn ${settingsOpen ? 'open' : ''}`}
                  title="Settings"
                  aria-label="Settings"
                  aria-expanded={settingsOpen}
                  onClick={() => setSettingsOpen((current) => !current)}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
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
                    disabled={!agentCommandsHydrated}
                    onClick={() => {
                      setSettingsOpen(false)
                      setAgentCommandsDialogOpen(true)
                    }}
                  >
                    <span>Agent commands</span>
                    <span aria-hidden>›</span>
                  </button>
                  <button
                    type="button"
                    className="settings-popover-row"
                    onClick={() => {
                      setSettingsOpen(false)
                      setUsageSettingsDialogOpen(true)
                    }}
                  >
                    <span>Usage providers</span>
                    <span aria-hidden>›</span>
                  </button>
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
                  <button
                    type="button"
                    className="settings-popover-row"
                    onClick={() => {
                      setSettingsOpen(false)
                      setVersionDialogOpen(true)
                    }}
                  >
                    <span>Version</span>
                    <span aria-hidden>›</span>
                  </button>
                </div>
              </div>
            </div>

            {/* One menu at a time: whichever icon is selected gets the panel's
                full height. Reflows the workspace while pinned, floats over it
                (no reflow) while only peeking on hover — or fills a bottom sheet
                on mobile, which closes as soon as the pick opens a window. */}
            <div className="rail-content-panel">
              {railPanel === 'navigator' ? (
                <ConversationTreeSidebar
                  tree={conversationTree}
                  activeRunId={activeRunId}
                  unreadRunIds={newDoneIds}
                  onSelect={(runId) => {
                    closeMobileSheet()
                    selectConversation(runId)
                  }}
                  onDeleteRequest={requestDeleteConversation}
                />
              ) : (
                <ResourceSidebar
                  openPluginIds={openPluginIds}
                  onLaunchPlugin={(pluginId) => {
                    closeMobileSheet()
                    launchPlugin(pluginId)
                  }}
                  apps={appListing.apps}
                  appWarnings={appListing.warnings}
                  openAppSlugs={openAppSlugs}
                  onLaunchApp={(app) => {
                    closeMobileSheet()
                    launchRegisteredAgentApp(app)
                  }}
                  onReorderApps={reorderApps}
                  onRenameApp={renameAppLabel}
                />
              )}
            </div>
          </aside>

          {appLauncherOpen ? (
            <AgentAppLauncher
              apps={appListing.apps}
              position={appLauncherPosition}
              openAppIds={launcherOpenAppIds}
              busy={appLauncherBusy}
              error={appLauncherError}
              onCreate={() => void createAndLaunchAgentApp()}
              onLaunch={(app) => {
                launchRegisteredAgentApp(app)
                setAppLauncherOpen(false)
              }}
              onRename={renameRegisteredAgentApp}
              onDuplicate={(app) => void duplicateRegisteredAgentApp(app)}
              onDelete={(app) => void deleteRegisteredAgentApp(app)}
              onClose={() => setAppLauncherOpen(false)}
            />
          ) : null}

          <section className="conversation-workspace" aria-label="Conversation cards">
            <div className="stack-toolbar">
              {/* The short label keeps this on one row with the Desktop switcher
                  at phone width instead of costing a whole toolbar row. */}
              <button
                type="button"
                className="send-button new-conversation-btn"
                title="New conversation"
                onClick={startNewConversation}
              >
                {mobileView ? '+ New' : '+ New conversation'}
              </button>

              <div className="desktop-switcher" role="tablist" aria-label="Desktops">
                {DESKTOP_IDS.map((desktop) => (
                  <button
                    key={desktop}
                    type="button"
                    role="tab"
                    className={`desktop-tab ${activeDesktop === desktop ? 'active' : ''}`}
                    aria-label={`Desktop ${desktop}`}
                    aria-selected={activeDesktop === desktop}
                    title={`Desktop ${desktop}`}
                    onClick={() => switchDesktop(desktop)}
                  >
                    <span className="desktop-tab-icon" aria-hidden>
                      <svg viewBox="0 0 22 18" fill="none">
                        <rect x="1.5" y="1.5" width="19" height="13" rx="2" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M8 16.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                      <span>{desktop}</span>
                    </span>
                  </button>
                ))}
              </div>

              {passwordStatus?.authenticated ? (
                <>
                  <div className="toolbar-divider" aria-hidden />
                  <span className="toolbar-label">USAGE</span>
                  <div className="usage-toolbar">
                    {usageState ? (
                      [
                        usageState.claude,
                        usageState.codex,
                        usageState.gemini,
                        usageState.antigravity,
                        usageState.kimi,
                        usageState.grok,
                        usageState.opencodeGo,
                        usageState.minimax,
                      ].filter(usageProviderVisible).map((provider) => (
                        <UsageProviderToolbarButton key={provider.provider} provider={provider} />
                      ))
                    ) : (
                      <span className="usage-toolbar-loading">Checking usage…</span>
                    )}
                    {usageRequestError ? (
                      <span className="usage-transport-error" title={usageRequestError}>offline</span>
                    ) : null}
                    <button
                      type="button"
                      className={`usage-refresh-button ${usageRefreshing ? 'refreshing' : ''}`}
                      title="Refresh account usage now"
                      aria-label="Refresh account usage now"
                      disabled={usageRefreshing}
                      onClick={() => void requestUsageRefresh(true)}
                    >
                      ↻
                    </button>
                  </div>
                </>
              ) : null}

              <div className="toolbar-spacer" />
              {/* Portrait shows one window per screenful, so the multi-pane
                  presets (and the free grid's row/column steppers) are dropped
                  rather than offering layouts that cannot fit. The saved preset
                  is untouched and comes back on rotation. */}
              {mobileView ? null : (
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
              )}

              {!mobileView && layoutPreset === 'free' ? (
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
            </div>

            <div id="minimized-preview-tabs" className="minimized-preview-tabs" aria-label="Minimized document previews" />

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

            <div
              className={`workspace-panels ${
                maximizedKey ? 'maximized' : `columns-${workspacePreset === 'two-up' ? 2 : 1}`
              }`}
            >
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
              ) : activePanelOrder.length === 0 && desktopVisibleRuns.length === 0 ? (
                <div className="conv-empty">
                  {hasContent
                    ? `Desktop ${activeDesktop} is empty — open or create a conversation here.`
                    : 'Click “New conversation” to begin.'}
                </div>
              ) : workspacePreset === 'two-up' ? (
                // Unified two-column canvas: panels and cards each carry a
                // column, so a tool/app can sit left-right beside a card.
                <div
                  ref={twoUpGridRef}
                  className="ws-columns"
                  style={{ gridTemplateColumns: paneGridTracks(fittedPaneSizes(paneSizes.columns, 2)) }}
                >
                  {renderWorkspaceColumn(0, twoUpLeftRef)}
                  {renderWorkspaceColumn(1, twoUpRightRef)}
                  <PaneDividerLayer
                    containerRef={twoUpGridRef}
                    axis="x"
                    sizes={fittedPaneSizes(paneSizes.columns, 2)}
                    dividers={[{ trackIndex: 0, beforePane: 0, afterPane: 1 }]}
                    minPaneSize={160}
                    onSizesChange={(sizes) => setPaneTrackSizes('columns', sizes)}
                  />
                </div>
              ) : workspacePreset === 'single' ? (
                renderWorkspaceColumn(null, singleColumnRef)
              ) : (
                renderTileGrid()
              )}
            </div>
          </section>
        </div>
      </main>

      {floatingPreviewNodes}

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
