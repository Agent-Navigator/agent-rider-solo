import appPluginGuide from '../plugins/AGENTS.md?raw'

export type HermesConnectionState = 'disconnected' | 'connecting' | 'ready' | 'busy' | 'error'

export type HermesRpcEvent = {
  type: string
  payload?: Record<string, unknown>
  session_id?: string
}

type Listener = (event: HermesRpcEvent) => void

type StatusListener = (state: HermesConnectionState, detail: string) => void

export interface CreateSessionOptions {
  title?: string
  cwd?: string
  source?: string
}

/** An image attached to a prompt. `dataUrl` is what the card renders and what
 *  the server splits into an ACP image content block. */
export interface PromptImage {
  id: string
  name: string
  mimeType: string
  dataUrl: string
}

export interface SubmitPromptOptions {
  model?: string
  modelProvider?: string | null
  promptContext?: PromptContext
  appWorkspace?: string
  images?: PromptImage[]
}

export type PromptContext = 'agent-rider' | 'app-builder'

export class HermesActiveStreamError extends Error {
  constructor(
    message: string,
    public readonly activeStreamId: string,
  ) {
    super(message)
    this.name = 'HermesActiveStreamError'
  }
}

const DEFAULT_CWD = '/root/agent-work/DEV/agent-rider'
const AGENT_RIDER_INTERFACE_CONTEXT = [
  'You are working inside Agent Rider, a web interface with Conversation Cards, Resources, Apps, a File Browser, and embedded TUI terminals.',
  'Use the current workspace path supplied by the interface. Mention Agent Rider UI details only when relevant to the user request.',
].join('\n')
const APP_PLUGIN_GUIDE = appPluginGuide.trim()

