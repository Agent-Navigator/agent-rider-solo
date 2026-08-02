import {
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
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
  meta?: string
  frameToolbar?: ReactNode
  frameFooter?: ReactNode
  collapsed?: boolean
  fullWindow?: boolean
  /** True while this panel is the single block filling the workspace grid. */
  maximized?: boolean
  /** Toggles this panel as the single block filling the workspace grid. */
  onToggleMaximize?: () => void
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
  meta = 'Resource · Tools',
  frameToolbar,
  frameFooter,
  collapsed,
  fullWindow,
  maximized,
  onToggleMaximize,
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
  const frameRef = useRef<HTMLIFrameElement | null>(null)

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
      className={`web-terminal web-view ${frameToolbar ? 'has-frame-toolbar' : ''} ${frameFooter ? 'has-frame-footer' : ''} ${isCollapsed ? 'collapsed' : ''} ${isFullWindow ? 'full-window' : ''}`}
      aria-label={title}
    >
      <div className="win-titlebar">
        <span className="win-grip" aria-hidden>
          <svg width="8" height="14" viewBox="0 0 8 14">
            <circle cx="2" cy="2" r="1.3" fill="currentColor" />
            <circle cx="6" cy="2" r="1.3" fill="currentColor" />
            <circle cx="2" cy="7" r="1.3" fill="currentColor" />
            <circle cx="6" cy="7" r="1.3" fill="currentColor" />
            <circle cx="2" cy="12" r="1.3" fill="currentColor" />
            <circle cx="6" cy="12" r="1.3" fill="currentColor" />
          </svg>
        </span>
        <span className="win-dot" style={{ background: '#46c98b' }} aria-hidden />
        <span className="win-title">{title}</span>
        <span className="win-meta">{meta}</span>
        <div className="win-spacer" />
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
          className="win-btn"
          title={isCollapsed ? 'Expand window' : 'Collapse window'}
          aria-label={isCollapsed ? 'Expand window' : 'Collapse window'}
          aria-expanded={!isCollapsed}
          onClick={() => setCollapsedState((current) => !current)}
        >
          <span className={`conv-caret ${isCollapsed ? '' : 'open'}`} aria-hidden>▾</span>
        </button>
        {onToggleMaximize ? (
          <button
            type="button"
            className="win-btn"
            title={maximized ? 'Restore grid layout' : 'Maximize in grid'}
            aria-label={maximized ? 'Restore grid layout' : 'Maximize in grid'}
            onClick={(event) => {
              event.stopPropagation()
              onToggleMaximize()
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              {maximized ? (
                <>
                  <rect x="2.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M5.5 3h6.5a1.5 1.5 0 011.5 1.5V11" stroke="currentColor" strokeWidth="1.3" />
                </>
              ) : (
                <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              )}
            </svg>
          </button>
        ) : null}
        <button
          type="button"
          className="win-btn"
          title={isFullWindow ? 'Exit full window' : 'Expand to full window'}
          aria-label={isFullWindow ? 'Exit full window' : 'Expand to full window'}
          onClick={(event) => {
            event.stopPropagation()
            setFullWindowState((current) => !current)
          }}
        >
          {isFullWindow ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="win-btn win-btn-close"
          title={`Close ${title}`}
          aria-label={`Close ${title}`}
          onClick={(event) => {
            event.stopPropagation()
            onClose()
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="terminal-body" aria-hidden={isCollapsed}>
        {frameToolbar}
        <iframe
          key={frameKey}
          ref={frameRef}
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
        {frameFooter}
      </div>
    </section>
  )
}
