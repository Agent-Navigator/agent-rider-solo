import type { ProviderUsage } from './store'

type UsageVisibilityState = Pick<ProviderUsage, 'provider' | 'status' | 'stale'>

export function usageProviderVisible(provider: UsageVisibilityState) {
  if (provider.status === 'error' && !provider.stale) return false

  return provider.provider === 'claude'
    || provider.provider === 'codex'
    || provider.status === 'ok'
    || provider.stale
}