function errMsg(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function withPromptContext(message: string, context: PromptContext = 'agent-rider', appWorkspace?: string) {
  const contextBlocks = [
    '<agent-rider-interface-context>',
    AGENT_RIDER_INTERFACE_CONTEXT,
    '</agent-rider-interface-context>',
  ]
  if (context === 'app-builder') {
    contextBlocks.push(
      '',
      '<agent-rider-app-plugin-guide>',
      APP_PLUGIN_GUIDE,
      '</agent-rider-app-plugin-guide>',
    )
    if (appWorkspace?.trim()) {
      contextBlocks.push(
        '',
        '<agent-rider-app-workspace>',
        appWorkspace.trim(),
        '</agent-rider-app-workspace>',
      )
    }
  }
  return [
    ...contextBlocks,
    '',
    '<user-message>',
    message,
    '</user-message>',
  ].join('\n')
}

export class HermesBridge {
  private listeners = new Set<Listener>()
  private statusListeners = new Set<StatusListener>()
  private activeSource: EventSource | null = null
  private streamErrorAttempts = new Map<string, number>()
  private streamReconnectTimers = new Map<string, number>()

  public sessionId: string | null = null
  public connectionState: HermesConnectionState = 'disconnected'
  public connectionDetail = 'Disconnected'
  public lastGatewaySkin: string | null = null
  public sessionInfo: Record<string, unknown> | null = null
  public activeStreamId: string | null = null

  constructor(private readonly defaults: CreateSessionOptions = {}) {}

  onEvent(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStatus(listener: StatusListener) {
    this.statusListeners.add(listener)
    listener(this.connectionState, this.connectionDetail)
    return () => this.statusListeners.delete(listener)
  }

  close() {
    this.activeSource?.close()
    this.activeSource = null
    this.activeStreamId = null
    this.clearAllStreamRecovery()
    this.setStatus('disconnected', 'Disconnected')
  }

  async connect() {
    if (this.connectionState === 'ready' || this.connectionState === 'busy') return
    this.setStatus('connecting', 'Connecting to Hermes…')
    try {
      const res = await fetch('/api/sessions?limit=1')
      if (!res.ok) throw new Error(`Hermes returned ${res.status}`)
      this.setStatus('ready', 'Hermes ready')
      this.emit({ type: 'gateway.ready', payload: { skin: 'webui' } })
    } catch (error) {
      this.setStatus('error', errMsg(error))
      throw error
    }
  }

  /** Create a fresh Hermes session rooted at `workspace`; returns its session_id. */
  async createSession(workspace: string) {
    const cwd = (workspace || '').trim() || this.defaults.cwd || DEFAULT_CWD
    const res = await fetch('/api/session/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: cwd }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`session/new failed (${res.status})${text ? ': ' + text : ''}`)
    }

    const data = (await res.json()) as { session?: { session_id?: string } }
    const sessionId = String(data.session?.session_id ?? '').trim()
    if (!sessionId) throw new Error('session/new did not return a session_id')

    this.sessionId = sessionId
    this.sessionInfo = (data.session as Record<string, unknown>) ?? null
    this.emit({ type: 'session.info', session_id: sessionId, payload: { session_id: sessionId } })
    return sessionId
  }

  async setReasoningEffort(effort: string, options: SubmitPromptOptions = {}) {
    const cleanEffort = effort.trim()
    if (!cleanEffort) return

    const body: Record<string, unknown> = { effort: cleanEffort }
    if (options.model?.trim()) body.model = options.model.trim()
    if (options.modelProvider?.trim()) body.provider = options.modelProvider.trim()

    const res = await fetch('/api/reasoning', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`reasoning update failed (${res.status})${text ? ': ' + text : ''}`)
    }
  }

  /** Submit a prompt to a specific session and stream the response. */
  async submitPrompt(sessionId: string, text: string, workspace?: string, options: SubmitPromptOptions = {}) {
    this.setStatus('busy', 'Hermes is running…')

    const cwd = (workspace || '').trim() || this.defaults.cwd || DEFAULT_CWD
    const cleanModel = options.model?.trim()
    const cleanProvider = options.modelProvider?.trim()
    const body: Record<string, unknown> = {
      session_id: sessionId,
      message: withPromptContext(text, options.promptContext ?? 'agent-rider', options.appWorkspace),
      workspace: cwd,
    }
    if (cleanModel) {
      body.model = cleanModel
      body.explicit_model_pick = true
    }
    if (cleanProvider) body.model_provider = cleanProvider
    if (options.images?.length) {
      body.images = options.images.map((image) => ({ mimeType: image.mimeType, data: image.dataUrl }))
    }

    const res = await fetch('/api/chat/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      if (res.status === 409 && body) {
        try {
          const payload = JSON.parse(body) as { active_stream_id?: unknown; error?: unknown }
          const activeStreamId = String(payload.active_stream_id ?? '').trim()
          if (activeStreamId) {
            throw new HermesActiveStreamError(
              String(payload.error ?? 'session already has an active stream'),
              activeStreamId,
            )
          }
        } catch (error) {
          if (error instanceof HermesActiveStreamError) throw error
        }
      }
      throw new Error(`chat/start failed (${res.status})${body ? ': ' + body : ''}`)
    }

    const data = (await res.json()) as { stream_id?: string }
    const streamId = String(data.stream_id ?? '').trim()
    if (!streamId) throw new Error('chat/start did not return a stream_id')

    this.openStream(streamId)
    return streamId
  }

  /** Ask Hermes to stop the currently active streamed turn. */
  async cancelActiveStream() {
    const streamId = this.activeStreamId
    if (!streamId) return false

    this.setStatus('busy', 'Stopping Hermes…')
    const res = await fetch(`/api/chat/cancel?stream_id=${encodeURIComponent(streamId)}`, {
      credentials: 'include',
    })
    const body = await res.text().catch(() => '')
    let data: { cancelled?: boolean; detail?: unknown; error?: unknown } = {}
    if (body) {
      try {
        data = JSON.parse(body) as typeof data
      } catch {
        // Keep the raw body for the error message below.
      }
    }

    if (!res.ok) {
      const message = String(data.detail ?? data.error ?? (body || res.statusText))
      throw new Error(`chat/cancel failed (${res.status})${message ? ': ' + message : ''}`)
    }

    if (data.cancelled === false) {
      this.activeSource?.close()
      this.activeSource = null
      this.activeStreamId = null
      this.setStatus('ready', 'Hermes ready')
    }

    return data.cancelled !== false
  }

  /** Re-open an existing stream without submitting a second prompt. */
  reconnectStream(streamId = this.activeStreamId) {
    const cleanStreamId = String(streamId ?? '').trim()
    if (!cleanStreamId) return false
    this.setStatus('busy', 'Reconnecting to Hermes stream...')
    this.openStream(cleanStreamId)
    return true
  }

  private openStream(streamId: string) {
    this.activeSource?.close()
    const source = new EventSource(`/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`)
    this.activeSource = source
    this.activeStreamId = streamId

    let connectionTimeout: number | undefined
    let statusPollInterval: number | undefined

    const closeSource = () => {
      if (connectionTimeout !== undefined) window.clearTimeout(connectionTimeout)
      if (statusPollInterval !== undefined) window.clearInterval(statusPollInterval)
      source.close()
      if (this.activeSource === source) {
        this.activeSource = null
        this.activeStreamId = null
      }
    }

    const finishStream = (state: HermesConnectionState, detail: string, event: HermesRpcEvent) => {
      if (connectionTimeout !== undefined) window.clearTimeout(connectionTimeout)
      if (statusPollInterval !== undefined) window.clearInterval(statusPollInterval)
      this.clearStreamRecovery(streamId)
      closeSource()
      this.setStatus(state, detail)
      this.emit(event)
    }

    // Watchdog for connection hang (Vite proxy / backend waiting for headers)
    connectionTimeout = window.setTimeout(() => {
      if (source.readyState === EventSource.CONNECTING) {
        console.warn('EventSource connection timeout - still CONNECTING after 8s. Forcing recovery.');
        if (this.activeSource === source) {
          this.recoverClosedStream(source, streamId, closeSource)
        }
      }
    }, 8000)

    // Watchdog for silent drops or completed stream without terminal event
    statusPollInterval = window.setInterval(async () => {
      if (this.activeSource !== source) return
      try {
        const controller = new AbortController()
        const abortTimeout = window.setTimeout(() => controller.abort(), 4000)
        const res = await fetch(`/api/chat/stream/status?stream_id=${encodeURIComponent(streamId)}`, {
          cache: 'no-store',
          credentials: 'include',
          signal: controller.signal,
        })
        window.clearTimeout(abortTimeout)
        if (!res.ok) return
        const data = (await res.json()) as { active?: boolean; replay_available?: boolean }
        if (this.activeSource !== source) return

        if (!data.active) {
          if (data.replay_available) {
            // Server finished but a replay buffer is still around — reconnect and
            // replay so we get the real terminal event (and its final text).
            console.warn('Status poll detected inactive stream with replay available. Reconnecting to replay.');
            this.recoverClosedStream(source, streamId, closeSource)
          } else {
            // Server authoritatively says the stream is done and there is nothing
            // left to replay. Retrying can't recover anything, and it strands the
            // card on a spinning "working…" the whole time. Finish gracefully:
            // App.tsx keeps any tokens already streamed as a completed turn, and
            // only falls back to an error when nothing streamed at all.
            console.warn('Status poll detected finished stream with no replay. Finishing gracefully.');
            this.finishInactiveStream(streamId, closeSource)
          }
        }
      } catch {
        // Ignore polling errors to avoid false alarms during transient network issues
      }
    }, 5000)

    source.addEventListener('open', () => {
      if (connectionTimeout !== undefined) window.clearTimeout(connectionTimeout)
    })

    source.addEventListener('token', (raw) => {
      // Live data means the transport recovered on its own — abandon any pending
      // recovery timer so we don't needlessly close and reopen a healthy stream.
      this.clearStreamRecovery(streamId)
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as { text?: string }
        this.emit({ type: 'message.delta', payload: { text: String(payload.text ?? '') } })
      } catch {
        // ignore malformed token
      }
    })

    // Reasoning, tool calls and plan updates: same liveness contract as `token`
    // (arriving data means the transport is healthy), but they feed the turn's
    // activity timeline rather than its answer text.
    const forwardActivity = (sseEvent: string, type: string) => {
      source.addEventListener(sseEvent, (raw) => {
        this.clearStreamRecovery(streamId)
        try {
          const payload = JSON.parse((raw as MessageEvent).data) as Record<string, unknown>
          this.emit({ type, payload })
        } catch {
          // ignore malformed activity frame
        }
      })
    }
    forwardActivity('thought', 'message.thought')
    forwardActivity('tool', 'message.tool')
    forwardActivity('plan', 'message.plan')

    const finish = () => {
      finishStream('ready', 'Assistant response complete', { type: 'message.complete' })
    }

    source.addEventListener('stream_end', finish)
    source.addEventListener('done', finish)
    // Hermes emits a distinct "apperror" event (rate limits, silent provider
    // failures, crashes, ...) for application-level failures. Per the Hermes
    // WebUI reference client, the server does NOT follow this with its own
    // stream_end/done — it expects the client to close the stream itself.
    // Without a listener here the EventSource just idles on heartbeats
    // forever, leaving the card stuck on "Hermes running…" with a dead
    // thread. Always finish the stream; App.tsx decides whether any tokens
    // already streamed are enough to treat the turn as complete anyway.
    source.addEventListener('apperror', (raw) => {
      let payload: Record<string, unknown> = {}
      try {
        payload = JSON.parse((raw as MessageEvent).data) as Record<string, unknown>
      } catch {
        // Fall through with an empty payload; the stream still needs to close.
      }
      const message = String(payload.message ?? 'Hermes reported an application error')
      finishStream('error', message, {
        type: 'message.apperror',
        payload: { error: message, hint: payload.hint, details: payload.details },
      })
    })
    source.addEventListener('cancel', (raw) => {
      let payload: Record<string, unknown> = { message: 'Task stopped.' }
      try {
        const parsed = JSON.parse((raw as MessageEvent).data) as unknown
        if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
      } catch {
        // keep the default payload
      }
      finishStream('ready', 'Hermes stopped', { type: 'message.cancelled', payload })
    })

    source.addEventListener('error', (raw) => {
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as { error?: string }
        const msg = String(payload.error ?? 'Hermes stream error')
        finishStream('error', msg, { type: 'message.error', payload: { error: msg } })
      } catch {
        // A transport-level "error" with no payload means the SSE dropped before an
        // explicit stream_end/done/error event. The browser may be auto-reconnecting
        // (CONNECTING) or have given up (CLOSED); in BOTH cases the stream is
        // interrupted, so we must drive our own deterministic recovery — probe Hermes
        // and replay/finish. Leaving the CONNECTING case unhandled is what strands a
        // turn at "Thinking…" (and its follow-ups at "Queued") forever. Only an OPEN
        // transport (e.g. a stray heartbeat parse error) is safe to ignore.
        if (source.readyState !== EventSource.OPEN) {
          this.recoverClosedStream(source, streamId, closeSource)
        }
      }
    })
  }

  private recoverClosedStream(source: EventSource, streamId: string, closeSource: () => void) {
    if (this.activeSource !== source) return

    const attempt = (this.streamErrorAttempts.get(streamId) ?? 0) + 1
    this.streamErrorAttempts.set(streamId, attempt)
    this.setStatus('busy', attempt === 1 ? 'Reconnecting to Hermes stream...' : 'Checking Hermes stream...')

    const existingTimer = this.streamReconnectTimers.get(streamId)
    if (existingTimer) window.clearTimeout(existingTimer)

    const timer = window.setTimeout(async () => {
      this.streamReconnectTimers.delete(streamId)
      if (this.activeSource !== source) return

      const recoverable = await this.isStreamRecoverable(streamId).catch(() => attempt < 3)
      if (this.activeSource !== source) return

      if (recoverable && attempt < 5) {
        this.reconnectStream(streamId)
        return
      }

      if (attempt < 3) {
        this.recoverClosedStream(source, streamId, closeSource)
        return
      }

      // Reconnect attempts are exhausted. Rather than clobbering a possibly-good
      // reply with a hard error, finish gracefully: App.tsx keeps whatever tokens
      // already streamed as a completed turn and only errors when nothing did.
      this.finishInactiveStream(streamId, closeSource, 'Hermes stream disconnected')
    }, Math.min(750 * attempt, 2500))

    this.streamReconnectTimers.set(streamId, timer)
  }

  // Terminate a stream the server has confirmed is no longer active (or that we've
  // given up reconnecting to) without a terminal SSE event. Emitted as apperror so
  // App.tsx treats already-streamed content as done and only errors when empty.
  private finishInactiveStream(streamId: string, closeSource: () => void, message = 'Hermes stream ended') {
    this.clearStreamRecovery(streamId)
    closeSource()
    this.setStatus('ready', 'Assistant response complete')
    this.emit({ type: 'message.apperror', payload: { error: message } })
  }

  private async isStreamRecoverable(streamId: string) {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 4000)
    try {
      const res = await fetch(`/api/chat/stream/status?stream_id=${encodeURIComponent(streamId)}`, {
        cache: 'no-store',
        credentials: 'include',
        signal: controller.signal,
      })
      window.clearTimeout(timeoutId)
      if (!res.ok) return false
      const data = (await res.json()) as { active?: unknown; replay_available?: unknown }
      return Boolean(data.active || data.replay_available)
    } catch (error) {
      window.clearTimeout(timeoutId)
      throw error
    }
  }

  private clearStreamRecovery(streamId: string) {
    const timer = this.streamReconnectTimers.get(streamId)
    if (timer) window.clearTimeout(timer)
    this.streamReconnectTimers.delete(streamId)
    this.streamErrorAttempts.delete(streamId)
  }

  private clearAllStreamRecovery() {
    for (const timer of this.streamReconnectTimers.values()) window.clearTimeout(timer)
    this.streamReconnectTimers.clear()
    this.streamErrorAttempts.clear()
  }

  private emit(event: HermesRpcEvent) {
    for (const listener of this.listeners) listener(event)
  }

  private setStatus(state: HermesConnectionState, detail: string) {
    this.connectionState = state
    this.connectionDetail = detail
    for (const listener of this.statusListeners) listener(state, detail)
  }
}
