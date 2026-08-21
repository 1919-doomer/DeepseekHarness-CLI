import { describe, expect, it } from 'vitest'
import {
  graphemeCount,
  splitGraphemes,
  terminalCellWidth,
  wrappedTerminalRows,
} from '../../src/terminal/text-metrics.js'

/**
 * What a terminal actually does: a wide grapheme is never split across the wrap
 * boundary, so one leftover column is wasted rather than half-filled.
 */
function terminalWrappedRows(value: string, columns: number): number {
  const width = Math.max(1, columns)
  return value.split('\n').reduce((rows, line) => {
    let lineRows = 1
    let used = 0
    for (const grapheme of splitGraphemes(line)) {
      const cells = terminalCellWidth(grapheme)
      if (used > 0 && used + cells > width) {
        lineRows++
        used = cells
        continue
      }
      used += cells
    }
    return rows + lineRows
  }, 0)
}

describe('wrappedTerminalRows', () => {
  it('counts a wide grapheme that cannot straddle the wrap boundary', () => {
    // 81 double-width characters in 81 columns: 40 fit per row with one column
    // wasted, so the real answer is 3. Dividing 162 cells by 81 gives 2, and
    // the missing row is what pushes the frame past the terminal height.
    expect(wrappedTerminalRows('你'.repeat(81), 81)).toBe(3)
  })

  it('never under-counts against real terminal wrapping', () => {
    const samples = [
      '你'.repeat(81),
      '你'.repeat(40),
      '中文内容测试'.repeat(20),
      'a'.repeat(100),
      '| 项目 | 情况 |'.repeat(12),
      'mixed 中英 text with \u{1f468}‍\u{1f469}‍\u{1f467}‍\u{1f466} families',
      'line one\nline two\n你好世界',
      '',
    ]
    for (const sample of samples) {
      for (const columns of [1, 2, 3, 20, 80, 81, 99, 121, 180]) {
        // Under-counting corrupts the frame; over-counting only wastes a row.
        expect(wrappedTerminalRows(sample, columns))
          .toBeGreaterThanOrEqual(terminalWrappedRows(sample, columns))
        expect(wrappedTerminalRows(sample, columns))
          .toBe(terminalWrappedRows(sample, columns))
      }
    }
  })

  it('keeps a grapheme wider than the terminal on a single row', () => {
    expect(wrappedTerminalRows('你', 1)).toBe(1)
    expect(graphemeCount('你')).toBe(1)
  })

  it('still counts every newline-separated line', () => {
    expect(wrappedTerminalRows('a\nb\nc', 80)).toBe(3)
    expect(wrappedTerminalRows('', 80)).toBe(1)
  })
})
