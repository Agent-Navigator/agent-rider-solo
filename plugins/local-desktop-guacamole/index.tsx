import { useCallback, useEffect, useRef } from 'react'
import type { AgentRiderPlugin, PluginPanelContext } from '../types'
import { WebView } from '../WebView'

// Server-side middleware creates a short-lived Guacamole JSON-auth URL and
// redirects into the proxied Guacamole web app without exposing credentials.
const LOCAL_DESKTOP_GUACAMOLE_SRC = '/guacamole-auth/start'
const LOCAL_DESKTOP_GUACAMOLE_ALLOW =
  'fullscreen; pointer-lock; clipboard-read; clipboard-write; keyboard-map; microphone'

// Guacamole's webapp persists its session token here. It shares our origin
// (the desktop is proxied same-origin under /guacamole), so we can clear it to
// force a clean re-auth instead of the manual "log out + refresh" dance.
const GUACAMOLE_AUTH_TOKEN_KEY = 'GUAC_AUTH_TOKEN'
// How often to check the embedded client for a disconnect / error dialog.
const RECOVERY_POLL_MS = 2000
// Ignore the moments right after a (re)load so the initial "Connecting" dialog
// doesn't get mistaken for a failure.
const RECOVERY_GRACE_MS = 8000
// Give up auto-reconnecting after this many consecutive failures (the desktop
// is likely genuinely down) and leave Guacamole's own dialog on screen.
const MAX_RECOVERY_ATTEMPTS = 5

// Drop the stale Guacamole session token. When the iframe reloads afterwards it
// re-authenticates purely from the fresh JSON-auth blob, which is exactly what
// logging out and refreshing does by hand.
function clearGuacamoleSession() {
  try {
    window.localStorage.removeItem(GUACAMOLE_AUTH_TOKEN_KEY)
  } catch {
    // Ignore storage access errors (e.g. disabled storage); reload still helps.
  }
}

function LocalDesktopGuacamolePanel({ onClose, panelState, onPanelStateChange }: PluginPanelContext) {
  const reloadRef = useRef<(() => void) | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const attemptsRef = useRef(0)
  const lastReloadAtRef = useRef(Date.now())

  const handleBeforeReload = useCallback(() => {
    clearGuacamoleSession()
    lastReloadAtRef.current = Date.now()
  }, [])

  const handleFrameLoad = useCallback((frame: HTMLIFrameElement) => {
    frameRef.current = frame
    lastReloadAtRef.current = Date.now()
  }, [])

  useEffect(() => {
    const interval = window.setInterval(() => {
      const frame = frameRef.current
      if (!frame) return
      // Skip the grace window so a fresh "Connecting" dialog isn't treated as a
      // failure.
      if (Date.now() - lastReloadAtRef.current < RECOVERY_GRACE_MS) return

      let doc: Document | null = null
      try {
        doc = frame.contentDocument
      } catch {
        return // Cross-origin (shouldn't happen for the proxied desktop).
      }
      if (!doc) return

      const modal = doc.querySelector('.client-status-modal.shown')
      if (!modal) {
        // Healthy / connected — no dialog is up, so re-arm auto-recovery.
        attemptsRef.current = 0
        return
      }
      // A "Connecting" dialog is transient and benign; anything else shown here
      // is a disconnect or connection error we should recover from.
      if (modal.querySelector('.notification.connecting')) return
      if (attemptsRef.current >= MAX_RECOVERY_ATTEMPTS) return

      attemptsRef.current += 1
      reloadRef.current?.() // Triggers handleBeforeReload → clears token + remounts.
    }, RECOVERY_POLL_MS)

    return () => window.clearInterval(interval)
  }, [])

  return (
    <WebView
      title="Local Desktop (Guacamole)"
      src={LOCAL_DESKTOP_GUACAMOLE_SRC}
      onClose={onClose}
      allow={LOCAL_DESKTOP_GUACAMOLE_ALLOW}
      collapsed={panelState?.collapsed}
      fullWindow={panelState?.fullWindow}
      onStateChange={onPanelStateChange}
      onFrameLoad={handleFrameLoad}
      onBeforeReload={handleBeforeReload}
      reloadRef={reloadRef}
      focusFrameOnPointerDown
    />
  )
}

const localDesktopGuacamolePlugin: AgentRiderPlugin = {
  id: 'local-desktop-guacamole',
  label: 'Local Desktop (Guacamole)',
  group: 'Tools',
  renderPanel: (ctx) => <LocalDesktopGuacamolePanel {...ctx} />,
}

export default localDesktopGuacamolePlugin
