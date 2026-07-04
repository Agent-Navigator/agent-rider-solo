import {
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  useCallback,
  useEffect,
  useState,
} from 'react'

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
  allow?: string
  onFrameLoad?: (frame: HTMLIFrameElement) => void
  focusFrameOnPointerDown?: boolean
  /** Runs just before the iframe is remounted (manual Reload or programmatic). */
  onBeforeReload?: () => void
  /** Receives an imperative reload handle so callers can remount the frame. */
  reloadRef?: MutableRefObject<(() => void) | null>
}

/**
 * Embeds an external web service in an iframe, framed with the same window
 * chrome (collapse / full-window / reload / close) as the Local Terminal.
 * Generic enough for any same-origin web view — shared infrastructure for
 * plugins that surface an embedded UI.
 */
export function WebView({
  title,
  src,
  onClose,
  collapsed,
  fullWindow,
  onStateChange,
  allow = 'clipboard-write; microphone',
  onFrameLoad,
  focusFrameOnPointerDown = false,
  onBeforeReload,
  reloadRef,
}: WebViewProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const [internalFullWindow, setInternalFullWindow] = useState(false)
  const isCollapsed = collapsed ?? internalCollapsed
  const isFullWindow = fullWindow ?? internalFullWindow
  // Bumping the key remounts the iframe — a clean reload of the embedded service.
  const [frameKey, setFrameKey] = useState(0)

  const reload = useCallback(() => {
    onBeforeReload?.()
    setFrameKey((current) => current + 1)
  }, [onBeforeReload])

  // Expose an imperative reload handle so callers can remount the frame (e.g.
  // to recover an embedded app from a disconnected state).
  useEffect(() => {
    if (!reloadRef) return
    reloadRef.current = reload
    return () => {
      if (reloadRef.current === reload) reloadRef.current = null
    }
  }, [reloadRef, reload])

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

  function releaseWorkspacePanelDrag(element: HTMLElement) {
    const panel = element.closest<HTMLElement>('.workspace-panel')
    if (panel) panel.draggable = false
  }

  function releaseWorkspacePanelDragOnHover(event: MouseEvent<HTMLElement>) {
    if (event.buttons === 0) releaseWorkspacePanelDrag(event.currentTarget)
  }

  function focusFrame(frame: HTMLIFrameElement) {
    if (!focusFrameOnPointerDown) return
    frame.focus()
  }

  function focusFrameOnPointer(event: PointerEvent<HTMLIFrameElement>) {
    if (!focusFrameOnPointerDown) return
    releaseWorkspacePanelDrag(event.currentTarget)
    focusFrame(event.currentTarget)
  }

  function releaseWorkspacePanelDragAndFocusOnHover(event: MouseEvent<HTMLIFrameElement>) {
    releaseWorkspacePanelDragOnHover(event)
    focusFrame(event.currentTarget)
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
              reload()
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
          draggable={false}
          tabIndex={focusFrameOnPointerDown ? 0 : undefined}
          onPointerDown={focusFrameOnPointer}
          onMouseEnter={releaseWorkspacePanelDragAndFocusOnHover}
          onFocus={(event) => releaseWorkspacePanelDrag(event.currentTarget)}
          onLoad={(event) => {
            releaseWorkspacePanelDrag(event.currentTarget)
            onFrameLoad?.(event.currentTarget)
          }}
          allow={allow}
          allowFullScreen
        />
      </div>
    </section>
  )
}
