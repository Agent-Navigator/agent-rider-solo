/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file adapts the Selkies v1.6.2 signalling, WebRTC, and input
 * modules:
 * https://github.com/selkies-project/selkies/tree/v1.6.2/addons/gst-web/src
 *
 * The adapted upstream files incorporate work covered by:
 *
 *   Copyright 2019 Google LLC
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *        http://www.apache.org/licenses/LICENSE-2.0
 */

const MAX_REMOTE_DIMENSION = 8192
const MAX_CLIPBOARD_BYTES = 1_000_000
const SELKIES_VIDEO_PEER_ID = 1
/**
 * How long the hidden paste sink may hold focus while waiting for the shortcut's
 * ClipboardEvent. Engines dispatch that event synchronously with the shortcut's
 * default action, so this only has to outlast one task.
 */
const PASTE_EVENT_GRACE_MS = 150

type SelkiesState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

type SelkiesCallbacks = {
  onStateChange?: (state: SelkiesState) => void
  onStatus?: (message: string) => void
  onError?: (message: string) => void
  onClipboard?: (text: string) => void
  onPaste?: (text: string) => void
}

type SelkiesRtcConfig = RTCConfiguration & {
  iceTimeoutMs?: number
  peerId?: number
}

type SelkiesDataMessage = {
  type?: string
  data?: {
    status?: string
    content?: string
    curdata?: string
    handle?: string | number
    hotspot?: { x?: number; y?: number }
    override?: string | null
    action?: string
  } | null
}

const SPECIAL_KEYSYMS: Record<string, number> = {
  Backspace: 65288,
  Tab: 65289,
  Enter: 65293,
  Escape: 65307,
  Home: 65360,
  ArrowLeft: 65361,
  ArrowUp: 65362,
  ArrowRight: 65363,
  ArrowDown: 65364,
  PageUp: 65365,
  PageDown: 65366,
  End: 65367,
  Insert: 65379,
  Delete: 65535,
  F1: 65470,
  F2: 65471,
  F3: 65472,
  F4: 65473,
  F5: 65474,
  F6: 65475,
  F7: 65476,
  F8: 65477,
  F9: 65478,
  F10: 65479,
  F11: 65480,
  F12: 65481,
  NumLock: 65407,
  CapsLock: 65509,
  ScrollLock: 65300,
  Pause: 65299,
  PrintScreen: 65377,
  ContextMenu: 65383,
}

const CODE_KEYSYMS: Record<string, number> = {
  ShiftLeft: 65505,
  ShiftRight: 65506,
  ControlLeft: 65507,
  ControlRight: 65508,
  AltLeft: 65513,
  AltRight: 65027,
  MetaLeft: 65515,
  MetaRight: 65516,
}

const SAFE_CURSOR_OVERRIDES = new Set([
  'alias',
  'all-scroll',
  'auto',
  'cell',
  'col-resize',
  'context-menu',
  'copy',
  'crosshair',
  'default',
  'e-resize',
  'ew-resize',
  'grab',
  'grabbing',
  'help',
  'move',
  'n-resize',
  'ne-resize',
  'nesw-resize',
  'no-drop',
  'none',
  'not-allowed',
  'ns-resize',
  'nw-resize',
  'nwse-resize',
  'pointer',
  'progress',
  'row-resize',
  's-resize',
  'se-resize',
  'sw-resize',
  'text',
  'vertical-text',
  'w-resize',
  'wait',
  'zoom-in',
  'zoom-out',
])

export class SelkiesClient {
  private readonly video: HTMLVideoElement
  private readonly viewport: HTMLElement
  private readonly windowId: string
  private readonly callbacks: SelkiesCallbacks
  private peer: RTCPeerConnection | null = null
  private signalling: WebSocket | null = null
  private dataChannel: RTCDataChannel | null = null
  private remoteDescriptionSet = false
  private pendingIce: RTCIceCandidateInit[] = []
  private iceTimeout: number | null = null
  private resizeTimer: number | null = null
  private resizeObserver: ResizeObserver | null = null
  private disconnecting = false
  private inputCleanup: Array<() => void> = []
  private buttonMask = 0
  private lastRightPointerTime = Number.NEGATIVE_INFINITY
  private pressedKeys = new Map<string, number>()
  private suppressedCopyKeys = new Set<string>()
  private suppressedPasteKeys = new Set<string>()
  private pasteSink: HTMLElement | null = null
  private sinkReleaseTimer: number | null = null
  private cursorCache = new Map<string, string>()

