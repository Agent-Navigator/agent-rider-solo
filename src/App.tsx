import { type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { HermesActiveStreamError, HermesBridge, type HermesConnectionState, type PromptContext } from './hermesBridge'
import {
  loadPersistedState,
  persistState,
  listDir,
  readFilePreview,
  makeDir,
  moveDir,
  fileDownloadUrl,
  deleteFile,
  listApps,
  setAppOrder,
  renameApp,
  loadPasswordStatus,
  loginPagePassword,
  setPagePassword,
  logoutPagePassword,
  type FsListing,
  type FsFileEntry,
  type FsFilePreview,
  type AgentApp,
  type AppListing,
  type AppWarning,
  type WorkspacePanelState,
  type PasswordStatus,
} from './store'
import { plugins, type AgentRiderPlugin } from '../plugins'
import { WebView } from '../plugins/WebView'

type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'
type ResourceHealth = 'Ready' | 'Needs setup' | 'Draft'

type ChatRole = 'user' | 'assistant'

// Which agent backend drives a conversation card. 'hermes' streams turns over
// /api (the default); the others run an interactive TUI CLI in an embedded
// terminal (see WebTerminal + the /store/terminal/ws `agent` param).
type AgentType = 'hermes' | 'claude' | 'codex' | 'agy' | 'custom'
type TuiAgentType = Exclude<AgentType, 'hermes'>
type AppBuilderMode = 'chat' | 'app'
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
  { value: 'claude', label: 'claude (CLI)' },
  { value: 'codex', label: 'Codex (CLI)' },
  { value: 'agy', label: 'Agy (CLI)' },
  { value: 'custom', label: 'Custom command' },
]

function isTuiAgent(agent: AgentType): agent is TuiAgentType {
  return agent === 'claude' || agent === 'codex' || agent === 'agy' || agent === 'custom'
}

