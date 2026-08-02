export type AutoRichMode = 'conservative' | 'aggressive'
export type AutoRichKind = 'markdown' | 'math' | 'html' | 'code' | 'table'
export type AutoRichConfidence = 'high' | 'medium'

export interface TerminalBufferRow {
  text: string
  isWrapped: boolean
  bufferRow?: number
  colorRuns?: TerminalColorRun[]
}

export interface TerminalColorRun {
  /** UTF-16 string offset, matching Markdown position columns. */
  start: number
  end: number
  color: string
}

export interface TerminalLogicalLine {
  text: string
  startRow: number
  endRow: number
  colorRuns?: TerminalColorRun[]
}

export interface AutoRichBlock {
  id: string
  raw: string
  rendered: string
  kind: AutoRichKind
  confidence: AutoRichConfidence
  score: number
  startRow: number
  endRow: number
  /** First terminal cell occupied by the Raw block's visible content. */
  startColumn: number
  /** Physical xterm-row count occupied by each Raw logical source line. */
  sourceRowSpans?: number[]
  /** Non-default xterm foreground colors, aligned with Raw source lines. */
  sourceColorRuns?: TerminalColorRun[][]
  language?: string
}

export interface AutoRichFileReference {
  label: string
  path: string
  start: number
  end: number
}

