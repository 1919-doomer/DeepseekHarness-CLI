const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u
const MARK = /\p{Mark}/u

export interface GraphemeEditResult {
  value: string
  cursor: number
}

/** Logical editor positions are grapheme indexes, never UTF-16 offsets. */
export function splitGraphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), part => part.segment)
}

export function graphemeCount(value: string): number {
  let count = 0
  for (const _part of graphemeSegmenter.segment(value)) count++
  return count
}

export function insertAtGrapheme(value: string, cursor: number, inserted: string): GraphemeEditResult {
  const graphemes = splitGraphemes(value)
  const position = clamp(cursor, 0, graphemes.length)
  graphemes.splice(position, 0, inserted)
  return {
    value: graphemes.join(''),
    cursor: position + graphemeCount(inserted),
  }
}

export function deleteGraphemeBefore(value: string, cursor: number): GraphemeEditResult {
  const graphemes = splitGraphemes(value)
  const position = clamp(cursor, 0, graphemes.length)
  if (position === 0) return { value, cursor: 0 }
  graphemes.splice(position - 1, 1)
  return { value: graphemes.join(''), cursor: position - 1 }
}

export function terminalCellWidth(value: string): number {
  let width = 0
  for (const grapheme of splitGraphemes(value)) width += graphemeCellWidth(grapheme)
  return width
}

/**
 * Count the rows a string occupies once the terminal wraps it.
 *
 * Dividing total cells by the column count would assume a wide grapheme can be
 * split across the wrap boundary. A terminal never does that: with one column
 * left and a two-cell grapheme next, it wraps early and wastes the column. That
 * assumption under-counts CJK and emoji lines, and under-counting is the
 * direction that corrupts the frame — the transcript then selects more blocks
 * than fit and the alternate screen scrolls.
 */
export function wrappedTerminalRows(value: string, columns: number): number {
  const width = Math.max(1, columns)
  return value.split('\n').reduce((rows, line) => rows + lineRows(line, width), 0)
}

function lineRows(line: string, width: number): number {
  let rows = 1
  let used = 0
  for (const grapheme of splitGraphemes(line)) {
    const cells = graphemeCellWidth(grapheme)
    // `used > 0` keeps a grapheme wider than the whole terminal on its own row
    // instead of looping.
    if (used > 0 && used + cells > width) {
      rows++
      used = cells
      continue
    }
    used += cells
  }
  return rows
}

export function cropTerminalText(value: string, width: number): string {
  const budget = Math.max(0, width)
  if (budget === 0) return ''
  if (terminalCellWidth(value) <= budget) return value
  if (budget <= 3) return prefixByCells(value, budget)
  return `${prefixByCells(value, budget - 1)}…`
}

/**
 * Cell slicing is also capped by grapheme count so a pathological run of
 * zero-width clusters/newlines cannot bypass a practical output budget.
 */
export function prefixByCells(value: string, maxCells: number): string {
  if (maxCells <= 0) return ''
  let result = ''
  let cells = 0
  let count = 0
  for (const grapheme of splitGraphemes(value)) {
    const next = graphemeCellWidth(grapheme)
    if (cells + next > maxCells || count >= maxCells) break
    result += grapheme
    cells += next
    count++
  }
  return result
}

export function suffixByCells(value: string, maxCells: number): string {
  if (maxCells <= 0) return ''
  const graphemes = splitGraphemes(value)
  let result = ''
  let cells = 0
  let count = 0
  for (let index = graphemes.length - 1; index >= 0; index--) {
    const grapheme = graphemes[index]!
    const next = graphemeCellWidth(grapheme)
    if (cells + next > maxCells || count >= maxCells) break
    result = grapheme + result
    cells += next
    count++
  }
  return result
}

export function graphemeAt(value: string, cursor: number): string | undefined {
  return splitGraphemes(value)[cursor]
}

export function sliceByGrapheme(value: string, start: number, end?: number): string {
  return splitGraphemes(value).slice(start, end).join('')
}

function graphemeCellWidth(grapheme: string): number {
  if (grapheme === '\n') return 0
  if (grapheme === '\t') return 4
  if (EXTENDED_PICTOGRAPHIC.test(grapheme) || REGIONAL_INDICATOR.test(grapheme) || grapheme.includes('\u20E3')) {
    return 2
  }

  let hasVisibleCodePoint = false
  for (const character of grapheme) {
    const codePoint = character.codePointAt(0) ?? 0
    if (isZeroWidthCodePoint(codePoint, character)) continue
    hasVisibleCodePoint = true
    if (isFullwidthCodePoint(codePoint)) return 2
  }
  return hasVisibleCodePoint ? 1 : 0
}

function isZeroWidthCodePoint(codePoint: number, character: string): boolean {
  return MARK.test(character)
    || codePoint === 0x200d
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
}

// Mirrors the terminal-wide ranges used by common wcwidth/string-width
// implementations while keeping this package dependency-free.
function isFullwidthCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1b000 && codePoint <= 0x1b001)
    || (codePoint >= 0x1f200 && codePoint <= 0x1f251)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  )
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
