type XpraMouseHandler = (event: XpraMouseEvent) => void

interface XpraMouseEvent {
  clientX: number
  clientY: number
  which: number
  button: number
  buttons: number
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  originalEvent: PointerEvent | MouseEvent
  getModifierState: (key: string) => boolean
  preventDefault: () => void
  stopPropagation: () => void
}

interface XpraWindow {
  canvas?: HTMLCanvasElement
  on_mousedown?: XpraMouseHandler
  on_mouseup?: XpraMouseHandler
  on_mousemove?: XpraMouseHandler
}

interface XpraClient {
  id_to_window?: Record<string, XpraWindow>
}

interface LocalDesktopWindow extends Window {
  client?: XpraClient
  jQuery?: (target: string | Element) => { off: (events?: string) => void }
  __agentRiderInputBridge?: boolean
}

interface CanvasBridgeState {
  lastMouseDownAt: number
  lastMouseUpAt: number
  lastMouseMoveAt: number
  pointerButtons: Map<number, number>
}

const NORMAL_MOUSE_EVENT_WINDOW_MS = 80

function pointerButtonToXpraWhich(button: number) {
  if (button === 0) return 1
  if (button === 1) return 2
  if (button === 2) return 3
  if (button === 3) return 4
  if (button === 4) return 5
  return Math.max(0, button + 1)
}

function createXpraMouseEvent(event: PointerEvent | MouseEvent, which: number): XpraMouseEvent {
  const altKey = event.altKey
  const ctrlKey = event.ctrlKey
  const metaKey = event.metaKey
  const shiftKey = event.shiftKey
  const capsLock = event.getModifierState('CapsLock')
  const numLock = event.getModifierState('NumLock')
  const scrollLock = event.getModifierState('ScrollLock')

  return {
    clientX: event.clientX,
    clientY: event.clientY,
    which,
    button: Math.max(0, which - 1),
    buttons: event.buttons,
    altKey,
    ctrlKey,
    metaKey,
    shiftKey,
    originalEvent: event,
    getModifierState: (key) => {
      if (key === 'Alt') return altKey
      if (key === 'Control') return ctrlKey
      if (key === 'Meta') return metaKey
      if (key === 'Shift') return shiftKey
      if (key === 'CapsLock') return capsLock
      if (key === 'NumLock') return numLock
      if (key === 'ScrollLock') return scrollLock
      return false
    },
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  }
}

function isXpraCanvas(value: unknown): value is HTMLCanvasElement {
  return Boolean(value && typeof value === 'object' && (value as Element).tagName === 'CANVAS')
}

function getXpraWindows(desktopWindow: LocalDesktopWindow) {
  return Object.values(desktopWindow.client?.id_to_window ?? {}).filter((xpraWindow) => isXpraCanvas(xpraWindow.canvas))
}

function suppressNativeInputUi(event: Event) {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
}

function releasePasteboard(desktopWindow: LocalDesktopWindow, desktopDocument: Document) {
  const pasteboard = desktopDocument.getElementById('pasteboard') as HTMLTextAreaElement | null
  if (!pasteboard) return

  desktopWindow.jQuery?.(pasteboard).off('blur focus click contextmenu paste copy cut input')
  pasteboard.blur()
  pasteboard.readOnly = true
  pasteboard.tabIndex = -1
  pasteboard.setAttribute('aria-hidden', 'true')
  pasteboard.style.pointerEvents = 'none'
  pasteboard.style.userSelect = 'none'
  pasteboard.style.width = '0'
  pasteboard.style.height = '0'
  pasteboard.style.opacity = '0'
  pasteboard.style.overflow = 'hidden'
  if (pasteboard.dataset.agentRiderReleased !== 'true') {
    pasteboard.dataset.agentRiderReleased = 'true'
    pasteboard.addEventListener('contextmenu', suppressNativeInputUi, true)
    pasteboard.addEventListener('pointerdown', suppressNativeInputUi, true)
    pasteboard.addEventListener('mousedown', suppressNativeInputUi, true)
  }
}

function focusDesktopCanvas(canvas: HTMLCanvasElement, desktopDocument: Document) {
  const pasteboard = desktopDocument.getElementById('pasteboard') as HTMLTextAreaElement | null
  pasteboard?.blur()
  canvas.tabIndex = 0
  canvas.focus({ preventScroll: true })
}

