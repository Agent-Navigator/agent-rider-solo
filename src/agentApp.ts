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

export function agentAppLaunchPrompt(name: string, port: number) {
  const appName = name.trim() || 'New App'
  return [
    `Build or run the web app "${appName}" in the current workspace.`,
    `First check whether a web server is already responding on port ${port}.`,
    'If it is running, reuse that existing server; do not stop, restart, replace, or launch another server.',
    'Only start a development server when no server is already running on the required port.',
    `Start its development server on exactly port ${port} and bind it to 127.0.0.1 (or 0.0.0.0 if the framework requires it).`,
    'Do not choose a different port and do not open an external browser.',
    'Keep the server process running; Agent Rider will detect it and load the proxied App View automatically.',
  ].join(' ')
}
