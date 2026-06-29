import type { AgentRiderPlugin } from '../types'
import { WebView } from '../WebView'

// Local XFCE desktop rendered through xpra's HTML client.
// The Vite dev/preview server proxies /desktop -> 127.0.0.1:14500.
const localDesktopPlugin: AgentRiderPlugin = {
  id: 'local-desktop',
  label: 'Local Desktop',
  group: 'Tools',
  renderPanel: ({ onClose }) => <WebView title="Local Desktop" src="/desktop/" onClose={onClose} />,
}

export default localDesktopPlugin
