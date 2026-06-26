import type { ReactNode } from 'react'

/**
 * Context handed to a plugin when its panel is rendered in the workspace.
 */
export interface PluginPanelContext {
  /** Closes this plugin's panel (and deactivates its sidebar tool). */
  onClose: () => void
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