function installCanvasBridge(
  desktopWindow: LocalDesktopWindow,
  desktopDocument: Document,
  xpraWindow: XpraWindow,
  installed: WeakSet<HTMLCanvasElement>,
) {
  const canvas = xpraWindow.canvas
  if (!canvas || installed.has(canvas)) return
  installed.add(canvas)

  const state: CanvasBridgeState = {
    lastMouseDownAt: 0,
    lastMouseUpAt: 0,
    lastMouseMoveAt: 0,
    pointerButtons: new Map(),
  }

  const now = () => desktopWindow.performance.now()
  const normalMouseArrived = (recordedAt: number, pointerAt: number) =>
    recordedAt >= pointerAt && recordedAt - pointerAt <= NORMAL_MOUSE_EVENT_WINDOW_MS

  canvas.addEventListener('mousedown', () => {
    state.lastMouseDownAt = now()
  }, true)
  canvas.addEventListener('mouseup', () => {
    state.lastMouseUpAt = now()
  }, true)
  canvas.addEventListener('mousemove', () => {
    state.lastMouseMoveAt = now()
  }, true)
  canvas.addEventListener('contextmenu', (event) => {
    suppressNativeInputUi(event)
  }, true)

  canvas.addEventListener('pointerdown', (event) => {
    suppressNativeInputUi(event)
    focusDesktopCanvas(canvas, desktopDocument)
    if (event.button < 0 && event.pointerType !== 'touch') return
    const pointerAt = now()
    const which = pointerButtonToXpraWhich(event.button < 0 ? 0 : event.button)
    const fallbackEvent = createXpraMouseEvent(event, which)
    state.pointerButtons.set(event.pointerId, which)
    desktopWindow.setTimeout(() => {
      if (!normalMouseArrived(state.lastMouseDownAt, pointerAt)) {
        xpraWindow.on_mousedown?.(fallbackEvent)
      }
    }, 0)
  }, true)

  canvas.addEventListener('pointerup', (event) => {
    suppressNativeInputUi(event)
    const pointerAt = now()
    const which = event.button >= 0
      ? pointerButtonToXpraWhich(event.button)
      : state.pointerButtons.get(event.pointerId) ?? 0
    const fallbackEvent = createXpraMouseEvent(event, which)
    state.pointerButtons.delete(event.pointerId)
    desktopWindow.setTimeout(() => {
      if (!normalMouseArrived(state.lastMouseUpAt, pointerAt)) {
        xpraWindow.on_mouseup?.(fallbackEvent)
      }
    }, 0)
  }, true)

  canvas.addEventListener('pointermove', (event) => {
    suppressNativeInputUi(event)
    const pointerAt = now()
    const fallbackEvent = createXpraMouseEvent(event, state.pointerButtons.get(event.pointerId) ?? 0)
    desktopWindow.setTimeout(() => {
      if (!normalMouseArrived(state.lastMouseMoveAt, pointerAt)) {
        xpraWindow.on_mousemove?.(fallbackEvent)
      }
    }, 0)
  }, true)

  canvas.addEventListener('pointercancel', (event) => {
    suppressNativeInputUi(event)
    state.pointerButtons.delete(event.pointerId)
  }, true)

  if (!('PointerEvent' in desktopWindow)) {
    canvas.addEventListener('mousedown', (event) => {
      suppressNativeInputUi(event)
      focusDesktopCanvas(canvas, desktopDocument)
      state.lastMouseDownAt = now()
      xpraWindow.on_mousedown?.(createXpraMouseEvent(event, pointerButtonToXpraWhich(event.button)))
    }, true)
    canvas.addEventListener('mouseup', (event) => {
      suppressNativeInputUi(event)
      state.lastMouseUpAt = now()
      xpraWindow.on_mouseup?.(createXpraMouseEvent(event, pointerButtonToXpraWhich(event.button)))
    }, true)
    canvas.addEventListener('mousemove', (event) => {
      suppressNativeInputUi(event)
      state.lastMouseMoveAt = now()
      xpraWindow.on_mousemove?.(createXpraMouseEvent(event, 0))
    }, true)
  }
}

export function installLocalDesktopInputBridge(frame: HTMLIFrameElement) {
  let desktopWindow: LocalDesktopWindow | null = null
  let desktopDocument: Document | null = null

  try {
    desktopWindow = frame.contentWindow as LocalDesktopWindow | null
    desktopDocument = frame.contentDocument
  } catch {
    return
  }

  if (!desktopWindow || !desktopDocument || desktopWindow.__agentRiderInputBridge) return
  desktopWindow.__agentRiderInputBridge = true

  const installed = new WeakSet<HTMLCanvasElement>()
  const installAll = () => {
    releasePasteboard(desktopWindow, desktopDocument)
    for (const xpraWindow of getXpraWindows(desktopWindow)) {
      installCanvasBridge(desktopWindow, desktopDocument, xpraWindow, installed)
    }
  }

  desktopDocument.addEventListener('contextmenu', suppressNativeInputUi, true)
  desktopDocument.addEventListener('selectstart', (event) => {
    if (event.target === desktopDocument.getElementById('pasteboard')) suppressNativeInputUi(event)
  }, true)

  const target = desktopDocument.getElementById('screen') ?? desktopDocument.body
  const MutationObserverCtor =
    (desktopWindow as LocalDesktopWindow & { MutationObserver?: typeof MutationObserver }).MutationObserver ?? MutationObserver
  const observer = new MutationObserverCtor(installAll)
  observer.observe(target, { childList: true, subtree: true })

  const intervalId = desktopWindow.setInterval(installAll, 500)
  desktopWindow.addEventListener('beforeunload', () => {
    observer.disconnect()
    desktopWindow.clearInterval(intervalId)
  }, { once: true })

  installAll()
}
