import type { AgentRiderPlugin } from '../types'
import { WebView } from '../WebView'

// Local GNOME desktop rendered through KasmVNC's HTML client.
// The Vite dev/preview server proxies /kasm -> 127.0.0.1:14510.
const LOCAL_DESKTOP_KASM_SRC =
  '/kasm/?autoconnect=1&path=kasm/websockify&resize=scale&enable_webp=0&enable_webrtc=0&enable_threading=0'
const LOCAL_DESKTOP_KASM_ALLOW = 'fullscreen; pointer-lock; microphone'

const localDesktopKasmPlugin: AgentRiderPlugin = {
  id: 'local-desktop-kasm',
  label: 'Local Desktop (Kasm)',
  group: 'Tools',
  renderPanel: ({ onClose }) => (
    <WebView
      title="Local Desktop (Kasm)"
      src={LOCAL_DESKTOP_KASM_SRC}
      onClose={onClose}
      allow={LOCAL_DESKTOP_KASM_ALLOW}
    />
  ),
}

export default localDesktopKasmPlugin
