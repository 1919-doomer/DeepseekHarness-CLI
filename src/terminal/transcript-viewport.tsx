import { memo } from 'react'
import { Box, Text } from 'ink'
import type { TranscriptBlock } from '../plugins/api.js'
import type { Locale } from '../i18n.js'
import { blockHeaderText, foldTerminalText } from './transcript-view.js'
import { retainedTranscriptField } from './transcript.js'
import { looksLikeMarkdown, spanText, tableColumnWidths, type MarkdownLine, type MarkdownSpan } from './markdown.js'
import { StreamingMarkdown } from './streaming-markdown.js'
import { sanitizeTerminalText } from './sanitize.js'
import { splitGraphemes, terminalCellWidth } from './text-metrics.js'

interface Span extends MarkdownSpan { color?: string; dim?: boolean }
export interface DisplayRow { spans: readonly Span[] }
interface Entry { block: TranscriptBlock; width: number; locale: Locale; rows: readonly DisplayRow[]; parser: StreamingMarkdown }
export interface TranscriptAnchor { blockId: string; row: number }
export interface TranscriptLayout { entries: readonly Entry[]; total: number }
export interface TranscriptPage {
  rows: readonly DisplayRow[]
  start: number
  above: number
  below: number
  capacity: number
  maximum: number
}

/** Cache retained blocks, not historical versions or an unbounded stream of frames. */
export class TranscriptLayoutCache {
  private entries = new Map<string, Entry>()
  private lines = new WeakMap<MarkdownLine, { width: number; rows: readonly DisplayRow[] }>()

  prepare(blocks: readonly TranscriptBlock[], width: number, locale: Locale): TranscriptLayout {
    const retained = new Map<string, Entry>()
    let total = 0
    for (const block of blocks) {
      let entry = this.entries.get(block.id)
      if (entry?.block !== block || entry.width !== width || entry.locale !== locale) {
        const parser = entry?.parser ?? new StreamingMarkdown()
        entry = { block, width, locale, parser, rows: this.blockRows(block, width, locale, parser) }
      }
      retained.set(block.id, entry)
      total += entry.rows.length
    }
    this.entries = retained
    return { entries: [...retained.values()], total }
  }

  private blockRows(block: TranscriptBlock, width: number, locale: Locale, parser: StreamingMarkdown): readonly DisplayRow[] {
    const framed = block.kind === 'tool' || block.kind === 'agent'
    const inner = Math.max(1, width - (framed ? 4 : 0))
    const color = block.state === 'error' || block.kind === 'error' ? 'red'
      : block.kind === 'assistant' || block.kind === 'user' ? undefined : block.state === 'running' ? 'cyan' : block.state === 'success' ? 'green' : undefined
    const rows = wrapSpans([{ text: blockHeaderText(block, locale), bold: true, color }], inner)
    const text = foldTerminalText(retainedTranscriptField(block.text, block.textDroppedChars), block.foldable === true, inner)
    if (text) {
      if (block.kind === 'assistant' && looksLikeMarkdown(text)) {
        for (const line of parser.parse(text)) {
          let cached = this.lines.get(line)
          if (cached?.width !== inner) {
            cached = { width: inner, rows: markdownRows(line, inner) }
            this.lines.set(line, cached)
          }
          for (const row of cached.rows) rows.push(row)
        }
      } else for (const row of wrapSpans([{ text }], inner)) rows.push(row)
    }
    if (block.detail) {
      for (const row of wrapSpans([{ dim: true,
        text: foldTerminalText(retainedTranscriptField(block.detail, block.detailDroppedChars), true, inner) }], inner)) rows.push(row)
    }
    if (!framed) return [...rows, { spans: [] }]
    return [
      { spans: [{ text: `╭${'─'.repeat(Math.max(0, width - 2))}╮`, color }] },
      ...rows.map(row => ({ spans: [{ text: '│ ', color }, ...row.spans,
        { text: `${' '.repeat(Math.max(0, inner - rowWidth(row)))} │`, color }] })),
      { spans: [{ text: `╰${'─'.repeat(Math.max(0, width - 2))}╯`, color }] },
      { spans: [] },
    ]
  }
}

function rowWidth(row: DisplayRow): number { return row.spans.reduce((sum, span) => sum + terminalCellWidth(span.text), 0) }

