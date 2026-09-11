export interface BrowserSessionSnapshot {
  windowId: string
  url: string
  mode: 'embedded' | 'external'
  requestedMode?: 'auto' | 'embedded' | 'external'
  opencliSession?: string
  opencliProfile?: string
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Select a running backend Browser session without mutating or navigating it.
 * Desktop switches remount BrowserView, so reconnect must use this snapshot
 * before opening either the Embedded control socket or External WebRTC stream.
 */
export function findBrowserSessionSnapshot(
  payload: unknown,
  windowId: string,
): BrowserSessionSnapshot | null {
  if (!payload || typeof payload !== 'object') return null
  const sessions = (payload as { sessions?: unknown }).sessions
  if (!Array.isArray(sessions)) return null

  for (const candidate of sessions) {
    if (!candidate || typeof candidate !== 'object') continue
    const source = candidate as Record<string, unknown>
    if (source.windowId !== windowId || typeof source.url !== 'string') continue
    if (source.mode !== 'embedded' && source.mode !== 'external') continue
    const requestedMode = source.requestedMode === 'auto'
      || source.requestedMode === 'embedded'
      || source.requestedMode === 'external'
      ? source.requestedMode
      : undefined
    return {
      windowId,
      url: source.url,
      mode: source.mode,
      requestedMode,
      opencliSession: optionalString(source.opencliSession),
      opencliProfile: optionalString(source.opencliProfile),
    }
  }
  return null
}
