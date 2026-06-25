export interface DashboardSession {
  session_id: string
  title?: string | null
  workspace?: string | null
  model?: string | null
  model_provider?: string | null
  message_count?: number | null
  created_at?: number | null
  updated_at?: number | null
  last_message_at?: number | null
  profile?: string | null
  source_label?: string | null
  source_tag?: string | null
  session_source?: string | null
  is_streaming?: boolean | null
  has_pending_user_message?: boolean | null
}

export interface DashboardSessionsResponse {
  sessions: DashboardSession[]
}

const API_BASE = '/api'

class HermesApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HermesApiError'
    this.status = status
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })

  const text = await response.text()
  const payload = text ? (JSON.parse(text) as T) : (undefined as T)

  if (!response.ok) {
    const message = typeof payload === 'object' && payload && 'detail' in payload
      ? String((payload as { detail?: unknown }).detail ?? response.statusText)
      : response.statusText
    throw new HermesApiError(response.status, message)
  }

  return payload
}

export async function getDashboardSessions(limit = 4): Promise<DashboardSession[]> {
  const data = await requestJson<DashboardSessionsResponse>(`/sessions?limit=${limit}`)
  return Array.isArray(data.sessions) ? data.sessions : []
}

export function formatTimestamp(value?: number | null) {
  if (!value) return '—'
  const ms = value > 1_000_000_000_000 ? value : value * 1000
  return new Date(ms).toLocaleString()
}

export function describeSession(session: DashboardSession) {
  const source = session.source_label || session.session_source || session.source_tag || 'Hermes'
  const profile = session.profile ? ` · ${session.profile}` : ''
  const messages = typeof session.message_count === 'number' ? ` · ${session.message_count} msgs` : ''
  return `${source}${profile}${messages}`
}

export { HermesApiError }
