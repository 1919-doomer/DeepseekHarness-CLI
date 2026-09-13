import { memo, useMemo, useRef, useState } from 'react'
import { StreamingMarkdown } from './streaming-markdown.js'
import { Box, Text, useInput } from 'ink'
import { translate, uiLabel, type Locale } from '../i18n.js'
import { retainedTranscriptField } from './transcript.js'
import type { TranscriptBlock } from '../plugins/api.js'
import { sanitizeTerminalText } from './sanitize.js'
import { cropTerminalText, graphemeCount, prefixByCells, suffixByCells, terminalCellWidth, wrappedTerminalRows, wrapTerminalLines } from './text-metrics.js'
import { looksLikeMarkdown, parseMarkdown, spanText, tableColumnWidths, type MarkdownLine, type MarkdownSpan } from './markdown.js'
export const DEFAULT_FOLD_LIMIT = 1200

export const TranscriptBlockView = memo(function TranscriptBlockView({ block, width, condensed = false, locale = 'en' }: {
  block: TranscriptBlock
  width: number
  condensed?: boolean
  locale?: Locale
}): React.ReactElement {
  const status = blockStatus(block)
  const header = blockHeaderText(block, locale)
  // While reviewing older context, a tool call collapses to its header: the
  // outcome is what you are scanning for, and its arguments and output would
  // push the prose you are actually looking for off the screen.
  const collapsed = condensed && isActivityBlock(block)
  // Tool and subagent activity is framed so a call is a distinct object on the
  // screen rather than another paragraph. Prose keeps flowing unframed: boxing
  // an assistant answer would cost two columns and gain nothing.
  const framed = isActivityBlock(block) && !collapsed
  const bodyWidth = framed ? Math.max(10, width - 4) : width
  const text = retainedTranscriptField(block.text, block.textDroppedChars)
  const detail = block.detail === undefined ? '' : retainedTranscriptField(block.detail, block.detailDroppedChars)
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      marginBottom={1}
      {...(framed
        ? { borderStyle: 'round' as const, borderColor: status.color, paddingX: 1 }
        : {})}
    >
      {/* One Text node, one row. Nesting Text inside Text made Ink lay the
          header and the body on the same row, so the colour applies to the
          whole header line instead. */}
      <Text bold={block.kind === 'user' || block.kind === 'assistant'} color={status.color}>{header}</Text>
      {!collapsed && block.text.length > 0 && (
        // Prose is rendered as markdown; tool output is not. A tool result is
        // program output, and a log line containing an asterisk must survive
        // exactly as the program wrote it.
        block.kind === 'assistant' && looksLikeMarkdown(block.text)
          ? <MarkdownBody block={block} text={foldTerminalText(text, block.foldable === true, bodyWidth)} width={bodyWidth} />
          : <Text wrap="wrap">{foldTerminalText(text, block.foldable === true, bodyWidth)}</Text>
      )}
      {!collapsed && detail.length > 0 && <Text dimColor wrap="wrap">{foldTerminalText(detail, true, bodyWidth)}</Text>}
    </Box>
  )
})

/**
 * Draw parsed markdown with Ink props only.
 *
 * Every style here is a prop on a `<Text>` element. Nothing in this component,
 * or in the parser behind it, may emit an escape sequence: the sanitizer strips
 * those out of upstream text precisely so they cannot reach the terminal, and
 * re-introducing them on the rendering side would reopen that hole.
 */
const completedMarkdown = new WeakMap<TranscriptBlock, { width: number; text: string; lines: readonly MarkdownLine[] }>()
function MarkdownBody({ block, text, width }: { block: TranscriptBlock; text: string; width: number }): React.ReactElement {
  const streaming = useRef(new StreamingMarkdown())
  const lines = useMemo(() => {
    if (block.state === 'running') return streaming.current.parse(text)
    const cached = completedMarkdown.get(block)
    if (cached?.width === width && cached.text === text) return cached.lines
    const lines = parseMarkdown(text)
    completedMarkdown.set(block, { width, text, lines })
    return lines
  }, [block, text, width])
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((line, index) => (
        <Box key={index} flexShrink={0}>
          <MarkdownLineView line={line} width={width} />
        </Box>
      ))}
    </Box>
  )
}

