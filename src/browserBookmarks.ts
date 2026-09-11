export interface BrowserBookmark {
  id: string
  title: string
  url: string
  createdAt: string
  updatedAt: string
}

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

export function normalizeBrowserBookmarkUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'about:blank') return null
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const parsed = new URL(candidate)
    if (!HTTP_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) return null
    return parsed.href
  } catch {
    return null
  }
}

export function browserBookmarkTitle(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

export function normalizeBrowserBookmarks(value: unknown): BrowserBookmark[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  const urls = new Set<string>()
  const bookmarks: BrowserBookmark[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as Partial<BrowserBookmark>
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
    const url = typeof candidate.url === 'string' ? normalizeBrowserBookmarkUrl(candidate.url) : null
    if (!id || !title || !url || ids.has(id) || urls.has(url)) continue
    ids.add(id)
    urls.add(url)
    bookmarks.push({
      id,
      title,
      url,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
    })
  }
  return bookmarks
}

export function browserBookmarkMatches(bookmark: BrowserBookmark, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return `${bookmark.title}\n${bookmark.url}`.toLocaleLowerCase().includes(needle)
}

export function browserBookmarkForUrl(
  bookmarks: BrowserBookmark[],
  url: string,
): BrowserBookmark | null {
  const normalized = normalizeBrowserBookmarkUrl(url)
  return normalized ? bookmarks.find((bookmark) => bookmark.url === normalized) ?? null : null
}

export function upsertBrowserBookmark(
  bookmarks: BrowserBookmark[],
  bookmark: BrowserBookmark,
): BrowserBookmark[] {
  const existingIndex = bookmarks.findIndex((candidate) => candidate.id === bookmark.id)
  if (existingIndex < 0) return [bookmark, ...bookmarks]
  return bookmarks.map((candidate) => candidate.id === bookmark.id ? bookmark : candidate)
}
