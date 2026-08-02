export const AGENT_APP_DEFAULT_SPLIT = 2 / 3
export const AGENT_APP_MIN_SPLIT = 0.2
export const AGENT_APP_MAX_SPLIT = 0.8

export type AgentAppOrientation = 'wide' | 'tall'

export function clampAgentAppSplit(value: number) {
  return Math.min(AGENT_APP_MAX_SPLIT, Math.max(AGENT_APP_MIN_SPLIT, value))
}

export function agentAppOrientation(width: number, height: number): AgentAppOrientation {
  return height > width ? 'tall' : 'wide'
}

export function legacyEmbedPort(value: unknown) {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    const local = url.hostname === 'localhost'
      || url.hostname === '0.0.0.0'
      || url.hostname === '::1'
      || url.hostname.startsWith('127.')
    const port = Number(url.port)
    return local && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined
  } catch {
    return undefined
  }
}

export function agentAppProxyUrl(port?: number) {
  if (!port) return 'about:blank'
  const url = new URL(`http://127.0.0.1:${port}/`)
  const target = btoa(url.origin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `/store/embed/${target}/`
}

export function registeredAgentAppPanelId(appId: string) {
  return `embed-${appId}`
}

export function remapAgentAppPanelCommands<T extends { agentCommand?: string }>(
  panelStates: Record<string, T>,
  replacements: ReadonlyMap<string, string>,
) {
  let changed = false
  const next = { ...panelStates }
  for (const [panelId, state] of Object.entries(panelStates)) {
    if (panelId !== 'embed' && !panelId.startsWith('embed-')) continue
    const current = state.agentCommand?.trim()
    const replacement = current ? replacements.get(current) : undefined
    if (!replacement || replacement === state.agentCommand) continue
    next[panelId] = { ...state, agentCommand: replacement } as T
    changed = true
  }
  return changed ? next : panelStates
}

export function agentAppIconHue(appId: string) {
  let hash = 0
  for (const character of appId) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0
  return hash % 360
}

const AGENT_APP_ICON_EXTENSIONS = new Set(['svg', 'png', 'webp', 'gif', 'avif', 'jpg', 'jpeg', 'ico'])

export function agentAppIconAssetPath(icon: string) {
  const value = icon.trim()
  if (!value || value.length > 160) return undefined
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || !/^[a-z0-9_.-]+$/i.test(part))) {
    return undefined
  }
  const extension = parts.at(-1)?.split('.').at(-1)?.toLowerCase()
  return extension && AGENT_APP_ICON_EXTENSIONS.has(extension) ? value : undefined
}

export function agentAppIconUrl(appId: string, icon: string) {
  const asset = agentAppIconAssetPath(icon)
  if (!asset) return undefined
  const encodedPath = asset.split('/').map(encodeURIComponent).join('/')
  return `/apps/${encodeURIComponent(appId)}/${encodedPath}`
}

export function agentAppLaunchPrompt(name: string, port: number) {
  const appName = name.trim() || 'New App'
  return [
    `You are the development agent paired with the Agent Rider Agent App panel ${JSON.stringify(appName)}.`,
    'Your current working directory is this Agent App’s registered project workspace.',
    `The panel combines this TUI with an App View that Agent Rider connects to a local web server on its assigned port ${port}.`,
    `The editable App title ${JSON.stringify(appName)} is only a label, not a product specification or permission to invent an app from the title.`,
    'Before creating, replacing, or substantially changing anything, inspect the existing workspace and determine whether it already contains an app or other requirements.',
    `Also check whether a web server is already responding on port ${port}.`,
    'If it is running, reuse that existing server; do not stop, restart, replace, or launch another server.',
    'If an app or server already exists, briefly tell the user what you found and ask whether they want to run it, modify it, or create something different.',
    'Unless the user has already supplied a sufficiently complete brief, do not begin implementation yet.',
    'Actively ask the user concise, grouped questions and wait for their answers.',
    'Clarify the app’s purpose, intended users, and primary workflow; its data sources such as APIs, files, databases, static or sample data; authentication, secrets, refresh, persistence, and write-back needs; the required content, screens, and visual structure; the functions and interactions users need; technical or design constraints; and the acceptance criteria.',
    'Ask follow-up questions for important gaps instead of silently guessing, while avoiding questions the user has already answered.',
    'Only after the requirements are clear enough should you propose a short implementation approach and start building in the current workspace.',
    'Only start a development server when no server is already running on the required port.',
    `Start its development server on exactly port ${port} and bind it to 127.0.0.1 (or 0.0.0.0 if the framework requires it).`,
    'Do not choose a different port and do not open an external browser.',
    'Keep the server process running; Agent Rider will detect it and load the proxied App View automatically.',
    'To configure the icon shown in the Agent Apps menu, put an SVG, PNG, WebP, GIF, AVIF, JPEG, or ICO image under dist/ (for example dist/icon.svg) and set the icon field in manifest.json to its dist-relative path (for example "icon": "icon.svg").',
  ].join(' ')
}