const MAX_BLOCK_CHARS = 12_000
const MAX_RETAINED_BLOCKS = 12
const MAX_RETAINED_CHARS = 64_000
export const AUTO_RICH_FILE_HREF_PREFIX = '#agrider-file='

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
// Full-width CJK punctuation is prose punctuation, not a path character.
// Splitting on it lets `已儲存：fix_staging_prompt.md:1` expose the actual
// previewable filename instead of treating the whole sentence as one path.
const FILE_TOKEN = /[^\s<>"'`，。；：！？、（）【】「」『』]+/gu

const MATH_COMMAND = /\\(?:begin|end|text|operatorname|mathrm|mathbf|mathit|mathcal|mathbb|mathsf|mathtt|frac|dfrac|tfrac|sqrt|sum|prod|int|lim|log|ln|exp|sin|cos|tan|min|max|argmin|argmax|left|right|overline|underline|vec|hat|bar|partial|nabla|times|cdot|div|pm|mid|leq|geq|neq|approx|infty|alpha|beta|gamma|delta|theta|lambda|mu|sigma|phi|omega)\b/g
const MATH_LINE = /\\(?:begin|end|text|operatorname|mathrm|mathbf|mathit|mathcal|mathbb|mathsf|mathtt|frac|dfrac|tfrac|sqrt|sum|prod|int|lim|log|ln|exp|sin|cos|tan|min|max|argmin|argmax|left|right|overline|underline|vec|hat|bar|partial|nabla|times|cdot|div|pm|mid|leq|geq|neq|approx|infty|alpha|beta|gamma|delta|theta|lambda|mu|sigma|phi|omega)\b/
const MATH_OPERATOR_LINE = /^\s*(?:[()[\]{}]|[=+\-*/]|\^|_|\\(?:times|cdot|div|pm|leq|geq|neq|approx))+\s*$/
// Agent output can preserve both the chat-list bullet and an original Markdown
// heading marker, e.g. `• # [`. Treat this harmless prefix sequence as part of
// the implicit display delimiter rather than passing it through to KaTeX.
const IMPLICIT_MATH_BRACKET_OPEN = /^\s*(?:[#•]\s*)*\[\s*$/u
const IMPLICIT_MATH_BRACKET_CLOSE = /^\s*]\s*$/
const BORDER_ONLY = /^\s*[╭╮╰╯┌┐└┘├┤┬┴┼│┃║─━═┄┈┅┉╔╗╚╝]+\s*$/u
const RULED_TABLE_SEPARATOR = /^\s*(?:[─━]{3,}\s{2,})+[─━]{3,}\s*$/u
const TRANSIENT_STATUS = /^\s*(?:esc\b|ctrl\+|shift\+|alt\+|option\+|press\s+\S+|tokens?\s+(?:left|used)|context\s+(?:left|remaining)|working(?:\s+\(\d+s\))?|thinking(?:\s+\(\d+s\))?|connecting|reconnecting|approval required)\b/i
const PROMPT_ONLY = /^\s*(?:[›❯]|\$|>)\s*$/u
const SHELL_PROMPT_COMMAND = [
  /^\s*\$\s+\S/u,
  /^\s*[\w.-]+@[\w.-]+(?::[^$#\n]*)?\s*[$#]\s+\S/u,
  /^\s*\[[^\]\n]+\]\s*[$#]\s+\S/u,
]
const VOID_HTML_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

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

/** Resolve a terminal-authored local file reference against its conversation workspace. */
export function localFilePreviewPath(reference: string, workspacePath: string) {
  let decoded = reference.trim()
  if (decoded.startsWith(AUTO_RICH_FILE_HREF_PREFIX)) {
    decoded = decoded.slice(AUTO_RICH_FILE_HREF_PREFIX.length)
  }
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    return null
  }
  if (!previewableFileReference(decoded)) return null
  const sourcePath = decoded.replace(FILE_LOCATION_SUFFIX, '')
  if (sourcePath.startsWith('/')) return normalizedLocalPath(sourcePath)
  return normalizedLocalPath(`${workspacePath.replace(/\/+$/, '')}/${sourcePath}`)
}

/** Find conservative, previewable filename/path tokens in ordinary Markdown text. */
export function detectLocalFileReferences(text: string, workspacePath: string): AutoRichFileReference[] {
  const references: AutoRichFileReference[] = []
  for (const match of text.matchAll(FILE_TOKEN)) {
    const raw = match[0]
    const rawStart = match.index
    let leading = 0
    let trailing = raw.length
    while (leading < trailing && '([{'.includes(raw[leading])) leading += 1
    while (trailing > leading && ')]},;!?'.includes(raw[trailing - 1])) trailing -= 1
    if (trailing > leading && raw[trailing - 1] === '.') trailing -= 1
    if (trailing > leading && raw[trailing - 1] === ':' && !/:\d+(?::\d+)?$/.test(raw.slice(leading, trailing))) trailing -= 1
    const label = raw.slice(leading, trailing)
    const path = localFilePreviewPath(label, workspacePath)
    if (!path) continue
    references.push({ label, path, start: rawStart + leading, end: rawStart + trailing })
  }
  return references
}

export function autoRichFileHref(path: string) {
  return `${AUTO_RICH_FILE_HREF_PREFIX}${encodeURIComponent(path)}`
}

/**
 * Reconstruct logical terminal lines without splitting wide Unicode glyphs or
 * inserting newlines at xterm's visual wraps. Callers should pass each row
 * translated at the terminal's full column width; padding is trimmed only
 * after the logical line is complete.
 */
export function reconstructLogicalRows(rows: TerminalBufferRow[]): TerminalLogicalLine[] {
  const lines: TerminalLogicalLine[] = []
  let current = ''
  let currentColorRuns: TerminalColorRun[] = []
  let currentStart = 0
  let currentEnd = 0
  let started = false

  const appendColorRuns = (runs: TerminalColorRun[] | undefined, offset: number) => {
    if (!runs?.length) return
    for (const run of runs) {
      const adjusted = { ...run, start: run.start + offset, end: run.end + offset }
      const previous = currentColorRuns[currentColorRuns.length - 1]
      if (previous && previous.end === adjusted.start && previous.color === adjusted.color) previous.end = adjusted.end
      else currentColorRuns.push(adjusted)
    }
  }

  const pushCurrent = () => {
    const line: TerminalLogicalLine = { text: current.trimEnd(), startRow: currentStart, endRow: currentEnd }
    if (currentColorRuns.length) line.colorRuns = currentColorRuns
    lines.push(line)
  }

  for (const [index, row] of rows.entries()) {
    const bufferRow = row.bufferRow ?? index
    if (row.isWrapped && started) {
      const offset = current.length
      current += row.text
      appendColorRuns(row.colorRuns, offset)
      currentEnd = bufferRow
      continue
    }
    if (started) pushCurrent()
    current = row.text
    currentColorRuns = []
    appendColorRuns(row.colorRuns, 0)
    currentStart = bufferRow
    currentEnd = bufferRow
    started = true
  }
  if (started) pushCurrent()

  return lines
}

export function reconstructLogicalLines(rows: TerminalBufferRow[]): string[] {
  return reconstructLogicalRows(rows).map((line) => line.text)
}

function stripOuterFrame(line: string) {
  const trimmed = line.trimEnd()
  const leadingColumns = trimmed.match(/^\s*/)?.[0].length ?? 0
  const verticals = trimmed.match(/[│┃║]/gu)?.length ?? 0
  if (verticals === 1 && /^\s*[│┃║]/u.test(trimmed)) {
    return { text: trimmed.replace(/^\s*[│┃║]\s?/u, ''), startColumn: leadingColumns }
  }
  if (verticals === 2 && /^\s*[│┃║]/u.test(trimmed) && /[│┃║]\s*$/u.test(trimmed)) {
    return {
      text: trimmed.replace(/^\s*[│┃║]\s?/u, '').replace(/\s?[│┃║]\s*$/u, ''),
      startColumn: leadingColumns,
    }
  }
  return { text: trimmed, startColumn: 0 }
}

function isTransientChrome(line: string, agent?: string) {
  const trimmed = line.trim()
  if (!trimmed || BORDER_ONLY.test(trimmed) || PROMPT_ONLY.test(trimmed)) return !trimmed ? false : true
  if (trimmed.length <= 180 && TRANSIENT_STATUS.test(trimmed)) return true
  if (agent === 'codex' && /^\?\s+for shortcuts\b/i.test(trimmed)) return true
  if (agent === 'claude' && /^(?:bypass permissions on|accept edits on|plan mode on)\b/i.test(trimmed)) return true
  if (agent === 'gemini' && /^(?:sandbox|auto edit)\s+(?:on|off)\b/i.test(trimmed)) return true
  return false
}

function isShellPromptCommand(line: string) {
  return SHELL_PROMPT_COMMAND.some((pattern) => pattern.test(line))
}

function contentLines(lines: TerminalLogicalLine[], agent?: string) {
  return lines.map((source) => {
    const framed = stripOuterFrame(source.text)
    const prompt = framed.text.match(/^\s*›\s+(?=\S)/u)?.[0] ?? ''
    const line = prompt ? framed.text.slice(prompt.length) : framed.text
    // A command echo is not content, but it is a meaningful boundary between
    // the preceding response and the output produced by the next command.
    return {
      ...source,
      text: isShellPromptCommand(line) ? null : isTransientChrome(line, agent) ? '' : line,
      startColumn: framed.startColumn + prompt.length,
    }
  })
}

interface CandidateBlock {
  value: string
  startRow: number
  endRow: number
  startColumn: number
  sourceRowSpans: number[]
  sourceColorRuns: TerminalColorRun[][]
}

type ContentLine = Omit<TerminalLogicalLine, 'text'> & { text: string | null; startColumn: number }

function leadingWhitespaceColumns(value: string) {
  return value.match(/^\s*/)?.[0].length ?? 0
}

function opensExplicitMathBlock(line: string) {
  return /^\s*(?:["“”]\s*)?(?:\$\$|\\\[)\s*(?:["“”])?\s*$/.test(line)
}

function containsCompletedExplicitMath(lines: ContentLine[]) {
  const value = lines.map((line) => line.text ?? '').join('\n')
  return /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])/.test(value)
}

function candidateBlocks(lines: ContentLine[]) {
  const blocks: CandidateBlock[] = []
  let current: ContentLine[] = []
  let blankRun = 0

  const flush = () => {
    const content = current.filter((line) => line.text?.trim())
    const startColumn = content.length
      ? Math.min(...content.map((line) => line.startColumn + leadingWhitespaceColumns(line.text ?? '')))
      : 0
    const firstContentIndex = current.findIndex((line) => Boolean(line.text?.trim()))
    let lastContentIndex = current.length - 1
    while (lastContentIndex >= 0 && !current[lastContentIndex].text?.trim()) {
      lastContentIndex -= 1
    }
    const sourceLines = firstContentIndex >= 0 ? current.slice(firstContentIndex, lastContentIndex + 1) : []
    const value = sourceLines.map((line) => {
      if (line.text === null) return ''
      const commonIndent = Math.max(0, startColumn - line.startColumn)
      return line.text.slice(Math.min(commonIndent, leadingWhitespaceColumns(line.text)))
    }).join('\n').trimEnd()
    if (value.length >= 3 && content.length) {
      blocks.push({
        value: value.slice(0, MAX_BLOCK_CHARS),
        startRow: content[0].startRow,
        endRow: content[content.length - 1].endRow,
        startColumn,
        sourceRowSpans: sourceLines.map((line) => line.endRow - line.startRow + 1),
        sourceColorRuns: sourceLines.map((line) => line.colorRuns ?? []),
      })
    }
    current = []
    blankRun = 0
  }

  for (const line of lines) {
    if (line.text === null) {
      flush()
      continue
    }
    // A terminal response can put two independently quoted formula examples
    // one blank line apart. Keeping them in one projection forces both KaTeX
    // displays (and their prose) into a single Raw-row footprint, so the fit
    // logic can make them look clipped or undersized. Start a new projection
    // at the next standalone display delimiter once the preceding display is
    // complete; ordinary prose stays with its preceding formula.
    if (line.text.trim() && opensExplicitMathBlock(line.text) && current.length && containsCompletedExplicitMath(current)) {
      flush()
    }
    if (!line.text.trim()) {
      blankRun += 1
      if (blankRun >= 2) flush()
      else if (current.length) current.push(line)
      continue
    }
    blankRun = 0
    current.push(line)
  }
  flush()

  return blocks.slice(-32)
}

function balancedHtml(value: string) {
  const opening = [...value.matchAll(/<([a-z][\w-]*)\b[^>]*>/gi)]
    .map((match) => ({ tag: match[1].toLowerCase(), source: match[0] }))
    .filter(({ tag, source }) => !VOID_HTML_TAGS.has(tag) && !/\/\s*>$/.test(source))
    .map(({ tag }) => tag)
  if (!opening.length) return /<(?:br|hr|img|input)\b[^>]*\/?>/i.test(value)
  return opening.every((tag) => new RegExp(`<\\/${tag}\\s*>`, 'i').test(value))
}

function pipeTableRows(value: string) {
  return value.split('\n')
    .filter((line) => line.includes('|'))
    .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 2)
}

