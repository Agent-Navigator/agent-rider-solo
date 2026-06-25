// Client for the local SQLite persistence backend (server/store.mjs), proxied at /store.
// All calls fail soft: if the backend is unavailable the app still works in-memory.

export interface PersistedState {
  runs: unknown[]
  turns: unknown[]
}

export async function loadPersistedState(): Promise<PersistedState | null> {
  try {
    const res = await fetch('/store/state')
    if (!res.ok) return null
    const data = (await res.json()) as Partial<PersistedState>
    return {
      runs: Array.isArray(data.runs) ? data.runs : [],
      turns: Array.isArray(data.turns) ? data.turns : [],
    }
  } catch {
    return null
  }
}

export async function persistState(runs: unknown[], turns: unknown[], sessionId: string | null): Promise<void> {
  try {
    await fetch('/store/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runs, turns, sessionId }),
    })
  } catch {
    // ignore — persistence is best-effort
  }
}
