import externalSiteDictionary from '../config/browser-external-sites.json'

export type BrowserModePreference = 'auto' | 'embedded' | 'external'
export type BrowserResolvedMode = Exclude<BrowserModePreference, 'auto'>

export interface ExternalSiteRule {
  id: string
  label: string
  reason: string
  hosts?: string[]
  domains?: string[]
}

export interface ExternalSiteDictionary {
  version: number
  description: string
  rules: ExternalSiteRule[]
}

export interface BrowserModeResolution {
  mode: BrowserResolvedMode
  url: string
  hostname: string
  rule: ExternalSiteRule | null
  local: boolean
}

function normalizeBrowserUrl(input: string): URL | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function isIpv4InRange(hostname: string, prefix: number[]): boolean {
  const parts = hostname.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  return prefix.every((part, index) => parts[index] === part)
}

export function isLocalBrowserHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    normalized === 'localhost'
    || normalized === '0.0.0.0'
    || normalized === '::1'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
  ) {
    return true
  }
  if (isIpv4InRange(normalized, [127]) || isIpv4InRange(normalized, [10])) return true
  if (isIpv4InRange(normalized, [192, 168])) return true
  const parts = normalized.split('.').map(Number)
  return parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalizedDomain = domain.toLowerCase().replace(/^\.+|\.+$/g, '')
  return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`)
}

export function matchExternalSite(
  input: string,
  dictionary: ExternalSiteDictionary = externalSiteDictionary,
): BrowserModeResolution {
  const parsed = normalizeBrowserUrl(input)
  if (!parsed) {
    return { mode: 'embedded', url: input.trim(), hostname: '', rule: null, local: false }
  }
  const hostname = parsed.hostname.toLowerCase()
  const local = isLocalBrowserHostname(hostname)
  const rule = local
    ? null
    : dictionary.rules.find((candidate) => (
      candidate.hosts?.some((host) => hostname === host.toLowerCase())
      || candidate.domains?.some((domain) => domainMatches(hostname, domain))
    )) ?? null
  return {
    mode: rule ? 'external' : 'embedded',
    url: parsed.toString(),
    hostname,
    rule,
    local,
  }
}

export function resolveBrowserMode(
  preference: BrowserModePreference,
  input: string,
  dictionary: ExternalSiteDictionary = externalSiteDictionary,
): BrowserModeResolution {
  const resolution = matchExternalSite(input, dictionary)
  return preference === 'auto' ? resolution : { ...resolution, mode: preference }
}

export { externalSiteDictionary }
