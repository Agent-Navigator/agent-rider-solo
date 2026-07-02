import type { AgentRiderPlugin } from '../types'
import { WebView } from '../WebView'
import { installLocalDesktopInputBridge } from './inputBridge'

// Local GNOME desktop rendered through xpra's HTML client.
// The Vite dev/preview server proxies /desktop -> 127.0.0.1:14500.
const LOCAL_DESKTOP_SRC = '/desktop/?sharing=true&steal=true&insecure=true&clipboard=false'
const LOCAL_DESKTOP_ALLOW = 'fullscreen; pointer-lock; microphone'

const localDesktopPlugin: AgentRiderPlugin = {
  id: 'local-desktop',
  label: 'Local Desktop',
  group: 'Tools',
  renderPanel: ({ onClose }) => (
    <WebView
      title="Local Desktop"
      src={LOCAL_DESKTOP_SRC}
      onClose={onClose}
      allow={LOCAL_DESKTOP_ALLOW}
      onFrameLoad={installLocalDesktopInputBridge}
    />
  ),
}

export default localDesktopPlugin
