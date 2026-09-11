/** Matches MAX_CLIPBOARD_BYTES in src/backend/browser.rs and src/selkies/client.ts. */
export const MAX_BROWSER_PASTE_BYTES = 1_000_000

export interface BrowserPastePlan {
  text: string | null
  error: string | null
}

/**
 * Validate local clipboard text before it reaches the page. Rejecting here uses
 * the same wording the backend paste command returns, so an empty or oversized
 * clipboard reports one message instead of a silent no-op round trip.
 */
export function prepareBrowserPaste(raw: string): BrowserPastePlan {
  if (!raw) return { text: null, error: 'Browser clipboard is empty' }
  if (new TextEncoder().encode(raw).length > MAX_BROWSER_PASTE_BYTES) {
    return { text: null, error: 'Browser clipboard text is too large' }
  }
  return { text: raw, error: null }
}

/**
 * Embedded pastes travel over the control socket, so they only need that
 * session's display to be ready. External Chrome has no control-socket paste;
 * it rides the shared WebRTC data channel, which exists only while this panel
 * both has a running node-local Chrome and currently owns the shared display.
 */
export function browserPasteAvailable(
  mode: 'embedded' | 'external',
  displayReady: boolean,
  externalStreamReady: boolean,
  externalDisplayOwned: boolean,
) {
  return mode === 'external'
    ? externalStreamReady && externalDisplayOwned
    : displayReady
}
