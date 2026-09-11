export interface TerminalLinkCell {
  chars: string
  width: number
}

export interface TerminalLinkRow {
  cells: TerminalLinkCell[]
  /** xterm marks physical rows that continue the preceding row as wrapped. */
  isWrapped?: boolean
}

export interface TerminalFileLinkRange {
  label: string
  path: string
  start: { x: number; y: number }
  end: { x: number; y: number }
}

export interface LocalFileReference {
  label: string
  path: string
  start: number
  end: number
}

const PREVIEWABLE_FILE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'html', 'htm', 'md', 'mdx', 'markdown', 'csv',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'css', 'scss', 'sass', 'less',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'cs', 'php',
  'r', 'sh', 'bash', 'zsh', 'fish', 'sql', 'vue', 'svelte', 'astro',
  'txt', 'text', 'log', 'tsv', 'ini', 'conf', 'config', 'env', 'example',
])
const PREVIEWABLE_EXTENSIONLESS_NAMES = new Set(['dockerfile', 'makefile', 'readme', 'license'])
const FILE_LOCATION_SUFFIX = /(?:#L\d+(?:-L\d+)?|:\d+(?::\d+)?)$/i
const REMOTE_FILE_PREFIX = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:\/(?!\/)/
// Full-width CJK punctuation is prose punctuation, not a path character.
// Splitting on it lets `已儲存：fix_staging_prompt.md:1` expose the actual
// previewable filename instead of treating the whole sentence as one path.
const FILE_TOKEN = /[^\s<>"'`，。；：！？、（）【】「」『』]+/gu

function normalizedLocalPath(value: string) {
  const absolute = value.startsWith('/')
  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return `${absolute ? '/' : ''}${segments.join('/')}` || (absolute ? '/' : '.')
}

function previewableFileReference(value: string) {
  if (!value || value.includes('://') || value.startsWith('www.')) return false
  const path = value.replace(FILE_LOCATION_SUFFIX, '')
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  if (!name || name === '.' || name === '..') return false
  if (PREVIEWABLE_EXTENSIONLESS_NAMES.has(name)) return true
  if (name.startsWith('.') && !name.slice(1).includes('.')) return name.length > 1
  const extension = name.includes('.') ? name.split('.').pop() ?? '' : ''
  return PREVIEWABLE_FILE_EXTENSIONS.has(extension)
}

/** Resolve a terminal-authored local file reference against its TUI workspace. */
export function localFilePreviewPath(reference: string, workspacePath: string) {
  let decoded = reference.trim()
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    return null
  }
  if (!previewableFileReference(decoded) || REMOTE_FILE_PREFIX.test(decoded)) return null
  const sourcePath = decoded.replace(FILE_LOCATION_SUFFIX, '')
  if (sourcePath.startsWith('/')) return normalizedLocalPath(sourcePath)
  return normalizedLocalPath(`${workspacePath.replace(/\/+$/, '')}/${sourcePath}`)
}

/** Find conservative, previewable filename/path tokens in raw terminal text. */
export function detectLocalFileReferences(text: string, workspacePath: string): LocalFileReference[] {
  const references: LocalFileReference[] = []
  for (const match of text.matchAll(FILE_TOKEN)) {
    const raw = match[0]
    const rawStart = match.index
    let leading = 0
    let trailing = raw.length
    while (leading < trailing && '([{'.includes(raw[leading])) leading += 1
    while (trailing > leading && ')]},;!?'.includes(raw[trailing - 1])) trailing -= 1
    if (trailing > leading && raw[trailing - 1] === '.') trailing -= 1
    if (trailing > leading && raw[trailing - 1] === ':' && !/:\d+(?::\d+)?$/.test(raw.slice(leading, trailing))) trailing -= 1
    let label = raw.slice(leading, trailing)
    // A remote `host:/path/file.ext` cannot be opened by the local previewer.
    // Link its basename against the TUI workspace instead; this also keeps a
    // remote path prefix from being mistaken for a relative local directory.
    if (REMOTE_FILE_PREFIX.test(label)) {
      const basenameStart = label.lastIndexOf('/') + 1
      leading += basenameStart
      label = label.slice(basenameStart)
    }
    const path = localFilePreviewPath(label, workspacePath)
    if (!path) continue
    references.push({ label, path, start: rawStart + leading, end: rawStart + trailing })
  }
  return references
}

interface TerminalStringCell {
  x: number
  y: number
  width: number
}

const FILE_TOKEN_AT_END = /[^\s<>"'`，。；：！？、（）【】「」『』]+$/u
const FILE_TOKEN_AT_START = /^[^\s<>"'`，。；：！？、（）【】「」『』]+/u

function hardFileContinuationIndent(previousText: string, nextText: string, workspacePath: string) {
  const indentation = nextText.match(/^[ \t]{2,}/)?.[0].length ?? 0
  if (!indentation) return null
  const previousToken = previousText.match(FILE_TOKEN_AT_END)?.[0] ?? ''
  const nextToken = nextText.slice(indentation).match(FILE_TOKEN_AT_START)?.[0] ?? ''
  if (!previousToken || !nextToken || localFilePreviewPath(previousToken, workspacePath)) return null
  // Hard-line continuation is intentionally narrower than ordinary filename
  // detection: require an evident path or a split at path-like punctuation.
  if (!previousToken.includes('/') && !/[._-]$/.test(previousToken)) return null
  const boundary = previousToken.length
  return detectLocalFileReferences(`${previousToken}${nextToken}`, workspacePath).some(
    (reference) => reference.start < boundary && reference.end > boundary,
  ) ? indentation : null
}

/**
 * Map raw xterm cells to clickable file ranges. Soft-wrapped rows stay one
 * logical group. An explicitly newline-separated, indented filename may also
 * continue across a hard row boundary, without parsing Markdown or HTML.
 */
export function detectTerminalFileLinks(
  rows: TerminalLinkRow[],
  firstBufferLine: number,
  requestedBufferLine: number,
  workspacePath: string,
): TerminalFileLinkRange[] {
  let text = ''
  const stringCells: TerminalStringCell[] = []

  rows.forEach((row, rowIndex) => {
    const nextRowIsWrapped = rows[rowIndex + 1]?.isWrapped !== false
    const endsLogicalLine = rowIndex === rows.length - 1 || !nextRowIsWrapped
    let cellLimit = row.cells.length
    if (endsLogicalLine) {
      while (cellLimit > 0 && !row.cells[cellLimit - 1].chars) cellLimit -= 1
    }
    let rowText = ''
    const rowStringCells: TerminalStringCell[] = []
    for (let column = 0; column < cellLimit; column += 1) {
      const cell = row.cells[column]
      if (!cell || cell.width === 0) continue
      const chars = cell.chars || ' '
      rowText += chars
      for (let offset = 0; offset < chars.length; offset += 1) {
        rowStringCells.push({
          x: column + 1,
          y: firstBufferLine + rowIndex,
          width: cell.width,
        })
      }
    }

    let leadingCharacters = 0
    if (rowIndex > 0 && row.isWrapped === false) {
      const continuationIndent = hardFileContinuationIndent(text, rowText, workspacePath)
      if (continuationIndent === null) {
        text += '\n'
        stringCells.push({ x: 1, y: firstBufferLine + rowIndex, width: 0 })
      } else {
        leadingCharacters = continuationIndent
      }
    }
    text += rowText.slice(leadingCharacters)
    stringCells.push(...rowStringCells.slice(leadingCharacters))
  })

  return detectLocalFileReferences(text.trimEnd(), workspacePath).flatMap((reference) => {
    const startCell = stringCells[reference.start]
    const endCell = stringCells[reference.end - 1]
    if (!startCell || !endCell) return []
    if (requestedBufferLine < startCell.y || requestedBufferLine > endCell.y) return []
    return [{
      label: reference.label,
      path: reference.path,
      start: { x: startCell.x, y: startCell.y },
      end: { x: endCell.x + Math.max(1, endCell.width) - 1, y: endCell.y },
    }]
  })
}