  constructor(
    video: HTMLVideoElement,
    windowId: string,
    callbacks: SelkiesCallbacks = {},
    viewport: HTMLElement = video,
  ) {
    this.video = video
    this.viewport = viewport
    this.windowId = windowId
    this.callbacks = callbacks
  }

  async connect() {
    this.disconnecting = false
    this.callbacks.onStateChange?.('connecting')
    this.callbacks.onStatus?.('Loading WebRTC configuration...')
    const endpoint = `/store/browser/webrtc/${encodeURIComponent(this.windowId)}/config`
    const response = await fetch(endpoint, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
    const config = await response.json() as SelkiesRtcConfig & { error?: string }
    if (!response.ok) throw new Error(config.error || 'Unable to load Browser WebRTC configuration')

    const peer = new RTCPeerConnection({
      iceServers: Array.isArray(config.iceServers) ? config.iceServers : [],
      iceTransportPolicy: config.iceTransportPolicy === 'relay' ? 'relay' : 'all',
      bundlePolicy: 'max-compat',
    })
    this.peer = peer
    peer.ontrack = (event) => {
      if (event.track.kind !== 'video') return
      this.video.srcObject = event.streams[0] ?? new MediaStream([event.track])
      void this.video.play().catch(() => {
        this.callbacks.onStatus?.('Click the Browser display to start video playback')
      })
    }
    peer.onicecandidate = (event) => {
      if (event.candidate) this.sendSignalling({ ice: event.candidate.toJSON() })
    }
    peer.ondatachannel = (event) => this.bindDataChannel(event.channel)
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState
      if (state === 'connected') {
        this.clearIceTimeout()
        this.minimizeReceiverLatency()
        this.callbacks.onStateChange?.('connected')
        this.callbacks.onStatus?.('Browser connected over WebRTC')
      } else if (state === 'failed') {
        this.callbacks.onStateChange?.('failed')
        this.callbacks.onError?.(this.turnRequiredMessage())
      } else if (state === 'disconnected') {
        this.callbacks.onStateChange?.('disconnected')
      } else if (state === 'closed') {
        this.callbacks.onStateChange?.('closed')
      }
    }

    const signallingUrl = new URL(
      `/store/browser/webrtc/${encodeURIComponent(this.windowId)}/signalling`,
      window.location.href,
    )
    signallingUrl.protocol = signallingUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    const signalling = new WebSocket(signallingUrl)
    this.signalling = signalling
    signalling.addEventListener('open', () => {
      if (this.disconnecting || this.signalling !== signalling) return
      const resolution = this.measureResolution()
      const metadata = btoa(JSON.stringify({
        res: `${resolution.width}x${resolution.height}`,
        scale: resolution.scale,
      }))
      signalling.send(`HELLO ${config.peerId ?? SELKIES_VIDEO_PEER_ID} ${metadata}`)
      this.callbacks.onStatus?.('Negotiating H.264 WebRTC stream...')
      this.startIceTimeout(config.iceTimeoutMs ?? 10_000)
    })
    signalling.addEventListener('message', (event) => {
      if (typeof event.data === 'string') void this.handleSignallingMessage(event.data)
    })
    signalling.addEventListener('error', () => {
      if (!this.disconnecting) this.callbacks.onError?.('Browser WebRTC signaling failed')
    })
    signalling.addEventListener('close', () => {
      if (!this.disconnecting) this.callbacks.onStateChange?.('disconnected')
    })
  }