/** Prewrap at grapheme boundaries; Ink receives exactly one physical row per Text. */
function wrapSpans(spans: readonly Span[], width: number): DisplayRow[] {
  const rows: DisplayRow[] = []
  let current: Span[] = []; let used = 0
  const flush = () => { rows.push({ spans: current }); current = []; used = 0 }
  for (const span of spans) {
    let piece = ''
    const commit = () => { if (piece) current.push({ ...span, text: piece }); piece = '' }
    for (const token of span.text.replaceAll('\t', '    ').match(/\n|[^\S\n]+|[^\s]+/gu) ?? []) {
      const tokenWidth = terminalCellWidth(token)
      if (/\S/u.test(token) && tokenWidth <= width && used > 0 && used + tokenWidth > width) { commit(); flush() }
      for (const grapheme of splitGraphemes(token)) {
        if (grapheme === '\n') { commit(); flush(); continue }
        const cells = terminalCellWidth(grapheme)
        if (used > 0 && used + cells > width) { commit(); flush() }
        piece += grapheme; used += cells
      }
    }
    commit()
  }
  flush()
  return rows
}

function markdownRows(line: MarkdownLine, width: number): DisplayRow[] {
  switch (line.kind) {
    case 'blank': return [{ spans: [] }]
    case 'rule': return [{ spans: [{ text: '─'.repeat(Math.min(width, 80)), dim: true }] }]
    case 'heading': return wrapSpans([{ text: `${'#'.repeat(line.level)} `, bold: true, color: 'cyan' },
      ...line.spans.map(span => ({ ...span, bold: true, color: 'cyan' }))], width)
    case 'quote': return wrapSpans([{ text: '│ ', dim: true }, ...line.spans.map(span => ({ ...span, dim: true }))], width)
    case 'bullet': return wrapSpans([{ text: `${' '.repeat(Math.min(line.indent, 8))}${line.marker} ` }, ...line.spans], width)
    case 'text': return wrapSpans([{ text: ' '.repeat(Math.min(line.indent, 8)) }, ...line.spans], width)
    case 'code': return line.text.split('\n').flatMap(text => wrapSpans([{ text: `  ${text}`, color: 'yellow', dim: true }], width))
    case 'table': {
      const widths = tableColumnWidths(line.rows)
      const fits = widths.reduce((sum, value) => sum + value, 0) + Math.max(0, widths.length - 1) * 2 <= width
      return line.rows.flatMap((row, index) => {
        if (fits) return wrapSpans([{ text: row.map((cell, column) => {
          const text = spanText(cell)
          return text + ' '.repeat(Math.max(0, (widths[column] ?? 0) - terminalCellWidth(text)))
        }).join('  '), bold: index < line.headerRows }], width)
        // A wide table becomes labeled fields, so no cell is silently truncated.
        if (index < line.headerRows) return []
        return [...row.flatMap((cell, column) => wrapSpans([
          { text: `${spanText(line.rows[0]?.[column] ?? [])}: `, bold: true }, ...cell,
        ], width)), { spans: [] }]
      })
    }
  }
}

export function transcriptAnchor(layout: TranscriptLayout, row: number): TranscriptAnchor | undefined {
  let remaining = row
  for (const entry of layout.entries) {
    if (remaining < entry.rows.length) return { blockId: entry.block.id, row: Math.max(0, remaining) }
    remaining -= entry.rows.length
  }
  return undefined
}

export function selectTranscriptPage(layout: TranscriptLayout, height: number, anchor?: TranscriptAnchor): TranscriptPage {
  const capacity = Math.max(1, height - (layout.total > height ? 1 : 0))
  const maximum = Math.max(0, layout.total - capacity)
  let start = maximum
  if (anchor) {
    start = 0
    for (const entry of layout.entries) {
      if (entry.block.id === anchor.blockId) { start += Math.min(anchor.row, entry.rows.length - 1); break }
      start += entry.rows.length
    }
    // If retention removed the anchor, stay at the oldest retained content.
    if (start >= layout.total) start = 0
    start = Math.min(start, maximum)
  }
  const rows: DisplayRow[] = []
  let offset = 0
  for (const entry of layout.entries) {
    const from = Math.max(0, start - offset)
    const to = Math.min(entry.rows.length, start + capacity - offset)
    if (to > from) rows.push(...entry.rows.slice(from, to))
    offset += entry.rows.length
    if (offset >= start + capacity) break
  }
  return { rows, start, above: start, below: Math.max(0, layout.total - start - rows.length), capacity, maximum }
}

export const TranscriptRows = memo(function TranscriptRows({ rows }: { rows: readonly DisplayRow[] }) {
  return <Box flexDirection="column" flexShrink={0}>
    {rows.map((row, index) => <Text key={index} wrap="truncate">
      {row.spans.length === 0 ? ' ' : row.spans.map((span, part) => <Text key={part}
        bold={span.bold} italic={span.italic} dimColor={span.dim} color={span.code ? 'yellow' : span.color}>
        {sanitizeTerminalText(span.text)}
      </Text>)}
    </Text>)}
  </Box>
})
