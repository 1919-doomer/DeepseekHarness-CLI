import { describe, expect, it } from 'vitest'
import type { TranscriptBlock } from '../../src/plugins/api.js'
import { foldTerminalText, takeVisibleBlocks } from '../../src/terminal/product.js'
import { terminalCellWidth } from '../../src/terminal/text-metrics.js'

describe('M3 terminal layout', () => {
  it('folds large output visibly instead of silently dropping it', () => {
    const source = `head-${'x'.repeat(1_600)}-tail\u001b[31m`
    const folded = foldTerminalText(source, true, 40, 600)
    expect(folded).toContain('characters folded; content retained in this terminal process')
    expect(folded).toContain('head-')
    expect(folded).toContain('-tail')
    expect(folded).not.toContain('\u001b')
    expect(folded).toContain('\\x1b[31m')
  })

  it('uses terminal-cell budgets for CJK/emoji folding without splitting graphemes', () => {
    const source = `${'中文'.repeat(250)}${'😀'.repeat(100)}`
    const folded = foldTerminalText(source, true, 24, 300)
    expect(folded).toContain('characters folded; content retained in this terminal process')
    expect(folded).not.toContain('\uFFFD')
    for (const line of folded.split('\n')) {
      if (!line.startsWith('… ')) expect(terminalCellWidth(line)).toBeLessThanOrEqual(300)
    }
  })

  it('does not fold normal assistant text or non-foldable blocks', () => {
    expect(foldTerminalText('short', true, 20, 600)).toBe('short')
    expect(foldTerminalText('x'.repeat(800), false, 20, 600)).toHaveLength(800)
  })

  it('keeps the newest transcript activity when the terminal is narrow or short', () => {
    const blocks: TranscriptBlock[] = Array.from({ length: 8 }, (_, index) => ({
      id: `b-${index}`,
      kind: 'assistant',
      text: index === 7 ? '中文😀'.repeat(12) : `message ${index}`,
    }))
    const visible = takeVisibleBlocks(blocks, 5, 16)
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.at(-1)?.id).toBe('b-7')
    expect(visible.length).toBeLessThan(blocks.length)
  })
})
