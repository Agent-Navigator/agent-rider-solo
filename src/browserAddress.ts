export const DEFAULT_BROWSER_ADDRESS = 'http://127.0.0.1:3000'
export const BLANK_BROWSER_ADDRESS = 'about:blank'

export interface BrowserAddressState {
  address: string
  displayAddress: string
  draft: boolean
}

export function initialBrowserAddressState(
  persistedAddress?: string,
  persistedDisplayAddress?: string,
): BrowserAddressState {
  const displayAddress = persistedDisplayAddress ?? BLANK_BROWSER_ADDRESS
  const address = persistedAddress
    ?? (displayAddress === BLANK_BROWSER_ADDRESS ? DEFAULT_BROWSER_ADDRESS : displayAddress)
  return {
    address,
    displayAddress,
    draft: persistedAddress !== undefined && address !== displayAddress,
  }
}

export function editBrowserAddress(
  current: BrowserAddressState,
  address: string,
): BrowserAddressState {
  return { ...current, address, draft: address !== current.displayAddress }
}

export function observeBrowserAddress(
  current: BrowserAddressState,
  displayAddress: string,
): BrowserAddressState {
  const address = current.draft ? current.address : displayAddress
  return { address, displayAddress, draft: address !== displayAddress }
}

export function commitBrowserAddress(displayAddress: string): BrowserAddressState {
  return { address: displayAddress, displayAddress, draft: false }
}
