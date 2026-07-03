import agentRiderBackground from '../agent-rider-background.md?raw'

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

export interface SubmitPromptOptions {
  model?: string
  modelProvider?: string | null
}

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
const AGENT_RIDER_BACKGROUND = agentRiderBackground.trim()

function errMsg(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function withAgentRiderBackground(message: string) {
  return [
    '<agent-rider-background>',
    AGENT_RIDER_BACKGROUND,
    '</agent-rider-background>',
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
      message: withAgentRiderBackground(text),
      workspace: cwd,
    }
    if (cleanModel) {
      body.model = cleanModel
      body.explicit_model_pick = true
    }
    if (cleanProvider) body.model_provider = cleanProvider

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

    const closeSource = () => {
      source.close()
      if (this.activeSource === source) {
        this.activeSource = null
        this.activeStreamId = null
      }
    }

    const finishStream = (state: HermesConnectionState, detail: string, event: HermesRpcEvent) => {
      this.clearStreamRecovery(streamId)
      closeSource()
      this.setStatus(state, detail)
      this.emit(event)
    }

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

      if (recoverable) {
        this.reconnectStream(streamId)
        return
      }

      if (attempt < 3) {
        this.recoverClosedStream(source, streamId, closeSource)
        return
      }

      this.clearStreamRecovery(streamId)
      closeSource()
      this.setStatus('error', 'Hermes stream disconnected')
      this.emit({ type: 'message.error', payload: { error: 'Hermes stream disconnected' } })
    }, Math.min(750 * attempt, 2500))

    this.streamReconnectTimers.set(streamId, timer)
  }

  private async isStreamRecoverable(streamId: string) {
    const res = await fetch(`/api/chat/stream/status?stream_id=${encodeURIComponent(streamId)}`, {
      cache: 'no-store',
      credentials: 'include',
    })
    if (!res.ok) return false
    const data = (await res.json()) as { active?: unknown; replay_available?: unknown }
    return Boolean(data.active || data.replay_available)
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
