import { type KeyboardEvent, useState } from 'react'

interface WebViewStatePatch {
  collapsed?: boolean
  fullWindow?: boolean
}

interface WebViewProps {
  title: string
  src: string
  onClose: () => void
  collapsed?: boolean
  fullWindow?: boolean
  onStateChange?: (patch: WebViewStatePatch) => void
}

/**
 * Embeds an external web service in an iframe, framed with the same window
 * chrome (collapse / full-window / reload / close) as the Local Terminal.
 * Generic enough for any same-origin web view — shared infrastructure for
 * plugins that surface an embedded UI.
 */
export function WebView({ title, src, onClose, collapsed, fullWindow, onStateChange }: WebViewProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const [internalFullWindow, setInternalFullWindow] = useState(false)
  const isCollapsed = collapsed ?? internalCollapsed
  const isFullWindow = fullWindow ?? internalFullWindow
  // Bumping the key remounts the iframe — a clean reload of the embedded service.
  const [frameKey, setFrameKey] = useState(0)

  function setCollapsedState(updater: boolean | ((current: boolean) => boolean)) {
    const next = typeof updater === 'function' ? updater(isCollapsed) : updater
    if (collapsed === undefined) setInternalCollapsed(next)
    onStateChange?.({ collapsed: next })
  }

  function setFullWindowState(updater: boolean | ((current: boolean) => boolean)) {
    const next = typeof updater === 'function' ? updater(isFullWindow) : updater
    if (fullWindow === undefined) setInternalFullWindow(next)
    onStateChange?.({ fullWindow: next })
  }

  function toggleFromKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    setCollapsedState((current) => !current)
  }

  return (
    <section
      className={`web-terminal web-view ${isCollapsed ? 'collapsed' : ''} ${isFullWindow ? 'full-window' : ''}`}
      aria-label={title}
    >
      <div
        className="terminal-head"
        role="button"
        tabIndex={0}
        aria-expanded={!isCollapsed}
        onClick={() => setCollapsedState((current) => !current)}
        onKeyDown={toggleFromKey}
      >
        <span className={`terminal-caret ${isCollapsed ? '' : 'open'}`} aria-hidden>
          ▾
        </span>
        <div>
          <div className="eyebrow">Resource · Tools</div>
          <h2>{title}</h2>
        </div>
        <div className="terminal-actions">
          <button
            type="button"
            className="terminal-icon-button"
            title={isFullWindow ? 'Exit full window' : 'Expand to full window'}
            aria-label={isFullWindow ? 'Exit full window' : 'Expand to full window'}
            onClick={(event) => {
              event.stopPropagation()
              setFullWindowState((current) => !current)
            }}
          >
            {isFullWindow ? '↙' : '⛶'}
          </button>
          <button
            type="button"
            className="terminal-clear"
            onClick={(event) => {
              event.stopPropagation()
              setFrameKey((current) => current + 1)
            }}
          >
            Reload
          </button>
          <button
            type="button"
            className="card-close"
            title={`Close ${title}`}
            aria-label={`Close ${title}`}
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
          >
            ×
          </button>
        </div>
      </div>

      <div className="terminal-body" aria-hidden={isCollapsed}>
        <iframe
          key={frameKey}
          className="web-view-frame"
          src={src}
          title={title}
          allow="clipboard-write; microphone"
        />
      </div>
    </section>
  )
}
