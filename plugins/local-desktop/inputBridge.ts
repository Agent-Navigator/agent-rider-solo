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
  send?: (...args: unknown[]) => unknown
  __agentRiderSendWrapped?: boolean
}

interface LocalDesktopWindow extends Window {
  client?: XpraClient
  jQuery?: (target: string | Element) => { off: (events?: string) => void }
  __agentRiderInputBridge?: boolean
  __agentRiderDiag?: boolean
}

// xpra wires native mouse input twice: jQuery(canvas).mousedown/up/move in
// Window.js and jQuery('#screen').mousedown/up/move in Client.js. We unbind
// both explicitly so the pointer-event bridge below is the only input path.
const XPRA_NATIVE_MOUSE_EVENTS = 'mousedown mouseup mousemove'

function unbindXpraNativeMouseHandlers(desktopWindow: LocalDesktopWindow, canvas?: HTMLCanvasElement) {
  try {
    desktopWindow.jQuery?.('#screen').off(XPRA_NATIVE_MOUSE_EVENTS)
    if (canvas) desktopWindow.jQuery?.(canvas).off(XPRA_NATIVE_MOUSE_EVENTS)
  } catch {
    // jQuery may not be ready yet; the document-level suppression still blocks
    // these handlers until the next install pass unbinds them.
  }
}

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

