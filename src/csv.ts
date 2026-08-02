export interface CsvDocument {
  rows: string[][]
  lineEnding: '\n' | '\r\n'
  trailingNewline: boolean
  byteOrderMark: boolean
}

export function parseCsv(source: string): CsvDocument {
  const byteOrderMark = source.startsWith('\uFEFF')
  const content = byteOrderMark ? source.slice(1) : source
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n'
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let index = 0
  let endedWithNewline = false

  while (index < content.length) {
    const character = content[index]
    endedWithNewline = false

    if (quoted) {
      if (character === '"') {
        if (content[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }
        quoted = false
      } else {
        field += character
      }
      index += 1
      continue
    }

    if (character === '"' && field.length === 0) {
      quoted = true
      index += 1
      continue
    }
    if (character === ',') {
      row.push(field)
      field = ''
      index += 1
      continue
    }
    if (character === '\n' || character === '\r') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      endedWithNewline = true
      if (character === '\r' && content[index + 1] === '\n') index += 1
      index += 1
      continue
    }

    field += character
    index += 1
  }

  if (!endedWithNewline || rows.length === 0) {
    row.push(field)
    rows.push(row)
  }

  return {
    rows,
    lineEnding,
    trailingNewline: endedWithNewline,
    byteOrderMark,
  }
}

function serializeCsvField(value: string) {
  if (!/[",\r\n]/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

export function serializeCsv(document: CsvDocument): string {
  const content = document.rows
    .map((row) => row.map(serializeCsvField).join(','))
    .join(document.lineEnding)
  return `${document.byteOrderMark ? '\uFEFF' : ''}${content}${document.trailingNewline ? document.lineEnding : ''}`
}

export function normalizeCsvRows(rows: string[][]): string[][] {
  const width = Math.max(1, ...rows.map((row) => row.length))
  return (rows.length ? rows : [[]]).map((row) => (
    Array.from({ length: width }, (_, column) => row[column] ?? '')
  ))
}
