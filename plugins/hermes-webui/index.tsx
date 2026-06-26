import type { AgentRiderPlugin } from '../types'
import { WebView } from '../WebView'

// Same-origin mount of the Hermes WebUI (see the /hermes-ui proxy in
// vite.config.ts, which strips the X-Frame-Options / CSP headers Hermes sends
// so the UI can be embedded in an iframe).
const HERMES_WEBUI_SRC = '/hermes-ui/'

const hermesWebUiPlugin: AgentRiderPlugin = {
  id: 'hermes-webui',
  label: 'Hermes WebUI',
  group: 'Tools',
  renderPanel: ({ onClose }) => <WebView title="Hermes WebUI" src={HERMES_WEBUI_SRC} onClose={onClose} />,
}

export default hermesWebUiPlugin
