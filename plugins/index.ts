import type { AgentRiderPlugin } from './types'

export type { AgentRiderPlugin, PluginPanelContext } from './types'

// Auto-discover every plugin: any `plugins/<name>/index.{ts,tsx}` that
// default-exports an AgentRiderPlugin is registered automatically. Drop a new
// folder in here and it shows up in the Resource sidebar — no main-app edits.
const modules = import.meta.glob('./*/index.{ts,tsx}', { eager: true }) as Record<
  string,
  { default?: AgentRiderPlugin }
>

export const plugins: AgentRiderPlugin[] = Object.keys(modules)
  .sort()
  .map((path) => modules[path].default)
  .filter((plugin): plugin is AgentRiderPlugin => Boolean(plugin))