function boxTableRows(value: string) {
  return value.split('\n')
    .filter((line) => /[│┃║]/u.test(line) && !BORDER_ONLY.test(line))
    .map((line) => line.trim().replace(/^[│┃║]/u, '').replace(/[│┃║]$/u, '').split(/[│┃║]/u).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 2)
}

function ruledTableColumns(line: string) {
  return [...line.matchAll(/[─━]{3,}/gu)].map((match) => ({
    start: match.index ?? 0,
  }))
}

/** Rebuild a Markdown table from terminal-rendered columns and rule rows. */
function ruledTableRows(value: string) {
  const lines = value.split('\n')
  const separator = lines.find((line) => RULED_TABLE_SEPARATOR.test(line))
  if (!separator) return []
  const columns = ruledTableColumns(separator)
  if (columns.length < 2) return []
  return lines
    .filter((line) => line.trim() && !RULED_TABLE_SEPARATOR.test(line))
    .map((line) => columns.map(({ start }, index) => {
      const end = columns[index + 1]?.start ?? line.length
      return line.slice(start, end).trim()
    }))
    .filter((row) => row.some(Boolean))
}

function consistentRows(rows: string[][]) {
  if (rows.length < 2) return false
  const columns = rows[0].length
  return rows.every((row) => row.length === columns)
}