  disconnect() {
    this.disconnecting = true
    this.clearIceTimeout()
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer)
    this.resizeTimer = null
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.detachInput()
    this.dataChannel?.close()
    this.dataChannel = null
    this.signalling?.close()
    this.signalling = null
    this.peer?.close()
    this.peer = null
    this.video.srcObject = null
    this.video.style.cursor = 'default'
  }

  requestResize() {
    if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer)
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = null
      const resolution = this.measureResolution()
      this.sendData(`r,${resolution.width}x${resolution.height}`)
      this.sendData(`s,${resolution.scale}`)
    }, 120)
  }

  private async handleSignallingMessage(data: string) {
    if (data === 'HELLO') return
    if (data.startsWith('ERROR')) {
      this.callbacks.onError?.(`Selkies signaling error: ${data}`)
      return
    }
    let message: { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit }
    try {
      message = JSON.parse(data) as typeof message
    } catch {
      this.callbacks.onError?.('Selkies signaling returned an invalid message')
      return
    }
    if (message.sdp) {
      await this.acceptOffer(message.sdp)
    } else if (message.ice) {
      if (this.remoteDescriptionSet && this.peer) {
        await this.peer.addIceCandidate(message.ice).catch(() => {})
      } else {
        this.pendingIce.push(message.ice)
      }
    }
  }

  private async acceptOffer(description: RTCSessionDescriptionInit) {
    const peer = this.peer
    if (!peer || description.type !== 'offer') {
      this.callbacks.onError?.('Selkies returned an invalid WebRTC offer')
      return
    }
    try {
      await peer.setRemoteDescription(description)
      this.remoteDescriptionSet = true
      for (const candidate of this.pendingIce.splice(0)) {
        await peer.addIceCandidate(candidate)
      }
      const answer = await peer.createAnswer()
      const munged = {
        type: answer.type,
        sdp: ensureH264KeyframeParameters(answer.sdp ?? ''),
      } satisfies RTCSessionDescriptionInit
      await peer.setLocalDescription(munged)
      if (peer.localDescription) this.sendSignalling({ sdp: peer.localDescription.toJSON() })
    } catch {
      this.callbacks.onError?.('Unable to negotiate the Selkies H.264 stream')
    }
  }

  private sendSignalling(message: object) {
    if (this.signalling?.readyState === WebSocket.OPEN) {
      this.signalling.send(JSON.stringify(message))
    }
  }

  private bindDataChannel(channel: RTCDataChannel) {
    this.dataChannel?.close()
    this.dataChannel = channel
    channel.onopen = () => {
      this.attachInput()
      // The Xvfb/Chrome session outlives frontend reconnects, so a key that was
      // held when the previous channel closed (e.g. the app reloaded mid-press)
      // stays down on the remote X server and autorepeats into the focused page.
      // Reset the remote keyboard and our local tracking on every fresh channel.
      this.sendData('kr')
      this.pressedKeys.clear()
      this.suppressedCopyKeys.clear()
      this.suppressedPasteKeys.clear()
      this.sendData('p,0')
      this.requestResize()
    }
    channel.onclose = () => this.detachInput()
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') this.handleDataMessage(event.data)
    }
  }

  private handleDataMessage(data: string) {
    let message: SelkiesDataMessage
    try {
      message = JSON.parse(data) as SelkiesDataMessage
    } catch {
      return
    }
    if (message.type === 'pipeline' && message.data?.status) {
      this.callbacks.onStatus?.(message.data.status)
    } else if (message.type === 'clipboard' && message.data?.content) {
      const text = decodeBase64Text(message.data.content)
      if (text !== null) this.callbacks.onClipboard?.(text)
    } else if (message.type === 'cursor' && message.data) {
      this.applyRemoteCursor(message.data)
    } else if (message.type === 'ping') {
      this.sendData(`pong,${Date.now() / 1000}`)
    }
  }

  private applyRemoteCursor(data: NonNullable<SelkiesDataMessage['data']>) {
    const handle = String(data.handle ?? '0')
    if (handle === '0') {
      this.video.style.cursor = 'auto'
      return
    }
    if (data.override && SAFE_CURSOR_OVERRIDES.has(data.override)) {
      this.video.style.cursor = data.override
      return
    }
    if (!data.curdata || data.curdata.length > 1_500_000 || !/^[A-Za-z0-9+/=]+$/.test(data.curdata)) {
      return
    }
    let cursor = this.cursorCache.get(handle)
    if (!cursor) {
      cursor = `url("data:image/png;base64,${data.curdata}")`
      this.cursorCache.set(handle, cursor)
    }
    const x = Math.max(0, Math.min(Math.trunc(data.hotspot?.x ?? 0), 256))
    const y = Math.max(0, Math.min(Math.trunc(data.hotspot?.y ?? 0), 256))
    this.video.style.cursor = `${cursor} ${x} ${y}, auto`
  }

  private attachInput() {
    if (this.inputCleanup.length) return
    const listen = <K extends keyof HTMLElementEventMap>(
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      this.video.addEventListener(type, listener as EventListener, options)
      this.inputCleanup.push(() => this.video.removeEventListener(type, listener as EventListener, options))
    }

    listen('contextmenu', (event) => {
      event.preventDefault()
      if (event.button !== 2) return

      const rightButtonMask = 1 << 2
      const pointerSequenceWasForwarded = (this.buttonMask & rightButtonMask) !== 0
        || event.timeStamp - this.lastRightPointerTime < 1000
      if (pointerSequenceWasForwarded) return

      // Some browsers can emit contextmenu without a matching pointer sequence.
      // Forward a complete right click so Chrome still receives the action.
      this.video.focus()
      this.buttonMask |= rightButtonMask
      this.sendPointer(event)
      this.buttonMask &= ~rightButtonMask
      this.sendPointer(event)
    })
    listen('pointermove', (event) => this.sendPointer(event))
    listen('pointerdown', (event) => {
      event.preventDefault()
      this.video.focus()
      if (event.button === 2) this.lastRightPointerTime = event.timeStamp
      this.buttonMask |= 1 << event.button
      if (!this.video.hasPointerCapture(event.pointerId)) this.video.setPointerCapture(event.pointerId)
      this.sendPointer(event)
    })
    listen('pointerup', (event) => {
      event.preventDefault()
      if (event.button === 2) this.lastRightPointerTime = event.timeStamp
      this.buttonMask &= ~(1 << event.button)
      this.sendPointer(event)
      if (this.video.hasPointerCapture(event.pointerId)) this.video.releasePointerCapture(event.pointerId)
    })
    listen('pointercancel', (event) => {
      this.buttonMask = 0
      this.sendPointer(event)
    })
    listen('wheel', (event) => this.sendWheel(event), { passive: false })
    listen('keydown', (event) => this.sendKey(event, true))
    listen('keyup', (event) => this.sendKey(event, false))
    // Ctrl/Cmd+V arrives as a ClipboardEvent whose target is engine-specific: the
    // focused element in Chrome, the element owning the document selection in
    // engines that derive it that way, and the hidden paste sink once focusPasteSink
    // has handed the shortcut an editable target. Capture on the document to cover
    // all three, and claim the event only while this panel owns keyboard focus so a
    // paste reaches exactly one Browser window and never steals from an Agent Rider
    // text field.
    const ownerDocument = this.video.ownerDocument ?? null
    if (ownerDocument) {
      const onDocumentPaste = (event: Event) => this.handlePasteEvent(event as ClipboardEvent)
      ownerDocument.addEventListener('paste', onDocumentPaste, true)
      this.inputCleanup.push(() => {
        ownerDocument.removeEventListener('paste', onDocumentPaste, true)
      })
    }
    // Create the sink up front: in Gecko its presence alone is what restores paste
    // events for the video, so it has to exist before the first shortcut, not after.
    this.ensurePasteSink()
    listen('blur', () => {
      this.sendData('kr')
      this.pressedKeys.clear()
      this.suppressedCopyKeys.clear()
      this.suppressedPasteKeys.clear()
    })

    this.resizeObserver = new ResizeObserver(() => this.requestResize())
    this.resizeObserver.observe(this.viewport)
  }

  private detachInput() {
    for (const cleanup of this.inputCleanup.splice(0)) cleanup()
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.buttonMask = 0
    this.lastRightPointerTime = Number.NEGATIVE_INFINITY
    this.pressedKeys.clear()
    this.suppressedCopyKeys.clear()
    this.suppressedPasteKeys.clear()
    this.clearSinkRelease()
    this.pasteSink?.remove()
    this.pasteSink = null
  }

  private sendPointer(event: MouseEvent) {
    const position = this.pointerPosition(event.clientX, event.clientY)
    this.sendData(`m,${position.x},${position.y},${this.buttonMask},0`)
  }

  private sendWheel(event: WheelEvent) {
    event.preventDefault()
    if (event.deltaY === 0) return
    const position = this.pointerPosition(event.clientX, event.clientY)
    const button = event.deltaY < 0 ? 3 : 4
    const mask = 1 << button
    const magnitude = Math.max(1, Math.min(Math.round(Math.abs(event.deltaY) / 80), 10))
    this.sendData(`m,${position.x},${position.y},${this.buttonMask | mask},${magnitude}`)
    this.sendData(`m,${position.x},${position.y},${this.buttonMask},${magnitude}`)
  }

  private sendKey(event: KeyboardEvent, down: boolean) {
    const clipboardShortcut = (event.ctrlKey || event.metaKey) && !event.altKey
    if (down && clipboardShortcut && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      if (this.suppressedCopyKeys.has(event.code)) return
      this.suppressedCopyKeys.add(event.code)
      this.copyRemoteSelection()
      return
    }
    if (!down && this.suppressedCopyKeys.delete(event.code)) {
      event.preventDefault()
      return
    }
    if (down && clipboardShortcut && event.key.toLowerCase() === 'v') {
      // Keep the native default so the browser still runs its paste command, and
      // hand it an editable target first. Focus must move synchronously, before
      // this event's default action is processed.
      this.suppressedPasteKeys.add(event.code)
      this.focusPasteSink()
      return
    }
    if (!down && this.suppressedPasteKeys.delete(event.code)) {
      event.preventDefault()
      return
    }
    const keysym = down
      ? keysymForKeyboardEvent(event)
      : this.pressedKeys.get(event.code) ?? keysymForKeyboardEvent(event)
    if (keysym === null) return
    event.preventDefault()
    if (down) {
      this.pressedKeys.set(event.code, keysym)
      this.sendData(`kd,${keysym}`)
    } else {
      this.pressedKeys.delete(event.code)
      this.sendData(`ku,${keysym}`)
    }
  }

  /**
   * A ClipboardEvent belongs to this panel only while the panel owns keyboard
   * focus. Clicking the page focuses the video, which is also what makes the
   * keydown listener receive Ctrl/Cmd+V in the first place, so this matches the
   * shortcut's own precondition and keeps sibling Browser windows out.
   */
  private ownsKeyboardFocus() {
    const active = this.video.ownerDocument?.activeElement ?? null
    if (!active) return false
    if (active === this.video || active === this.viewport || active === this.pasteSink) return true
    return this.viewport.contains?.(active as Node) === true
  }

  private handlePasteEvent(event: ClipboardEvent) {
    if (!this.ownsKeyboardFocus()) return
    event.preventDefault()
    this.releasePasteSink()
    this.deliverPaste(event.clipboardData?.getData('text/plain') ?? '')
  }

  /**
   * A one-pixel, transparent contenteditable that earns its keep twice. Gecko only
   * fires paste ClipboardEvents when the document has an editable region, and its
   * mere presence restores them for the video target; focusing it on the shortcut
   * then guarantees an editable paste target in every engine. Either way the text
   * arrives as event.clipboardData, which needs no clipboard-read permission and no
   * secure context - unlike navigator.clipboard.readText(), the toolbar Paste
   * button's one dependency.
   */
  private ensurePasteSink() {
    if (this.pasteSink) return this.pasteSink
    const ownerDocument = this.video.ownerDocument ?? null
    if (!ownerDocument) return null
    const sink = ownerDocument.createElement('div')
    sink.setAttribute('contenteditable', 'true')
    sink.setAttribute('aria-hidden', 'true')
    sink.tabIndex = -1
    sink.spellcheck = false
    sink.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;'
      + 'opacity:0;border:0;padding:0;margin:0;overflow:hidden;z-index:-1;outline:none'
    this.viewport.appendChild(sink)
    this.pasteSink = sink
    return sink
  }

  private focusPasteSink() {
    const sink = this.ensurePasteSink()
    if (!sink) return
    sink.textContent = ''
    sink.focus({ preventScroll: true })
    // Give focus straight back if the engine emits no ClipboardEvent, so the next
    // keystroke still reaches the page instead of the sink.
    this.clearSinkRelease()
    this.sinkReleaseTimer = window.setTimeout(() => {
      this.sinkReleaseTimer = null
      this.releasePasteSink()
      this.callbacks.onStatus?.('The paste shortcut delivered no clipboard text; use the Paste button')
    }, PASTE_EVENT_GRACE_MS)
  }

  private releasePasteSink() {
    this.clearSinkRelease()
    if (!this.pasteSink || this.video.ownerDocument?.activeElement !== this.pasteSink) return
    this.pasteSink.textContent = ''
    this.video.focus({ preventScroll: true })
  }

  private clearSinkRelease() {
    if (this.sinkReleaseTimer === null) return
    window.clearTimeout(this.sinkReleaseTimer)
    this.sinkReleaseTimer = null
  }

  /** Route local clipboard text to the page, however it was captured. */
  private deliverPaste(text: string) {
    if (!text) return
    if (new TextEncoder().encode(text).length > MAX_CLIPBOARD_BYTES) {
      this.callbacks.onStatus?.('Clipboard text is too large')
      return
    }
    if (this.callbacks.onPaste) {
      this.callbacks.onPaste(text)
    } else {
      this.pasteClipboardText(text)
    }
  }

  private copyRemoteSelection() {
    const metaKeysyms = [...this.pressedKeys.values()]
      .filter((keysym) => keysym === 65515 || keysym === 65516)
    for (const keysym of metaKeysyms) this.sendData(`ku,${keysym}`)

    const controlIsDown = [...this.pressedKeys.values()]
      .some((keysym) => keysym === 65507 || keysym === 65508)
    if (!controlIsDown) this.sendData('kd,65507')
    this.sendData('kd,99')
    this.sendData('ku,99')
    if (!controlIsDown) this.sendData('ku,65507')

    for (const keysym of metaKeysyms) this.sendData(`kd,${keysym}`)
  }

  private pointerPosition(clientX: number, clientY: number) {
    const bounds = this.video.getBoundingClientRect()
    const frameWidth = this.video.videoWidth || this.measureResolution().width
    const frameHeight = this.video.videoHeight || this.measureResolution().height
    const scale = Math.min(bounds.width / frameWidth, bounds.height / frameHeight)
    const contentWidth = frameWidth * scale
    const contentHeight = frameHeight * scale
    const offsetX = Math.max((bounds.width - contentWidth) / 2, 0)
    const offsetY = Math.max((bounds.height - contentHeight) / 2, 0)
    return {
      x: Math.max(0, Math.min(Math.round((clientX - bounds.left - offsetX) / Math.max(scale, 0.0001)), frameWidth)),
      y: Math.max(0, Math.min(Math.round((clientY - bounds.top - offsetY) / Math.max(scale, 0.0001)), frameHeight)),
    }
  }

  private measureResolution() {
    const bounds = this.viewport.getBoundingClientRect()
    const even = (value: number) => {
      const clamped = Math.max(2, Math.min(Math.round(value), MAX_REMOTE_DIMENSION))
      // Encoders require even dimensions. Round an odd viewport down so the
      // requested remote desktop never becomes wider or taller than its
      // visible Browser container.
      return clamped - clamped % 2
    }
    return {
      // Size Chrome from the visible page container, not from the remote
      // stream's intrinsic video dimensions. The stream can retain its previous
      // frame size while a panel is resizing, which would otherwise make the
      // remote page larger than the space available to display it.
      width: even(this.viewport.clientWidth || bounds.width),
      height: even(this.viewport.clientHeight || bounds.height),
      scale: 1,
    }
  }

  private sendClipboardText(text: string) {
    const encoded = encodeBase64Text(text)
    if (encoded === null) {
      this.callbacks.onStatus?.('Clipboard text is too large')
      return false
    }
    this.sendData(`cw,${encoded}`)
    return true
  }

  private pasteClipboardText(text: string) {
    if (!this.sendClipboardText(text)) return false

    // Send a complete, isolated Ctrl+V chord instead of assuming the remote
    // received the physical modifier keydown. The input data channel is
    // intentionally low-latency/unreliable, and Cmd+V otherwise leaves Meta
    // held while Ctrl+V is synthesized, which Chrome does not treat as paste.
    const modifierKeysyms = [...this.pressedKeys.values()]
      .filter((keysym) => (
        keysym === 65507
        || keysym === 65508
        || keysym === 65515
        || keysym === 65516
      ))
    for (const keysym of modifierKeysyms) this.sendData(`ku,${keysym}`)

    this.sendData('kd,65507')
    this.sendData('kd,118')
    this.sendData('ku,118')
    this.sendData('ku,65507')

    for (const keysym of modifierKeysyms) this.sendData(`kd,${keysym}`)
    return true
  }

  /**
   * Paste from an application affordance (the Browser toolbar) rather than a
   * ClipboardEvent on the focused video. Reports whether the remote actually
   * received it, because sendData silently drops messages while the input data
   * channel is closed.
   */
  paste(text: string) {
    if (this.dataChannel?.readyState !== 'open') return false
    return this.pasteClipboardText(text)
  }

  private sendData(message: string) {
    if (this.dataChannel?.readyState === 'open') this.dataChannel.send(message)
  }

  private minimizeReceiverLatency() {
    for (const receiver of this.peer?.getReceivers() ?? []) {
      const lowLatencyReceiver = receiver as RTCRtpReceiver & {
        jitterBufferTarget?: number
        jitterBufferDelayHint?: number
        playoutDelayHint?: number
      }
      lowLatencyReceiver.jitterBufferTarget = 0
      lowLatencyReceiver.jitterBufferDelayHint = 0
      lowLatencyReceiver.playoutDelayHint = 0
    }
  }

  private startIceTimeout(timeoutMs: number) {
    this.clearIceTimeout()
    this.iceTimeout = window.setTimeout(() => {
      this.iceTimeout = null
      if (this.peer?.connectionState !== 'connected') {
        this.callbacks.onStateChange?.('failed')
        this.callbacks.onError?.(this.turnRequiredMessage())
      }
    }, Math.max(1000, Math.min(timeoutMs, 60_000)))
  }

  private clearIceTimeout() {
    if (this.iceTimeout !== null) window.clearTimeout(this.iceTimeout)
    this.iceTimeout = null
  }

  private turnRequiredMessage() {
    return 'WebRTC could not connect within 10 seconds. Configure AGENT_RIDER_WEBRTC_TURN_URLS, AGENT_RIDER_WEBRTC_TURN_USERNAME, and AGENT_RIDER_WEBRTC_TURN_CREDENTIAL for this network.'
  }
}