function agentLabel(agent: AgentType) {
  return AGENT_OPTIONS.find((option) => option.value === agent)?.label ?? agent
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

async function fetchHermesModelCatalog(): Promise<HermesModelCatalog> {
  const res = await fetch('/api/models')
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

interface TurnItem {
  id: string
  prompt: string
  response: string
  status: JobStatus
  runId: string
  parentTurnId?: string | null
  createdAt: string
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
const DEFAULT_TITLE = 'Agent Rider'
const AGENT_TERMINAL_STATE_PREFIX = 'agent-terminal:'
const DEFAULT_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh']
const EMPTY_MODEL_CATALOG: HermesModelCatalog = { groups: [], defaultModel: '', activeProvider: null }
const APP_BUILDER_PANEL_ID = 'app-builder'
const APP_BUILDER_RUN_ID = 'run-app-builder'
// Per-app App Builder instances: every built app opens through its own builder
// panel/run pair so each app keeps its own conversation and chat/app-view mode.
const APP_BUILDER_PANEL_PREFIX = 'app-builder:'
const APP_BUILDER_RUN_PREFIX = 'run-app-builder:'

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
    if (source.builderMode === 'chat' || source.builderMode === 'app') state.builderMode = source.builderMode
    if (typeof source.contextCollapsed === 'boolean') state.contextCollapsed = source.contextCollapsed
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

function buildLinearTurns(turns: TurnItem[]) {
  const byId = new Map(turns.map((turn) => [turn.id, turn]))
  const childrenByParent = new Map<string, TurnItem[]>()
  const roots: TurnItem[] = []
  const newestFirst = (a: TurnItem, b: TurnItem) => b.createdAt.localeCompare(a.createdAt)

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

  for (const children of childrenByParent.values()) children.sort(newestFirst)
  roots.sort(newestFirst)

  const ordered: TurnItem[] = []
  const visited = new Set<string>()

  function appendWithFollowUps(turn: TurnItem) {
    if (visited.has(turn.id)) return
    visited.add(turn.id)
    for (const child of childrenByParent.get(turn.id) ?? []) appendWithFollowUps(child)
    ordered.push(turn)
  }

  for (const root of roots) appendWithFollowUps(root)
  for (const turn of [...turns].sort(newestFirst)) appendWithFollowUps(turn)

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

function appBuilderWorkspacePath(workspaceRoot: string, category: string, project: string, title: string) {
  const root = workspaceRoot.replace(/\/+$/, '')
  return [
    root,
    'plugins',
    pathSegment(category, 'uncategorized'),
    pathSegment(project, 'agent-rider-app'),
    pathSegment(title, 'untitled-app'),
  ].join('/')
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

/**
 * Read-only file browser scoped to a conversation's workspace. Collapsed by default
 * and lazy-loaded on first expand. Navigation is bounded to the workspace subtree
 * (you can't browse above `rootPath`), and the backend further sandboxes to BROWSE_ROOT.
 */
function FileBrowser({ rootPath }: { rootPath: string }) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState(rootPath)
  const [effectiveRootPath, setEffectiveRootPath] = useState(rootPath)
  const [listing, setListing] = useState<FsListing | null>(null)
  const [preview, setPreview] = useState<FsFilePreview | null>(null)
  const [previewFullWindow, setPreviewFullWindow] = useState(false)
  const [loading, setLoading] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<FsFileEntry | null>(null)
  const [deleting, setDeleting] = useState(false)

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
      setPreviewFullWindow(false)
    }
    setPendingDelete(null)
    void load(path)
  }

  async function load(target: string) {
    setLoading(true)
    setError(null)
    setPreview(null)
    setPreviewFullWindow(false)
    setPreviewError(null)
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
    setEffectiveRootPath(rootPath)
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
  const canGoUp = path !== effectiveRootPath && pathWithinRoot(path, effectiveRootPath)
  const relLabel = path === effectiveRootPath
    ? '.'
    : path.startsWith(`${effectiveRootPath}/`)
      ? path.slice(effectiveRootPath.length + 1)
      : path
  const previewNode = preview ? (
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
  ) : null

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
                {(listing.files ?? []).map((file) => (
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
              <div className="file-browser-empty">Empty folder.</div>
            )}
          </div>

          {previewLoading ? <div className="file-browser-empty">Opening file…</div> : null}
          {previewError ? <p className="error-text">{previewError}</p> : null}
          {previewFullWindow && previewNode ? createPortal(previewNode, document.body) : previewNode}
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
const DRAG_EXCLUDE = 'input, textarea, select, button, a, iframe, [contenteditable="true"], .bubble, .conv-agent-terminal, .terminal-screen, .file-browser, .file-preview'

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
  onSend: (text: string, parentTurnId?: string | null) => string | null
  onTitleChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onProjectChange: (value: string) => void
  onAgentChange: (value: AgentType) => void
  onAgentCommandChange: (value: string) => void
  modelCatalog: HermesModelCatalog
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
}) {
  const agentType: AgentType = run.agentType ?? 'hermes'
  const tui = isTuiAgent(agentType)
  const customAgentCommand = (run.agentCommand ?? '').trim()
  const selectedModelValue = run.model ? modelSelectValue(run.model, run.modelProvider ?? null) : ''
  const selectedReasoningEffort = run.reasoningEffort ?? ''
  const cardRef = useRef<HTMLElement | null>(null)
  const [dragOver, setDragOver] = useState(false)
  // Whether the hovering drop would land after (below) this card vs before.
  // Ref mirrors it for a staleness-free read in the drop handler.
  const [dragOverAfter, setDragOverAfter] = useState(false)
  const dragOverAfterRef = useRef(false)
  const [draft, setDraft] = useState('')
  const [customCommandDraft, setCustomCommandDraft] = useState(run.agentCommand ?? '')
  const [askParentId, setAskParentId] = useState<string | null>(null)
  const [askDraft, setAskDraft] = useState('')
  const [copiedTurnId, setCopiedTurnId] = useState<string | null>(null)
  const [collapsedTurnIds, setCollapsedTurnIds] = useState<Set<string>>(new Set())
  const [focusTurnId, setFocusTurnId] = useState<string | null>(null)
  const linearTurns = useMemo(() => buildLinearTurns(turns), [turns])
  const status = run.jobStatus
  const isDraft = turns.length === 0
  const topVisibleTurnId = linearTurns[0]?.id ?? null
  const focusedTurnId = focusTurnId && linearTurns.some((turn) => turn.id === focusTurnId) ? focusTurnId : topVisibleTurnId
  const focusedTurnRef = useRef<HTMLDivElement | null>(null)
  const askMoreFormRef = useRef<HTMLFormElement | null>(null)
  const askMoreTextareaRef = useRef<HTMLTextAreaElement | null>(null)

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
    const filePath = filePathFromDrag(event)
    if (!filePath) return
    event.preventDefault()
    event.stopPropagation()
    setValue(insertIntoTextarea(event.currentTarget, filePath))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    const turnId = onSend(text)
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
        className="turn-node"
      >
        <article className={`turn ${turn.status} ${isTurnCollapsed ? 'collapsed' : ''}`}>
          <div
            className={`bubble user turn-toggle ${isTurnCollapsed ? 'collapsed' : ''}`}
            role="button"
            tabIndex={0}
            aria-expanded={!isTurnCollapsed}
            onClick={(event) => {
              if (hasTextSelectionInside(event.currentTarget)) return
              toggleTurnCollapsed(turn.id)
            }}
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
              <span className="turn-head-actions">
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
                <button
                  type="button"
                  className="turn-delete-button"
                  disabled={!canDelete}
                  title={canDelete ? 'Delete this Q/A turn' : 'Stop the running turn before deleting it'}
                  onKeyDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (canDelete) onDeleteTurn(turn.id)
                  }}
                >
                  Delete
                </button>
              </span>
            </div>
          </div>
          {!isTurnCollapsed ? (
            <div className="bubble assistant">
              <div className="assistant-head">
                <span className="role">Hermes · {turnRoleLabel(turn.status)}</span>
                <div className="assistant-head-actions">
                  {canStop ? (
                    <button
                      type="button"
                      className="assistant-stop-button"
                      onClick={() => onStopTurn(turn.id)}
                      aria-label="Stop Hermes"
                    >
                      Stop
                    </button>
                  ) : null}
                  {canRefresh ? (
                    <button
                      type="button"
                      className="assistant-refresh-button"
                      onClick={() => onRefreshTurn(turn.id)}
                      aria-label="Refresh Hermes stream"
                    >
                      Refresh
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="assistant-to-bottom-button"
                    onClick={() => scrollAssistantBubbleToBottom(turn.id)}
                    aria-label="Scroll to bottom of this reply"
                  >
                    To bottom
                  </button>
                </div>
              </div>
              <div className="md-body">
                <ReactMarkdown
                  remarkPlugins={richMarkdownPlugins.remark}
                  rehypePlugins={richMarkdownPlugins.rehype}
                  components={richMarkdownComponents}
                >
                  {turn.response || '…'}
                </ReactMarkdown>
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
                  Ask Here
                </button>
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
              <div id={assistantBubbleBottomId(turn.id)} className="assistant-bubble-bottom" aria-hidden />
            </div>
          ) : null}
        </article>
      </div>
    )
  }

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
      {hideHeader ? null : (
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
      )}

      {!collapsed ? (
        <div className="conv-card-body">
          {hideContext ? null : (
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
            )}
          </div>
          )}

          <div className={`conv-content-shell ${tui ? 'tui-content-shell' : ''} ${tui && agentTerminalState?.fullWindow ? 'file-browser-full-window' : ''}`}>
            <FileBrowser rootPath={run.workspacePath} />

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
                  title={`${agentType} — interactive`}
                  showClose={false}
                  onClose={() => {}}
                collapsed={agentTerminalState?.collapsed}
                fullWindow={agentTerminalState?.fullWindow}
                promptContext={run.cardKind === 'app-builder' ? 'app-builder' : undefined}
                appWorkspace={run.cardKind === 'app-builder' ? run.workspacePath : undefined}
                onStateChange={onAgentTerminalStateChange}
              />
              </div>
            ) : tui ? (
              <div className="conv-agent-command-empty">
                Enter a bash command to launch the custom TUI agent.
              </div>
            ) : (
              <>
                <form className="composer conv-followup" onSubmit={submit}>
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onDragOver={(event) => {
                      if (event.dataTransfer.types.includes('application/x-agent-rider-file-path')) event.preventDefault()
                    }}
                    onDrop={(event) => dropFilePathIntoTextarea(event, setDraft)}
                    placeholder={isDraft ? 'Describe the task to start this conversation…' : 'Reply in this conversation…'}
                    rows={2}
                  />
                  <div className="composer-meta">
                    <div className="composer-controls" aria-label="Hermes options">
                      <label className="composer-control">
                        <span>Model</span>
                      <select
                        value={selectedModelValue}
                        onChange={(event) => {
                          const next = parseModelSelectValue(event.target.value)
                          onModelChange(next.model, next.modelProvider)
                        }}
                      >
                        <option value="">
                          {modelCatalog.defaultModel ? `Default · ${modelCatalog.defaultModel}` : 'Default model'}
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
                    <label className="composer-control">
                      <span>Reasoning</span>
                      <select
                        value={selectedReasoningEffort}
                        onChange={(event) => onReasoningEffortChange(event.target.value)}
                      >
                        <option value="">Default effort</option>
                        {reasoningEfforts.map((effort) => (
                          <option key={effort} value={effort}>
                            {effort}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <span className="composer-workspace-path">{run.workspacePath}</span>
                  <button type="submit" className="send-button">
                    Send
                  </button>
                </div>
              </form>

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
                  {linearTurns.map((turn) => renderTurn(turn))}
                </div>
              ) : null}
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
  onStateChange,
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
  onStateChange?: (patch: WorkspacePanelState) => void
}) {
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const [internalFullWindow, setInternalFullWindow] = useState(false)
  const [internalMode, setInternalMode] = useState<AppBuilderMode>('chat')
  const [internalContextCollapsed, setInternalContextCollapsed] = useState(false)
  const [customCommandDraft, setCustomCommandDraft] = useState(run.agentCommand ?? '')
  const isCollapsed = collapsed ?? internalCollapsed
  const isFullWindow = fullWindow ?? internalFullWindow
  const activeMode = mode ?? internalMode
  const isContextCollapsed = contextCollapsed ?? internalContextCollapsed
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

  function toggleFromKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    setCollapsedState((current) => !current)
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

  return (
    <section className={`app-builder-card conv-card ${isCollapsed ? 'collapsed' : ''} ${isFullWindow ? 'full-window' : ''}`} aria-label="App Builder">
      <div
        className="conv-card-head app-builder-head"
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
        onClick={() => setCollapsedState((current) => !current)}
        onKeyDown={toggleFromKey}
      >
        <span className="conv-drag-handle" aria-hidden onClick={(event) => event.stopPropagation()}>
          ⠿
        </span>
        <div className="conv-card-titles">
          <span className="eyebrow">Resource · App Builder</span>
          <input
            className="conv-title-input app-builder-title-input"
            value={run.task}
            onChange={(event) => onTitleChange(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            placeholder="Untitled app"
            aria-label="App title"
          />
        </div>
        <div className="terminal-actions">
          <button
            type="button"
            className="terminal-icon-button"
            title={isFullWindow ? 'Exit full window' : 'Expand to full window'}
            aria-label={isFullWindow ? 'Exit full window' : 'Expand to full window'}
            onClick={(event) => {
              event.stopPropagation()
              setFullWindowState((current) => !current)
            }}
          >
            {isFullWindow ? '↙' : '⛶'}
          </button>
          <button
            type="button"
            className="card-close"
            title="Close App Builder"
            aria-label="Close App Builder"
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
          >
            ×
          </button>
        </div>
        <span className={`conv-caret ${isCollapsed ? '' : 'open'}`} aria-hidden>▾</span>
      </div>

      {!isCollapsed ? (
        <div className="conv-card-body app-builder-body">
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
                  {[run.category, run.project, agentLabel(run.agentType)].filter(Boolean).join(' · ') || 'Category · Project · Agent'}
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
                <span className="tree-label">Agent</span>
                <select
                  className="conv-input conv-agent-select"
                  value={run.agentType ?? 'hermes'}
                  onChange={(event) => onAgentChange(event.target.value as AgentType)}
                  aria-label="App Builder agent"
                >
                  {AGENT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
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
          </div>

          {activeMode === 'chat' ? (
            <div className="app-builder-chat" role="tabpanel">
              {chatContent}
            </div>
          ) : (
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
          )}
        </div>
      ) : null}
    </section>
  )
}

function ResourceSidebar({
  terminalOpen,
  onLaunchTerminal,
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
  terminalOpen: boolean
  onLaunchTerminal: () => void
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
              <button
                type="button"
                className="send-button new-conversation-btn build-app-button"
                onClick={onLaunchAppBuilder}
              >
                Build an App
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
  collapsed,
  fullWindow,
  promptContext,
  appWorkspace,
  onStateChange,
}: {
  initialCwd: string
  onClose: () => void
  /** When set, the PTY launches this TUI agent CLI instead of a login shell. */
  agent?: TuiAgentType
  /** Bash command used when `agent` is the custom TUI option. */
  customCommand?: string
  /** Stable key for a persistent (tmux-backed) agent session that survives
   *  disconnects. Only meaningful together with `agent`. */
  sessionKey?: string
  eyebrow?: string
  title?: string
  showClose?: boolean
  collapsed?: boolean
  fullWindow?: boolean
  promptContext?: PromptContext
  appWorkspace?: string
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
    const sessionParam = agent && sessionKey ? `&session=${encodeURIComponent(sessionKey)}` : ''
    const promptContextParam = promptContext ? `&prompt_context=${encodeURIComponent(promptContext)}` : ''
    const appWorkspaceParam = appWorkspace ? `&app_workspace=${encodeURIComponent(appWorkspace)}` : ''
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/store/terminal/ws?cwd=${encodeURIComponent(initialCwd)}&cols=${terminal.cols}&rows=${terminal.rows}${agentParam}${commandParam}${sessionParam}${promptContextParam}${appWorkspaceParam}`,
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

  function toggleTerminalFromKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    setTerminalCollapsedState((current) => !current)
  }

  function pasteIntoTerminal(value: string) {
    terminalRef.current?.focus()
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: 'input', data: value }))
    }
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
            {agentTerminal ? 'Refresh' : 'Clear'}
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
  const turnsRef = useRef<TurnItem[]>([])
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
  const [reasoningEfforts, setReasoningEfforts] = useState<string[]>(DEFAULT_REASONING_EFFORTS)
  const [passwordStatus, setPasswordStatus] = useState<PasswordStatus | null>(null)
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false)

  // Per-conversation UI state.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [metaCollapsedIds, setMetaCollapsedIds] = useState<Set<string>>(new Set())
  const [newDoneIds, setNewDoneIds] = useState<Set<string>>(new Set())
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [workspaceColumns, setWorkspaceColumns] = useState<1 | 2>(1)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
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

  useEffect(() => {
    turnsRef.current = turns
  }, [turns])

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
        : [makeAppBuilderRun({ id: slug, label: app?.label ?? slug }), ...current],
    )
    openPanel(appBuilderPanelIdFor(slug))
  }

  function makeAppBuilderRun(app?: { id: string; label: string }): RunNode {
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
      workspacePath: appBuilderWorkspacePath(workspaceRoot, category, project, task),
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
        if (app) additions.push(makeAppBuilderRun({ id: slug, label: app.label }))
      }
      return additions.length ? [...additions, ...current] : current
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelOrder, workspaceRoot, appListing.apps])

  useEffect(() => {
    const openBuilderRuns = runs.filter(
      (run) => isAppBuilderRunId(run.id) && panelOrder.includes(appBuilderPanelIdForRun(run.id)),
    )
    if (!openBuilderRuns.length) return
    let cancelled = false
    for (const run of openBuilderRuns) {
      const nextWorkspace = appBuilderWorkspacePath(workspaceRoot, run.category, run.project, run.task)
      const runConflict = appFolderConflict?.sourcePath === run.workspacePath ? appFolderConflict : null
      if (runConflict && runConflict.targetPath !== nextWorkspace) setAppFolderConflict(null)
      if (run.workspacePath === nextWorkspace) {
        void ensureWorkspacePath(workspaceRoot, nextWorkspace).catch(() => {})
        continue
      }
      if (runConflict && runConflict.targetPath === nextWorkspace) continue

      void (async () => {
        const sourceListing = await listDir(run.workspacePath)
        if (cancelled) return
        if (!sourceListing) {
          await ensureWorkspacePath(workspaceRoot, nextWorkspace)
          if (cancelled) return
          sessionByRunRef.current.delete(run.id)
          updateRunContext(run.id, { workspacePath: nextWorkspace, sessionId: null })
          return
        }

        const result = await moveDir(run.workspacePath, nextWorkspace)
        if (cancelled) return
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
      })().catch((error) => setError(error instanceof Error ? error.message : String(error)))
    }
    return () => {
      cancelled = true
    }
  }, [panelOrder, runs, workspaceRoot, appFolderConflict])

  function setPanelColumn(panelId: string, column: number) {
    setPanelColumns((current) => ({ ...current, [panelId]: column }))
  }

  function updatePanelState(panelId: string, patch: WorkspacePanelState) {
    setPanelStates((current) => {
      const nextState = { ...(current[panelId] ?? {}), ...patch }
      const normalized: WorkspacePanelState = {}
      if (typeof nextState.collapsed === 'boolean') normalized.collapsed = nextState.collapsed
      if (typeof nextState.fullWindow === 'boolean') normalized.fullWindow = nextState.fullWindow
      if (nextState.builderMode === 'chat' || nextState.builderMode === 'app') normalized.builderMode = nextState.builderMode
      if (typeof nextState.contextCollapsed === 'boolean') normalized.contextCollapsed = nextState.contextCollapsed
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
  const hasLegacyDefaultWorkspace = useMemo(
    () => runs.some((run) => run.workspacePath === DEFAULT_WORKSPACE_CWD),
    [runs],
  )

  function toggleCollapse(runId: string) {
    setActiveRunId(runId)
    setCollapsedIds((current) => {
      const next = new Set(current)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
    // Note: the unread dot is NOT cleared here. It clears only once the new
    // reply actually scrolls into view (see the card's IntersectionObserver).
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
      if (run.cardKind === 'app-builder') continue
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
        const hasContent = assistantBufferRef.current.trim().length > 0
        if (turnId) {
          setTurns((current) =>
            current.map((turn) =>
              turn.id === turnId
                ? hasContent
                  ? { ...turn, response: assistantBufferRef.current.trim(), status: 'done' }
                  : { ...turn, response: [message, hint].filter(Boolean).join('\n\n'), status: 'error' }
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
          if (layout.workspaceColumns === 1 || layout.workspaceColumns === 2) {
            setWorkspaceColumns(layout.workspaceColumns)
          }
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
        workspaceColumns,
        sidebarCollapsed,
        closedRunIds: [...closedRunIds],
        collapsedRunIds: [...collapsedIds],
        cardMetaCollapsedIds: [...metaCollapsedIds],
        unreadRunIds: [...newDoneIds],
        panelStates,
      })
    }, 700)
    return () => clearTimeout(handle)
  }, [runs, turns, sessionId, panelOrder, panelColumns, layoutOrder, workspaceColumns, sidebarCollapsed, closedRunIds, collapsedIds, metaCollapsedIds, newDoneIds, panelStates, passwordStatus?.authenticated])

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

  async function startTurn(entry: QueuedPromptEntry) {
    const bridge = bridgeRef.current
    if (!bridge) return

    const { turnId, runId, prompt, workspace, model, modelProvider, reasoningEffort, promptContext } = entry

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
      const promptOptions = {
        model,
        modelProvider,
        promptContext,
        appWorkspace: promptContext === 'app-builder' ? workspace : undefined,
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
        current.map((turn) => (turn.id === turnId ? { ...turn, response, status: 'cancelled' } : turn)),
      )
    }
    if (runId) {
      setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'cancelled' } : item)))
    }
    activeTurnRef.current = null
    activeRunRef.current = null
    assistantBufferRef.current = ''
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
      return null
    }
    const run = runs.find((item) => item.id === runId)
    if (!run) return null

    setActiveRunId(runId)
    const model = (run.model ?? '').trim()
    const modelProvider = (run.modelProvider ?? '').trim() || null
    const reasoningEffort = (run.reasoningEffort ?? '').trim()
    const hasTurns = turns.some((turn) => turn.runId === runId)
    let workspace = run.workspacePath
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
      setRuns((current) => current.map((item) => (item.id === runId ? { ...item, jobStatus: 'running' } : item)))
    }

    const { turn, turnId } = newTurn(runId, prompt, parentTurnId)
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
      onSend={(text, parentTurnId) => sendInConversation(run.id, text, parentTurnId ?? null)}
      onTitleChange={(value) => updateRunContext(run.id, { task: value })}
      onCategoryChange={(value) => updateRunContext(run.id, { category: value, categoryTags: tagsForCategory(value) })}
      onProjectChange={(value) => updateRunProject(run.id, value)}
      onAgentChange={(value) => updateRunContext(run.id, { agentType: value })}
      onAgentCommandChange={(value) => updateRunContext(run.id, { agentCommand: value })}
      modelCatalog={modelCatalog}
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
        onSend={(text, parentTurnId) => sendInConversation(run.id, text, parentTurnId ?? null)}
        onTitleChange={(value) => updateRunContext(run.id, { task: value })}
        onCategoryChange={(value) => updateRunContext(run.id, { category: value, categoryTags: tagsForCategory(value) })}
        onProjectChange={(value) => updateRunProject(run.id, value)}
        onAgentChange={(value) => updateRunContext(run.id, { agentType: value })}
        onAgentCommandChange={(value) => updateRunContext(run.id, { agentCommand: value })}
        modelCatalog={modelCatalog}
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
    let content: ReactNode = null
    if (panelId === 'terminal') {
      content = (
        <WebTerminal
          initialCwd={workspaceRoot}
          onClose={() => closePanel('terminal')}
          collapsed={panelStates[panelId]?.collapsed}
          fullWindow={panelStates[panelId]?.fullWindow}
          onStateChange={(patch) => updatePanelState(panelId, patch)}
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
            onStateChange={(patch) => updatePanelState(panelId, patch)}
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
        <h1>Agent Rider</h1>
        <div className="topbar-actions">
          <button
            type="button"
            className="topbar-button"
            onClick={() => setPasswordDialogOpen(true)}
            disabled={!passwordStatus}
            title={passwordStatus?.enabled ? 'Change page password' : 'Set page password'}
          >
            Password
          </button>
          <div className="status-stack">
            <StatusPill state={connectionState} detail={headerStatusText(connectionState, connectionDetail)} />
          </div>
        </div>
      </header>

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

      <main className="main-stage">
        <div className={`main-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
          <aside className={`left-rail ${sidebarCollapsed ? 'collapsed' : ''}`} aria-label="Sidebar">
            <button
              type="button"
              className="rail-toggle-button"
              aria-expanded={!sidebarCollapsed}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={() => setSidebarCollapsed((current) => !current)}
            >
              <span className="rail-toggle-icon" aria-hidden>
                {sidebarCollapsed ? '›' : '‹'}
              </span>
              <span className="rail-toggle-text">{sidebarCollapsed ? 'Open sidebar' : 'Collapse sidebar'}</span>
            </button>

            {sidebarCollapsed ? (
              <div className="rail-collapsed-stack">
                <button
                  type="button"
                  aria-label="Expand sidebar to show Navigator"
                  title="Expand sidebar to show Navigator"
                  onClick={() => setSidebarCollapsed(false)}
                >
                  NAV
                </button>
                <button
                  type="button"
                  aria-label="Expand sidebar to show Resources"
                  title="Expand sidebar to show Resources"
                  onClick={() => setSidebarCollapsed(false)}
                >
                  RES
                </button>
              </div>
            ) : (
              <>
                <ConversationTreeSidebar
                  tree={conversationTree}
                  activeRunId={activeRunId}
                  unreadRunIds={newDoneIds}
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
                  appBuilderOpen={appBuilderOpen}
                  appBuilderTitle={runs.find((run) => run.id === APP_BUILDER_RUN_ID)?.task.trim() || 'App Builder'}
                  onLaunchAppBuilder={launchAppBuilder}
                  openAppSlugs={openAppSlugs}
                  onLaunchApp={launchApp}
                  onReorderApps={reorderApps}
                  onRenameApp={renameAppLabel}
                />
              </>
            )}
          </aside>

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
