import { terminalCellWidth } from './text-metrics.js'

/**
 * Markdown for a terminal.
 *
 * Models write markdown whether or not anything renders it, so until now an
 * answer arrived as literal asterisks and pound signs. The rejected alternative
 * was a persona line asking the model not to — a product defect used to
 * constrain a model, which does not hold and would have to be removed once this
 * existed.
 *
 * **Safe by construction.** This parser never emits an escape sequence. It
 * returns styled spans, and the Ink layer turns those into `<Text bold>` props,
 * so markdown cannot become a path back to the escape injection that
 * `sanitizeTerminalText` exists to prevent. Nothing here may be changed to
 * return ANSI directly.
 *
 * Deliberately not CommonMark. It handles what a model actually emits into a
 * chat reply and leaves anything it does not recognise as plain text, because
 * an unrecognised construct showing through is a much smaller failure than
 * mangled content.
 */

export interface MarkdownSpan {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
}

export type MarkdownLine =
  | { kind: 'text'; spans: readonly MarkdownSpan[]; indent: number }
  | { kind: 'heading'; level: number; spans: readonly MarkdownSpan[] }
  | { kind: 'bullet'; marker: string; spans: readonly MarkdownSpan[]; indent: number }
  | { kind: 'quote'; spans: readonly MarkdownSpan[] }
  | { kind: 'code'; text: string; language?: string }
  | { kind: 'rule' }
  | { kind: 'table'; rows: readonly (readonly (readonly MarkdownSpan[])[])[]; headerRows: number }
  | { kind: 'blank' }

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

export function parseMarkdown(source: string): readonly MarkdownLine[] {
  const lines = source.split('\n').map(line => line.replace(/\r$/, ''))
  const out: MarkdownLine[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''

    const fence = FENCE.exec(line)
    if (fence?.[1] !== undefined) {
      const marker = fence[1]
      const body: string[] = []
      index += 1
      // An unterminated fence runs to the end rather than swallowing the rest
      // of the reply as an error: the content still has to reach the reader.
      while (index < lines.length && !isClosingFence(lines[index] ?? '', marker)) {
        body.push(lines[index] ?? '')
        index += 1
      }
      const language = fence[2]
      out.push({
        kind: 'code',
        text: body.join('\n'),
        ...(language === undefined || language.length === 0 ? {} : { language }),
      })
      continue
    }

    if (line.trim().length === 0) {
      out.push({ kind: 'blank' })
      continue
    }

    if (RULE.test(line)) {
      out.push({ kind: 'rule' })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading?.[1] !== undefined) {
      out.push({ kind: 'heading', level: heading[1].length, spans: parseSpans(heading[2] ?? '') })
      continue
    }

    // A table needs its divider row to exist before the header means anything,
    // so it is recognised two lines at a time rather than one.
    if (line.includes('|') && TABLE_DIVIDER.test(lines[index + 1] ?? '')) {
      const rows: (readonly MarkdownSpan[])[][] = [splitRow(line)]
      index += 2
      while (index < lines.length && (lines[index] ?? '').includes('|')) {
        rows.push(splitRow(lines[index] ?? ''))
        index += 1
      }
      index -= 1
      out.push({ kind: 'table', rows, headerRows: 1 })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote !== null) {
      out.push({ kind: 'quote', spans: parseSpans(quote[1] ?? '') })
      continue
    }

    const bullet = BULLET.exec(line)
    if (bullet?.[2] !== undefined) {
      out.push({
        kind: 'bullet',
        marker: /^\d/.test(bullet[2]) ? bullet[2] : '•',
        spans: parseSpans(bullet[3] ?? ''),
        indent: (bullet[1] ?? '').length,
      })
      continue
    }

    const indent = line.length - line.trimStart().length
    out.push({ kind: 'text', spans: parseSpans(line.trim()), indent })
  }

  return out
}

/**
 * Inline emphasis and code.
 *
 * Code is resolved first and its contents are never re-scanned, so a snippet
 * containing `*` survives verbatim — that is the whole point of quoting it.
 */
export function parseSpans(source: string): readonly MarkdownSpan[] {
  const spans: MarkdownSpan[] = []
  let plain = ''

  const flush = (): void => {
    if (plain.length > 0) spans.push({ text: plain })
    plain = ''
  }

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? ''

    if (char === '\\' && index + 1 < source.length && isMarker(source[index + 1] ?? '')) {
      plain += source[index + 1]
      index += 1
      continue
    }

    if (char === '`') {
      const close = source.indexOf('`', index + 1)
      if (close > index + 1) {
        flush()
        spans.push({ text: source.slice(index + 1, close), code: true })
        index = close
        continue
      }
    }

    if (char === '*' || char === '_') {
      const strong = source.startsWith(char.repeat(2), index)
      const marker = strong ? char.repeat(2) : char
      const close = source.indexOf(marker, index + marker.length)
      if (close > index + marker.length) {
        const inner = source.slice(index + marker.length, close)
        // An underscore inside a word is part of the word: `read_image_now` is
        // an identifier, and italicising its middle would show the reader a
        // different name than the one they have to type. Asterisks have no such
        // rule because nothing spells identifiers with them.
        const intraword = char === '_'
          && (isWordChar(source[index - 1]) || isWordChar(source[close + marker.length]))
        if (!intraword && !/^\s|\s$/.test(inner)) {
          flush()
          for (const span of parseSpans(inner)) {
            spans.push(strong ? { ...span, bold: true } : { ...span, italic: true })
          }
          index = close + marker.length - 1
          continue
        }
      }
    }

    plain += char
  }

  flush()
  return spans
}

/** Column widths for a table, measured in terminal cells so CJK lines up. */
export function tableColumnWidths(
  rows: readonly (readonly (readonly MarkdownSpan[])[])[],
): readonly number[] {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, column) => {
      const width = terminalCellWidth(spanText(cell))
      widths[column] = Math.max(widths[column] ?? 0, width)
    })
  }
  return widths
}

export function spanText(spans: readonly MarkdownSpan[]): string {
  return spans.map(span => span.text).join('')
}

/** True when a body is worth routing through the renderer at all. */
export function looksLikeMarkdown(source: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>\s|`{3,}|~{3,})/.test(source)
    || /\*\*[^\s*][^*]*\*\*/.test(source)
    || /`[^`\n]+`/.test(source)
    || /(^|\n)\s*\|.*\|/.test(source)
}

function isClosingFence(line: string, marker: string): boolean {
  const match = FENCE.exec(line)
  return match?.[1] !== undefined && match[1][0] === marker[0] && match[1].length >= marker.length
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char)
}

function isMarker(char: string): boolean {
  return char === '*' || char === '_' || char === '`' || char === '#' || char === '\\'
}

function splitRow(line: string): (readonly MarkdownSpan[])[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map(cell => parseSpans(cell.trim()))
}