function keysymForKeyboardEvent(event: KeyboardEvent): number | null {
  if (CODE_KEYSYMS[event.code] !== undefined) return CODE_KEYSYMS[event.code]
  if (SPECIAL_KEYSYMS[event.key] !== undefined) return SPECIAL_KEYSYMS[event.key]
  const codepoint = Array.from(event.key)[0]?.codePointAt(0)
  if (codepoint === undefined || Array.from(event.key).length !== 1) return null
  return codepoint <= 0xff ? codepoint : 0x01000000 | codepoint
}

function ensureH264KeyframeParameters(sdp: string) {
  if (!sdp.includes('packetization-mode=')) return sdp
  if (/sps-pps-idr-in-keyframe=\d+/.test(sdp)) {
    return sdp.replace(/sps-pps-idr-in-keyframe=\d+/g, 'sps-pps-idr-in-keyframe=1')
  }
  return sdp.replace(/packetization-mode=/g, 'sps-pps-idr-in-keyframe=1;packetization-mode=')
}

function encodeBase64Text(text: string) {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length > MAX_CLIPBOARD_BYTES) return null
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function decodeBase64Text(value: string) {
  if (value.length > Math.ceil(MAX_CLIPBOARD_BYTES * 4 / 3) + 4) return null
  try {
    const binary = atob(value)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}
