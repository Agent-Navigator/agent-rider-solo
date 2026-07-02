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

    source.addEventListener('token', (raw) => {
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as { text?: string }
        this.emit({ type: 'message.delta', payload: { text: String(payload.text ?? '') } })
      } catch {
        // ignore malformed token
      }
    })

    const finish = () => {
      closeSource()
      this.setStatus('ready', 'Assistant response complete')
      this.emit({ type: 'message.complete' })
    }

    source.addEventListener('stream_end', finish)
    source.addEventListener('done', finish)
    source.addEventListener('cancel', (raw) => {
      let payload: Record<string, unknown> = { message: 'Task stopped.' }
      try {
        const parsed = JSON.parse((raw as MessageEvent).data) as unknown
        if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>
      } catch {
        // keep the default payload
      }
      closeSource()
      this.setStatus('ready', 'Hermes stopped')
      this.emit({ type: 'message.cancelled', payload })
    })

    source.addEventListener('error', (raw) => {
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as { error?: string }
        const msg = String(payload.error ?? 'Hermes stream error')
        closeSource()
        this.setStatus('error', msg)
        this.emit({ type: 'message.error', payload: { error: msg } })
      } catch {
        // onerror fires for network/connection errors too — only act on closed state
        if (source.readyState === EventSource.CLOSED) {
          if (this.activeSource === source) {
            this.activeSource = null
            this.activeStreamId = null
          }
          this.setStatus('error', 'Hermes stream disconnected')
          this.emit({ type: 'message.error', payload: { error: 'Hermes stream disconnected' } })
        }
      }
    })
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