function MarkdownLineView({ line, width }: { line: MarkdownLine; width: number }): React.ReactElement {
  switch (line.kind) {
    case 'blank':
      return <Text> </Text>
    case 'rule':
      return <Text dimColor>{'─'.repeat(Math.max(1, Math.min(width, 80)))}</Text>
    case 'heading':
      // Level is carried by the prefix as well as the weight, so the structure
      // survives a monochrome terminal.
      return (
        <Text bold color="cyan" wrap="wrap">
          {`${'#'.repeat(line.level)} `}
          <Spans spans={line.spans} />
        </Text>
      )
    case 'quote':
      return (
        <Text dimColor wrap="wrap">
          {'│ '}
          <Spans spans={line.spans} />
        </Text>
      )
    case 'bullet':
      return (
        <Text wrap="wrap">
          {`${' '.repeat(Math.min(line.indent, 8))}${line.marker} `}
          <Spans spans={line.spans} />
        </Text>
      )
    case 'code':
      return (
        <Box flexDirection="column" flexShrink={0} paddingLeft={2}>
          {line.text.split('\n').map((row, index) => (
            <Text key={index} color="yellow" dimColor wrap="wrap">{row.length === 0 ? ' ' : row}</Text>
          ))}
        </Box>
      )
    case 'table':
      return <MarkdownTable rows={line.rows} headerRows={line.headerRows} width={width} />
    case 'text':
      return (
        <Text wrap="wrap">
          {' '.repeat(Math.min(line.indent, 8))}
          <Spans spans={line.spans} />
        </Text>
      )
  }
}

function MarkdownTable({ rows, headerRows, width }: {
  rows: readonly (readonly (readonly MarkdownSpan[])[])[]
  headerRows: number
  width: number
}): React.ReactElement {
  const widths = tableColumnWidths(rows)
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((row, rowIndex) => (
        <Text key={rowIndex} bold={rowIndex < headerRows} wrap="truncate">
          {cropTerminalText(
            row
              .map((cell, column) => padToCells(spanText(cell), widths[column] ?? 0))
              .join('  '),
            Math.max(10, width),
          )}
        </Text>
      ))}
    </Box>
  )
}

/**
 * Inline spans inside one parent Text. Emphasis inside a table cell is dropped
 * rather than rendered, because a cell has to be padded to a measured width and
 * a nested element cannot be padded without guessing where it breaks.
 */
function Spans({ spans }: { spans: readonly MarkdownSpan[] }): React.ReactElement {
  return (
    <>
      {spans.map((span, index) => (
        <Text
          key={index}
          bold={span.bold === true}
          italic={span.italic === true}
          {...(span.code === true ? { color: 'yellow' as const } : {})}
        >{span.text}</Text>
      ))}
    </>
  )
}

/** Pad to a cell count rather than a character count, so CJK columns line up. */
function padToCells(value: string, cells: number): string {
  const missing = Math.max(0, cells - terminalCellWidth(value))
  return `${value}${' '.repeat(missing)}`
}

/**
 * Outcome is carried by a glyph *and* a word, never by colour alone: the
 * transcript has to stay correct on a monochrome terminal and for a reader who
 * cannot distinguish the colours.
 */
function blockStatus(block: TranscriptBlock): { marker: string; color?: string } {
  switch (block.state) {
    case 'running': return { marker: '▸', color: 'cyan' }
    case 'success': return { marker: '✓', color: 'green' }
    case 'error': return { marker: '✗', color: 'red' }
    case 'finished': return { marker: '•' }
    default: break
  }
  if (block.kind === 'error') return { marker: '!', color: 'red' }
  return { marker: kindMarker(block.kind) }
}