// Block xpra's own native mouse handling (and the browser's default paste/menu
// UI) at the document capture phase, so the pointer-event bridge is the single
// source of truth for mouse input. This is also what lets `pointerup` fire
// reliably (the native mousedown handling was swallowing the release). Wheel is
// left alone so xpra keeps handling scroll natively.
const SUPPRESSED_MOUSE_EVENTS = ['mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'auxclick', 'contextmenu']

function installNativeMouseSuppression(desktopDocument: Document) {
  for (const type of SUPPRESSED_MOUSE_EVENTS) {
    desktopDocument.addEventListener(type, suppressNativeInputUi, true)
  }
}

// ── TEMPORARY diagnostic ─────────────────────────────────────────────────────
// Shows pointer events and the actual button-action (button + down/up tally)
// sent to xpra. Remove once the fix is confirmed. Set to false to disable.
const DIAGNOSTIC = true

function installDiagnostics(desktopWindow: LocalDesktopWindow, desktopDocument: Document) {
  if (!DIAGNOSTIC) return
  const lines: string[] = []
  let overlay = desktopDocument.getElementById('agent-rider-diag') as HTMLDivElement | null
  if (!overlay) {
    overlay = desktopDocument.createElement('div')
    overlay.id = 'agent-rider-diag'
    overlay.style.cssText =
      'position:fixed;top:8px;left:8px;z-index:2147483647;max-width:70vw;padding:8px 10px;' +
      'background:rgba(4,10,18,0.92);color:#7be0a4;font:12px/1.4 ui-monospace,Menlo,monospace;' +
      'border:1px solid #2b6;border-radius:8px;white-space:pre;pointer-events:none;'
    overlay.textContent = 'diagnostic — click left then right (expect d==u)'
    ;(desktopDocument.body || desktopDocument.documentElement).appendChild(overlay)
  }
  const log = (line: string) => {
    lines.push(line)
    while (lines.length > 14) lines.shift()
    if (overlay) overlay.textContent = lines.join('\n')
  }

  const client = desktopWindow.client
  if (client && typeof client.send === 'function' && !client.__agentRiderSendWrapped) {
    const original = client.send.bind(client)
    client.__agentRiderSendWrapped = true
    let downs = 0
    let ups = 0
    client.send = (...args: unknown[]) => {
      const packet = args[0]
      if (Array.isArray(packet) && packet[0] === 'button-action') {
        if (packet[3]) downs += 1
        else ups += 1
        log(`→ xpra button=${packet[2]} pressed=${packet[3]} [d=${downs} u=${ups}]`)
      }
      return original(...args)
    }
  }

  if (desktopWindow.__agentRiderDiag) return
  desktopWindow.__agentRiderDiag = true
  for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
    desktopDocument.addEventListener(type, (event) => {
      const pe = event as PointerEvent
      log(`${type}: button=${pe.button} which=${(pe as unknown as MouseEvent).which} type=${pe.pointerType}`)
    }, true)
  }
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

  unbindXpraNativeMouseHandlers(desktopWindow, canvas)

  // We fully own input: xpra's own jQuery mouse handlers are unbound, native
  // mouse events are blocked at the document level, and this bridge forwards
  // exactly one synthetic press per (pointer, button) with a guaranteed matching
  // release. Without a guaranteed release, held buttons accumulate on the X
  // server and left+right chords get emulated as middle-click (paste).
  const heldButtons = new Map<number, Set<number>>() // pointerId -> held xpra `which` values

  const heldFor = (pointerId: number) => {
    let held = heldButtons.get(pointerId)
    if (!held) {
      held = new Set()
      heldButtons.set(pointerId, held)
    }
    return held
  }

  const releaseButton = (event: PointerEvent | MouseEvent, pointerId: number, which: number) => {
    const held = heldButtons.get(pointerId)
    if (!held?.delete(which)) return
    xpraWindow.on_mouseup?.(createXpraMouseEvent(event, which))
  }

  const releaseAll = (event: PointerEvent | MouseEvent, pointerId: number) => {
    const held = heldButtons.get(pointerId)
    if (!held) return
    for (const which of [...held]) releaseButton(event, pointerId, which)
  }

  canvas.addEventListener('pointerdown', (event) => {
    suppressNativeInputUi(event)
    focusDesktopCanvas(canvas, desktopDocument)
    if (event.button < 0) return
    const which = pointerButtonToXpraWhich(event.button)
    // Safety net: if this button's previous release was lost, release it before
    // pressing again so downs/ups never go out of balance.
    releaseButton(event, event.pointerId, which)
    heldFor(event.pointerId).add(which)
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {
      // Some pointer ids can't be captured; the release handlers below still fire.
    }
    xpraWindow.on_mousedown?.(createXpraMouseEvent(event, which))
  }, true)

  canvas.addEventListener('pointerup', (event) => {
    suppressNativeInputUi(event)
    if (event.button >= 0) {
      releaseButton(event, event.pointerId, pointerButtonToXpraWhich(event.button))
    } else {
      releaseAll(event, event.pointerId)
    }
    if (!heldButtons.get(event.pointerId)?.size) {
      try {
        canvas.releasePointerCapture(event.pointerId)
      } catch {
        // Capture may already be lost; ignore.
      }
    }
  }, true)

  canvas.addEventListener('pointermove', (event) => {
    suppressNativeInputUi(event)
    xpraWindow.on_mousemove?.(createXpraMouseEvent(event, 0))
  }, true)

  // Any abnormal end of the interaction must still release every held button.
  canvas.addEventListener('pointercancel', (event) => {
    suppressNativeInputUi(event)
    releaseAll(event, event.pointerId)
  }, true)
  canvas.addEventListener('lostpointercapture', (event) => {
    const pointerEvent = event as PointerEvent
    // Capture is implicitly lost after every pointerup; only force-release when
    // no physical buttons remain pressed (otherwise a held chord would be cut).
    if (pointerEvent.buttons === 0) releaseAll(pointerEvent, pointerEvent.pointerId)
  }, true)
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
    unbindXpraNativeMouseHandlers(desktopWindow)
    releasePasteboard(desktopWindow, desktopDocument)
    installDiagnostics(desktopWindow, desktopDocument)
    for (const xpraWindow of getXpraWindows(desktopWindow)) {
      installCanvasBridge(desktopWindow, desktopDocument, xpraWindow, installed)
    }
  }

  installNativeMouseSuppression(desktopDocument)
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
