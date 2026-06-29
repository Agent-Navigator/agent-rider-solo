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

  /** Submit a prompt to a specific session and stream the response. */
  async submitPrompt(sessionId: string, text: string, workspace?: string) {
    this.setStatus('busy', 'Hermes is running…')

    const cwd = (workspace || '').trim() || this.defaults.cwd || DEFAULT_CWD
    const res = await fetch('/api/chat/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, message: withAgentRiderBackground(text), workspace: cwd }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`chat/start failed (${res.status})${body ? ': ' + body : ''}`)
    }

    const data = (await res.json()) as { stream_id?: string }
    const streamId = String(data.stream_id ?? '').trim()
    if (!streamId) throw new Error('chat/start did not return a stream_id')

    this.openStream(streamId)
  }

  private openStream(streamId: string) {
    const source = new EventSource(`/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`)
    this.activeSource = source

    source.addEventListener('token', (raw) => {
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as { text?: string }
        this.emit({ type: 'message.delta', payload: { text: String(payload.text ?? '') } })
      } catch {
        // ignore malformed token
      }
    })

    const finish = () => {
      source.close()
      if (this.activeSource === source) this.activeSource = null
      this.emit({ type: 'message.complete' })
    }

    source.addEventListener('stream_end', finish)
    source.addEventListener('done', finish)
    source.addEventListener('cancel', finish)

    source.addEventListener('error', (raw) => {
      try {
        const payload = JSON.parse((raw as MessageEvent).data) as { error?: string }
        const msg = String(payload.error ?? 'Hermes stream error')
        source.close()
        if (this.activeSource === source) this.activeSource = null
        this.setStatus('error', msg)
        this.emit({ type: 'message.error', payload: { error: msg } })
      } catch {
        // onerror fires for network/connection errors too — only act on closed state
        if (source.readyState === EventSource.CLOSED) {
          if (this.activeSource === source) this.activeSource = null
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