function kindMarker(kind: TranscriptBlock['kind']): string {
  switch (kind) {
    case 'user': return '›'
    case 'assistant': return '◆'
    case 'tool': return '⚙'
    case 'agent': return '◇'
    case 'error': return '!'
    default: return '·'
  }
}

function blockStatusSuffix(block: TranscriptBlock, locale: Locale = 'en'): string {
  const state = block.state === undefined ? '' : ` · ${uiLabel(locale, block.state)}`
  const elapsed = blockElapsedMs(block)
  return elapsed === undefined ? state : `${state} · ${formatElapsedMs(elapsed)}`
}

/**
 * Span between the two upstream timestamps bounding the block. Absent when
 * either end is missing or the pair runs backwards, so an unknown span is never
 * rendered as zero.
 */
export function blockElapsedMs(block: TranscriptBlock): number | undefined {
  const { startedAt, endedAt } = block
  if (startedAt === undefined || endedAt === undefined) return undefined
  const elapsed = endedAt - startedAt
  return elapsed >= 0 ? elapsed : undefined
}

export function formatElapsedMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function ViewPanel({ title, text, width, rows, arrowKeys = true }: {
  title: string; text: string; width: number; rows: number; arrowKeys?: boolean
}): React.ReactElement {
  const [offset, setOffset] = useState(0)
  const lines = useMemo(() => wrapTerminalLines(sanitizeTerminalText(text), Math.max(1, width - 4)), [text, width])
  const pageSize = Math.max(1, rows - 4)
  const maximum = Math.max(0, lines.length - pageSize)
  const start = Math.min(offset, maximum)
  useInput((_input, key) => {
    const delta = key.pageDown ? pageSize : key.pageUp ? -pageSize : arrowKeys && key.downArrow ? 1 : arrowKeys && key.upArrow ? -1 : 0
    if (delta !== 0) setOffset(Math.max(0, Math.min(maximum, start + delta)))
  })
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} overflow="hidden">
      <Box flexShrink={0}><Text bold wrap="truncate">{sanitizeTerminalText(title)}</Text></Box>
      <Box flexShrink={0}><Text wrap="wrap">{lines.slice(start, start + pageSize).join('\n')}</Text></Box>
      {maximum > 0 && <Box flexShrink={0}><Text dimColor>{start + 1}–{Math.min(lines.length, start + pageSize)} / {lines.length} · PageUp / PageDown</Text></Box>}
    </Box>
  )
}

export interface VisibleTranscript {
  blocks: readonly TranscriptBlock[]
  /** Blocks below the viewport; zero means the newest activity is shown. */
  below: number
  /** Blocks above the viewport, so the view can say how much is out of sight. */
  above: number
}

/**
 * Choose the blocks that fit, ending `offset` blocks before the newest.
 *
 * `offset` is the scroll position, counted in blocks from the tail rather than
 * in rows, so a scroll step never lands halfway through a block and never
 * depends on the width the last render happened to use.
 */
export function selectVisibleBlocks(
  blocks: readonly TranscriptBlock[],
  rows: number,
  width = 72,
  offset = 0,
  condensed = offset > 0,
): VisibleTranscript {
  const below = Math.max(0, Math.min(offset, Math.max(0, blocks.length - 1)))
  const end = blocks.length - below
  const result: TranscriptBlock[] = []
  let budget = rows
  for (let index = end - 1; index >= 0 && budget > 0; index--) {
    const block = blocks[index]!
    const needed = estimateRows(block, width, condensed)
    // Admitting a block before checking that it fits lets the selection
    // overshoot the frame by almost a whole block. Ink then compresses the
    // children instead of clipping them, and body text lands on top of the
    // header row. The newest visible block is still always shown, because an
    // oversized latest activity must not vanish.
    if (result.length > 0 && needed > budget) break
    result.unshift(block)
    budget -= needed
  }
  return { blocks: result, below, above: Math.max(0, end - result.length) }
}

