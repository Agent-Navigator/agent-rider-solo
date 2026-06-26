import { type KeyboardEvent, useState } from 'react'

/**
 * Embeds an external web service in an iframe, framed with the same window
 * chrome (collapse / full-window / reload / close) as the Local Terminal.
 * Generic enough for any same-origin web view — shared infrastructure for
 * plugins that surface an embedded UI.
 */
export function WebView({ title, src, onClose }: { title: string; src: string; onClose: () => void }) {
  const [collapsed, setCollapsed] = useState(false)
  const [fullWindow, setFullWindow] = useState(false)
  // Bumping the key remounts the iframe — a clean reload of the embedded service.
  const [frameKey, setFrameKey] = useState(0)

  function toggleFromKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    setCollapsed((current) => !current)
  }

  return (
    <section
      className={`web-terminal web-view ${collapsed ? 'collapsed' : ''} ${fullWindow ? 'full-window' : ''}`}
      aria-label={title}
    >
      <div
        className="terminal-head"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((current) => !current)}
        onKeyDown={toggleFromKey}
      >
        <span className={`terminal-caret ${collapsed ? '' : 'open'}`} aria-hidden>
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
            title={fullWindow ? 'Exit full window' : 'Expand to full window'}
            aria-label={fullWindow ? 'Exit full window' : 'Expand to full window'}
            onClick={(event) => {
              event.stopPropagation()
              setFullWindow((current) => !current)
            }}
          >
            {fullWindow ? '↙' : '⛶'}
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

      <div className="terminal-body" aria-hidden={collapsed}>
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