function inlineMathFromTerminalTableCell(cell: string) {
  const value = cell.trim()
  if (!value.startsWith('(') || !value.endsWith(')')) return value
  const math = value.slice(1, -1).trim()
  // Terminal Markdown renderers can consume the opening backslash in `\(`
  // while retaining TeX commands and superscripts. Restore only cells that
  // still carry an unambiguous math signal.
  return /(?:\\[A-Za-z]+|[\^_{}])/.test(math) ? `$${math}$` : value
}

function markdownTable(rows: string[][], restoreTerminalMath = false) {
  const escaped = rows.map((row) => row.map((cell) => {
    const value = restoreTerminalMath ? inlineMathFromTerminalTableCell(cell) : cell
    return value.replace(/\|/g, '\\|')
  }))
  return [
    `| ${escaped[0].join(' | ')} |`,
    `| ${escaped[0].map(() => '---').join(' | ')} |`,
    ...escaped.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join('\n')
}

function normalizeTable(value: string, kind: 'pipe' | 'box' | 'ruled') {
  const rows = kind === 'box' ? boxTableRows(value) : kind === 'ruled' ? ruledTableRows(value) : pipeTableRows(value)
  if (!consistentRows(rows)) return value
  const hasMarkdownSeparator = kind === 'pipe' && rows.length > 1 && rows[1].every((cell) => /^:?-{3,}:?$/.test(cell))
  if (hasMarkdownSeparator) return value
  return markdownTable(rows, kind === 'ruled')
}

function likelyCodeLanguage(value: string) {
  if (/^\s*(?:import|export)\s.+\sfrom\s+['"]/m.test(value) || /\b(?:const|let|function|interface|type)\s+\w+/.test(value)) return 'typescript'
  if (/^\s*(?:from\s+\S+\s+import|import\s+\S+|def\s+\w+|class\s+\w+.*:)\b/m.test(value)) return 'python'
  if (/^\s*(?:fn|struct|enum|impl|use)\s+\w+/m.test(value) || /\blet\s+mut\b/.test(value)) return 'rust'
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE)\b/im.test(value)) return 'sql'
  if (/^\s*(?:#!\/.*\b(?:bash|sh)|(?:sudo\s+)?(?:npm|git|cargo|ssh|curl)\s+)/m.test(value)) return 'bash'
  if (/^\s*[{[][\s\S]*[}\]]\s*$/.test(value) && /"\w+"\s*:/.test(value)) return 'json'
  return undefined
}

function implicitMathBracketRange(lines: string[]) {
  const open = lines.findIndex((line) => IMPLICIT_MATH_BRACKET_OPEN.test(line))
  if (open < 0) return null
  const close = lines.findIndex((line, index) => index > open && IMPLICIT_MATH_BRACKET_CLOSE.test(line))
  return close > open ? { open, close } : null
}

function prepareImplicitMath(value: string) {
  const normalized = value
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, math: string) => `$$${math}$$`)
    .replace(/\\\(([^\n]*?)\\\)/g, (_match, math: string) => `$${math}$`)
    .split('\n')
    .map((line) => {
      const delimiter = line.match(/^\s*(["“”])?\s*(\$\$)\s*(["“”])?\s*$/)
      if (!delimiter) return line
      return [delimiter[1], '$$', delimiter[3]].filter(Boolean).join('\n')
    })
    .join('\n')

  if (/\$\$[\s\S]*\$\$/.test(normalized) || /\$[^$\n]+\$/.test(normalized)) return normalized

  const lines = normalized.split('\n')
  const bracketRange = implicitMathBracketRange(lines)
  if (
    bracketRange
    && lines.slice(bracketRange.open + 1, bracketRange.close).some((line) => MATH_LINE.test(line))
  ) {
    return [
      ...lines.slice(0, bracketRange.open),
      '$$',
      ...lines.slice(bracketRange.open + 1, bracketRange.close),
      '$$',
      ...lines.slice(bracketRange.close + 1),
    ].join('\n').trim()
  }

  const first = lines.findIndex((line) => MATH_LINE.test(line) || MATH_OPERATOR_LINE.test(line))
  let last = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (MATH_LINE.test(lines[index]) || MATH_OPERATOR_LINE.test(lines[index])) {
      last = index
      break
    }
  }
  if (first < 0 || last < first) return normalized

  const opening = first > 0 && IMPLICIT_MATH_BRACKET_OPEN.test(lines[first - 1]) ? first - 1 : first
  const closing = last + 1 < lines.length && IMPLICIT_MATH_BRACKET_CLOSE.test(lines[last + 1]) ? last + 1 : last
  const mathLines = lines.slice(first, last + 1)
  const nonblank = lines.filter((line) => line.trim()).length
  const mathDominant = mathLines.filter((line) => line.trim()).length >= Math.max(1, Math.ceil(nonblank / 2))
  if (!mathDominant) return normalized

  return [
    ...lines.slice(0, opening),
    '$$',
    ...mathLines,
    '$$',
    ...lines.slice(closing + 1),
  ].join('\n').trim()
}