/** Back-compatible view of {@link selectVisibleBlocks} for the tail. */
export function takeVisibleBlocks(
  blocks: readonly TranscriptBlock[],
  rows: number,
  width = 72,
): readonly TranscriptBlock[] {
  return selectVisibleBlocks(blocks, rows, width).blocks
}

/** Tool and subagent activity, the blocks that collapse while reviewing. */
function isActivityBlock(block: TranscriptBlock): boolean {
  return block.kind === 'tool' || block.kind === 'agent'
}

function estimateRows(block: TranscriptBlock, width: number, condensed = false): number {
  const key = `${width}:${condensed}`
  const cached = rowCache.get(block)
  const rows = cached?.get(key)
  if (rows !== undefined) return rows
  const next = calculateRows(block, width, condensed)
  const entries = cached ?? new Map<string, number>()
  if (entries.size >= 4) entries.clear()
  entries.set(key, next)
  rowCache.set(block, entries)
  return next
}
const rowCache = new WeakMap<TranscriptBlock, Map<string, number>>()
function calculateRows(block: TranscriptBlock, width: number, condensed: boolean): number {
  const collapsed = condensed && isActivityBlock(block)
  // A framed block spends two rows on its border and two columns on padding.
  const framed = isActivityBlock(block) && !collapsed
  const frameRows = framed ? 2 : 0
  const contentWidth = Math.max(10, width - (framed ? 6 : 2))
  if (collapsed) return wrappedTerminalRows(blockHeaderText(block), contentWidth) + 1
  const text = foldTerminalText(retainedTranscriptField(block.text, block.textDroppedChars), block.foldable === true, contentWidth)
  const detail = block.detail === undefined ? '' : foldTerminalText(retainedTranscriptField(block.detail, block.detailDroppedChars), true, contentWidth)
  const textRows = block.text.length === 0 ? 0 : wrappedTerminalRows(text, contentWidth)
  const detailRows = detail.length === 0 ? 0 : wrappedTerminalRows(detail, contentWidth)
  // The header wraps like any other line; budgeting it as exactly one row
  // under-counts a long title and overflows the frame.
  const headerRows = wrappedTerminalRows(blockHeaderText(block), contentWidth)
  return frameRows + headerRows + 1 + Math.max(1, textRows + detailRows)
}

/** The rendered header line, shared by the view and the row estimate. */
export function blockHeaderText(block: TranscriptBlock, locale: Locale = 'en'): string {
  const status = blockStatus(block)
  const dropped = (block.textDroppedChars ?? 0) + (block.detailDroppedChars ?? 0)
  const disclosure = dropped > 0 ? ` · ${translate(locale, 'evictedChars', { count: dropped })}` : ''
  if (block.kind === 'user') return `❯${disclosure}`
  if (block.kind === 'assistant') return `${block.title && block.title !== 'assistant' ? sanitizeTerminalText(block.title) : '主·Agent'}${block.state === 'error' ? blockStatusSuffix(block, locale) : ''}${disclosure}`
  return `${status.marker} ${sanitizeTerminalText(uiLabel(locale, block.title ?? block.kind))}${blockStatusSuffix(block, locale)}${disclosure}`
}

export function foldTerminalText(
  text: string,
  foldable: boolean,
  width: number,
  limit = DEFAULT_FOLD_LIMIT,
): string {
  const safe = sanitizeTerminalText(text)
  const displayUnits = Math.max(terminalCellWidth(safe), graphemeCount(safe))
  if (!foldable || displayUnits <= limit) return safe
  const head = Math.max(240, Math.min(limit - 160, Math.max(20, width) * 8))
  const tail = Math.min(120, Math.max(40, Math.floor(limit / 5)))
  const headText = prefixByCells(safe, head)
  const tailText = suffixByCells(safe, tail)
  const hidden = Math.max(0, graphemeCount(safe) - graphemeCount(headText) - graphemeCount(tailText))
  return `${headText}\n… ${hidden} characters folded; content retained in this terminal process …\n${tailText}`
}
