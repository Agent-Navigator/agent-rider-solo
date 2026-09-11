export type ExternalBrowserDisplayPriority = 'setup' | 'session'

type OwnershipListener = (owned: boolean) => void

interface DisplayClaim {
  listener: OwnershipListener
  order: number
  priority: number
  token: symbol
}

function priorityValue(priority: ExternalBrowserDisplayPriority) {
  return priority === 'session' ? 2 : 1
}

/**
 * Selkies exposes one video peer (UID 1) for the shared External Chrome
 * display. Coordinate mounted Browser panels so only one of them connects to
 * that peer at a time. A real OpenCLI page session outranks a setup-only panel;
 * users can click an equal-priority panel to move the display there.
 */
export class ExternalBrowserDisplayCoordinator {
  private claims = new Map<string, DisplayClaim>()
  private ownerWindowId: string | null = null
  private sequence = 0

  register(
    windowId: string,
    priority: ExternalBrowserDisplayPriority,
    listener: OwnershipListener,
  ) {
    const token = Symbol(windowId)
    this.claims.set(windowId, {
      listener,
      order: ++this.sequence,
      priority: priorityValue(priority),
      token,
    })
    this.rebalance()

    return () => {
      if (this.claims.get(windowId)?.token !== token) return
      this.claims.delete(windowId)
      this.rebalance()
    }
  }

  activate(windowId: string) {
    const claim = this.claims.get(windowId)
    if (!claim) return
    claim.order = ++this.sequence
    this.rebalance()
  }

  owner() {
    return this.ownerWindowId
  }

  private rebalance() {
    let nextOwner: string | null = null
    let nextClaim: DisplayClaim | null = null
    for (const [windowId, claim] of this.claims) {
      if (
        nextClaim === null
        || claim.priority > nextClaim.priority
        || (claim.priority === nextClaim.priority && claim.order > nextClaim.order)
      ) {
        nextOwner = windowId
        nextClaim = claim
      }
    }
    this.ownerWindowId = nextOwner
    for (const [windowId, claim] of this.claims) {
      claim.listener(windowId === this.ownerWindowId)
    }
  }
}

export function externalBrowserControlReady(
  opencliSession: string | null | undefined,
  setupActive: boolean,
) {
  return Boolean(opencliSession) && !setupActive
}

export function browserReloadAvailable(
  mode: 'embedded' | 'external',
  displayReady: boolean,
  opencliSession: string | null | undefined,
  setupActive: boolean,
) {
  return mode === 'external'
    ? externalBrowserControlReady(opencliSession, setupActive)
    : displayReady
}

export const externalBrowserDisplayCoordinator = new ExternalBrowserDisplayCoordinator()