function hashContent(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function classify(candidate: CandidateBlock): AutoRichBlock | null {
  const { value, startRow, endRow, startColumn, sourceRowSpans, sourceColorRuns } = candidate
  const lines = value.split('\n')
  const mathCommands = value.match(MATH_COMMAND)?.length ?? 0
  const explicitMath = /(\$\$[\s\S]*\$\$|\\\[[\s\S]*\\\]|\\\([\s\S]*\\\))/.test(value)
  const bracketRange = implicitMathBracketRange(lines)
  const bracketMath = Boolean(
    bracketRange
    && lines.slice(bracketRange.open + 1, bracketRange.close).some((line) => MATH_LINE.test(line)),
  )
  const fencedCode = /```[\w-]*\n[\s\S]*```/.test(value)
  const html = /<[a-z][\w-]*\b[^>]*>/i.test(value) && balancedHtml(value)
  const pipes = pipeTableRows(value)
  const boxes = boxTableRows(value)
  const ruled = ruledTableRows(value)
  const pipeTable = consistentRows(pipes)
  const boxTable = consistentRows(boxes)
  const ruledTable = consistentRows(ruled)
  const heading = /^#{1,6}\s+(?!\[\s*$)\S/m.test(value)
  const listLines = lines.filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)).length
  const quoteLines = lines.filter((line) => /^\s*>\s+\S/.test(line)).length
  const localFileReferences = detectLocalFileReferences(value, '.')
  const codeLanguage = likelyCodeLanguage(value)
  const codeLines = lines.filter((line) => /(?:[{};]$|^\s*(?:import|export|def|class|fn|struct|SELECT|const|let)\b|=>|:=)/.test(line)).length
  const mathSignal = explicitMath || bracketMath || mathCommands >= 1
  const tableSignal = pipeTable || boxTable
  const markdownSignal = heading || listLines > 0 || quoteLines > 0 || localFileReferences.length > 0
  const mixedStructure = [mathSignal, tableSignal, markdownSignal, html].filter(Boolean).length >= 2

  let kind: AutoRichKind | null = null
  let score = 0
  let rendered = value
  let language: string | undefined

  if (fencedCode) {
    kind = 'code'
    score = 96
  } else if (ruledTable) {
    kind = 'table'
    score = 86
    rendered = normalizeTable(value, 'ruled')
  } else if (mixedStructure) {
    kind = 'markdown'
    score = 90
    rendered = prepareImplicitMath(value)
  } else if (html) {
    kind = 'html'
    score = 86
  } else if (explicitMath || bracketMath || mathCommands >= 1) {
    kind = 'math'
    score = explicitMath ? 96 : bracketMath ? 88 : mathCommands >= 2 ? 78 : 56
    rendered = prepareImplicitMath(value)
  } else if (pipeTable || boxTable) {
    kind = 'table'
    score = pipeTable ? 82 : 76
    rendered = normalizeTable(value, boxTable ? 'box' : 'pipe')
  } else if (heading || listLines || quoteLines) {
    kind = 'markdown'
    score = heading ? 76 : listLines >= 2 ? 72 : quoteLines >= 2 ? 68 : 54
  } else if (localFileReferences.length) {
    kind = 'markdown'
    score = 70
  } else if (codeLanguage || codeLines >= 3) {
    kind = 'code'
    score = codeLines >= 5 || codeLanguage ? 74 : 62
    language = codeLanguage
    rendered = `\`\`\`${language ?? ''}\n${value}\n\`\`\``
  }

  if (!kind || score < 45) return null
  const raw = value.slice(0, MAX_BLOCK_CHARS)
  return {
    id: `${kind}-${startRow}-${endRow}-${startColumn}-${hashContent(raw)}`,
    raw,
    rendered: rendered.slice(0, MAX_BLOCK_CHARS + 32),
    kind,
    confidence: score >= 70 ? 'high' : 'medium',
    score,
    startRow,
    endRow,
    startColumn,
    sourceRowSpans,
    sourceColorRuns,
    language,
  }
}

