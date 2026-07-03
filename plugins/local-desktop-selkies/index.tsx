import type { AgentRiderPlugin } from '../types'
import { WebView } from '../WebView'

// Local GNOME desktop rendered through Selkies-GStreamer's WebRTC HTML client.
// The Vite dev/preview server proxies /selkies -> SELKIES_TARGET
// (default http://127.0.0.1:8080).
const LOCAL_DESKTOP_SELKIES_SRC = '/selkies/'
const LOCAL_DESKTOP_SELKIES_ALLOW =
  'fullscreen; pointer-lock; autoplay; clipboard-read; clipboard-write; keyboard-map; microphone'

const localDesktopSelkiesPlugin: AgentRiderPlugin = {
  id: 'local-desktop-selkies',
  label: 'Local Desktop (Selkies)',
  group: 'Tools',
  renderPanel: ({ onClose }) => (
    <WebView
      title="Local Desktop (Selkies)"
      src={LOCAL_DESKTOP_SELKIES_SRC}
      onClose={onClose}
      allow={LOCAL_DESKTOP_SELKIES_ALLOW}
      focusFrameOnPointerDown
    />
  ),
}

export default localDesktopSelkiesPlugin
