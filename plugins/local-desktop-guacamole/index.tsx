import type { AgentRiderPlugin } from '../types'
import { WebView } from '../WebView'

// Server-side middleware creates a short-lived Guacamole JSON-auth URL and
// redirects into the proxied Guacamole web app without exposing credentials.
const LOCAL_DESKTOP_GUACAMOLE_SRC = '/guacamole-auth/start'
const LOCAL_DESKTOP_GUACAMOLE_ALLOW =
  'fullscreen; pointer-lock; clipboard-read; clipboard-write; keyboard-map; microphone'

const localDesktopGuacamolePlugin: AgentRiderPlugin = {
  id: 'local-desktop-guacamole',
  label: 'Local Desktop (Guacamole)',
  group: 'Tools',
  renderPanel: ({ onClose, panelState, onPanelStateChange }) => (
    <WebView
      title="Local Desktop (Guacamole)"
      src={LOCAL_DESKTOP_GUACAMOLE_SRC}
      onClose={onClose}
      allow={LOCAL_DESKTOP_GUACAMOLE_ALLOW}
      collapsed={panelState?.collapsed}
      fullWindow={panelState?.fullWindow}
      onStateChange={onPanelStateChange}
      focusFrameOnPointerDown
    />
  ),
}

export default localDesktopGuacamolePlugin