export function detectAutoRichBlocks(lines: Array<string | TerminalLogicalLine>, agent?: string): AutoRichBlock[] {
  const logicalLines = lines.map((line, index) => typeof line === 'string'
    ? { text: line, startRow: index, endRow: index }
    : line)
  return candidateBlocks(contentLines(logicalLines, agent))
    .map(classify)
    .filter((block): block is AutoRichBlock => block !== null)
}

function commonPrefixRatio(left: string, right: string) {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return limit ? index / limit : 0
}

function isEvolvingBlock(previous: AutoRichBlock, next: AutoRichBlock) {
  if (previous.kind !== next.kind) return false
  if (previous.raw.startsWith(next.raw) || next.raw.startsWith(previous.raw)) return true
  const lengthRatio = next.raw.length / Math.max(1, previous.raw.length)
  return lengthRatio >= 0.5 && lengthRatio <= 2 && commonPrefixRatio(previous.raw, next.raw) >= 0.65
}

/**
 * Retain completed terminal-derived blocks while replacing a streaming block
 * with its newer stable form. Both count and total text are bounded.
 */
export function mergeAutoRichBlocks(previous: AutoRichBlock[], detected: AutoRichBlock[]) {
  const merged = [...previous]

  for (const block of detected) {
    if (merged.some((item) => item.id === block.id)) continue
    let evolvingIndex = -1
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      if (!isEvolvingBlock(merged[index], block)) continue
      evolvingIndex = index
      break
    }
    if (evolvingIndex >= 0) merged[evolvingIndex] = block
    else merged.push(block)
  }

  const bounded = merged.slice(-MAX_RETAINED_BLOCKS)
  let chars = bounded.reduce((sum, block) => sum + block.raw.length, 0)
  while (bounded.length > 1 && chars > MAX_RETAINED_CHARS) {
    chars -= bounded[0].raw.length
    bounded.shift()
  }
  return bounded
}
