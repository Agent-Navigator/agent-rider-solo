export interface WorkspaceStateSnapshot<Layout = unknown> {
  runs: unknown[]
  turns: unknown[]
  sessionId: string | null
  layout?: Layout
  deletedRunIds?: string[]
  deletedTurnIds?: string[]
}

export type WorkspacePersistResult =
  | { status: 'saved'; revision: number }
  | { status: 'retry' }
  | { status: 'conflict'; revision: number }

export type WorkspaceSaveStatus = 'idle' | 'saving' | 'saved' | 'retrying' | 'conflict' | 'paused'

type SaveWorkspaceState<Layout> = (
  snapshot: WorkspaceStateSnapshot<Layout>,
  revision: number,
) => Promise<WorkspacePersistResult>
type TimerHandle = ReturnType<typeof setTimeout>

interface StateSaveQueueOptions {
  debounceMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  onSaved?: (snapshot: WorkspaceStateSnapshot<unknown>, revision: number) => void
  onStatusChange?: (status: WorkspaceSaveStatus) => void
}

/**
 * Serializes full-workspace saves and retains the newest unsaved snapshot while
 * Agent Rider's application service is temporarily unavailable during an
 * upgrade. A failed request is retried with bounded backoff; newer snapshots
 * replace older pending ones instead of creating an out-of-order write race.
 */
export class StateSaveQueue<Layout = unknown> {
  private pending: WorkspaceStateSnapshot<Layout> | null = null
  private inFlight = false
  private activeFlush: Promise<void> | null = null
  private paused = false
  private conflicted = false
  private timer: TimerHandle | null = null
  private retryFailures = 0
  private revision = 0
  private readonly debounceMs: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number

  constructor(
    private readonly save: SaveWorkspaceState<Layout>,
    private readonly options: StateSaveQueueOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 0
    this.retryBaseMs = options.retryBaseMs ?? 1_000
    this.retryMaxMs = options.retryMaxMs ?? 30_000
  }

  initialize(revision: number) {
    this.revision = Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
    this.paused = false
    this.conflicted = false
    this.retryFailures = 0
    this.emitStatus('idle')
  }

  currentRevision() {
    return this.revision
  }

  enqueue(snapshot: WorkspaceStateSnapshot<Layout>) {
    if (this.paused) return
    this.pending = snapshot
    this.retryFailures = 0
    this.emitStatus('saving')
    this.schedule(this.debounceMs)
  }

  /** Pause new writes without discarding the newest unsaved snapshot. */
  pause() {
    this.paused = true
    this.clearTimer()
    this.emitStatus('paused')
  }

  /** Resume normal writes when an updater abandons its prepare request. */
  resume(): boolean {
    if (this.conflicted) return false
    this.paused = false
    this.emitStatus(this.pending ? 'saving' : 'idle')
    if (this.pending) this.schedule(0)
    return true
  }

  async flushNow(): Promise<boolean> {
    if (this.paused) return !this.pending && !this.inFlight && !this.conflicted
    this.clearTimer()
    await this.flush()
    return !this.pending && !this.inFlight && !this.conflicted
  }

  /**
   * Wait until the newest snapshot has a durable backend revision, then reject
   * further writes. Application upgrades must not navigate until this returns
   * true.
   */
  async drainAndPause(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    this.clearTimer()
    while (Date.now() <= deadline) {
      if (this.conflicted) return false
      if (this.activeFlush) await this.activeFlush
      if (this.pending) {
        await this.flush()
        if (this.pending && !this.conflicted) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(this.retryBaseMs, 250)))
        }
        continue
      }
      if (!this.inFlight) {
        this.paused = true
        this.emitStatus('paused')
        return true
      }
    }
    this.emitStatus('retrying')
    return false
  }

  private schedule(delayMs: number) {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delayMs)
  }

  private clearTimer() {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private async flush() {
    if (this.paused || this.conflicted || !this.pending) return
    if (this.activeFlush) return this.activeFlush
    const run = this.performFlush()
    this.activeFlush = run
    try {
      await run
    } finally {
      if (this.activeFlush === run) this.activeFlush = null
    }
  }

  private async performFlush() {
    const snapshot = this.pending
    if (!snapshot) return
    this.pending = null
    this.inFlight = true
    this.emitStatus('saving')
    let result: WorkspacePersistResult = { status: 'retry' }
    try {
      result = await this.save(snapshot, this.revision)
    } catch {
      result = { status: 'retry' }
    } finally {
      this.inFlight = false
    }

    if (this.paused) return

    if (result.status === 'saved') {
      this.revision = result.revision
      this.retryFailures = 0
      this.options.onSaved?.(snapshot, result.revision)
      this.emitStatus(this.pending ? 'saving' : 'saved')
      if (this.pending) this.schedule(0)
      return
    }

    if (result.status === 'conflict') {
      this.revision = result.revision
      if (!this.pending) this.pending = snapshot
      this.conflicted = true
      this.paused = true
      this.clearTimer()
      this.emitStatus('conflict')
      return
    }

    // Do not replace a newer snapshot that arrived while this request was in
    // flight. Retrying the newer full snapshot also persists everything in the
    // failed one.
    if (!this.pending) this.pending = snapshot
    const retryDelay = Math.min(
      this.retryBaseMs * (2 ** this.retryFailures),
      this.retryMaxMs,
    )
    this.retryFailures += 1
    this.emitStatus('retrying')
    this.schedule(retryDelay)
  }

  private emitStatus(status: WorkspaceSaveStatus) {
    this.options.onStatusChange?.(status)
  }
}
