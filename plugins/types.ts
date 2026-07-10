import type { ReactNode } from 'react'

/**
 * Context handed to a plugin when its panel is rendered in the workspace.
 */
export interface PluginPanelContext {
  /** Closes this plugin's panel (and deactivates its sidebar tool). */
  onClose: () => void
  /** Persisted panel chrome state owned by Agent Rider. */
  panelState?: PluginPanelState
  /** Persists chrome state changes such as collapse / full-window. */
  onPanelStateChange?: (patch: PluginPanelState) => void
  /** True while this panel is the single block filling the workspace grid. */
  maximized?: boolean
  /** Toggles this panel as the single block filling the workspace grid. */
  onToggleMaximize?: () => void
}

export interface PluginPanelState {
  collapsed?: boolean
  fullWindow?: boolean
}

/**
 * A drop-in Agent Rider plugin. Any `plugins/<name>/index.tsx` that
 * default-exports one of these is auto-registered (see `plugins/index.ts`) —
 * no edits to the main app are required to add a tool.
 */
export interface AgentRiderPlugin {
  /** Stable, unique id used to track open/closed state. */
  id: string
  /** Label shown for the launch button in the Resource sidebar. */
  label: string
  /** Sidebar group heading. Defaults to "Tools" when omitted. */
  group?: string
  /** Renders the plugin's panel in the conversation workspace. */
  renderPanel: (ctx: PluginPanelContext) => ReactNode
}
