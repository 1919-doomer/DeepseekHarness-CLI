import { describe, expect, it } from 'vitest'
import {
  cropTerminalText,
  deleteGraphemeBefore,
  graphemeCount,
  insertAtGrapheme,
  splitGraphemes,
  terminalCellWidth,
  wrappedTerminalRows,
} from '../../src/terminal/text-metrics.js'

describe('terminal grapheme editing', () => {
  it('deletes astral emoji as one editing unit', () => {
    expect(graphemeCount('😀')).toBe(1)
    expect(deleteGraphemeBefore('😀', 1)).toEqual({ value: '', cursor: 0 })
  })

  it('moves insertion points between graphemes rather than surrogate halves', () => {
    const value = 'A😀B'
    expect(splitGraphemes(value)).toEqual(['A', '😀', 'B'])
    expect(insertAtGrapheme(value, 2, 'X')).toEqual({ value: 'A😀XB', cursor: 3 })
  })

  it('treats ZWJ, combining, skin-tone and flag sequences as single graphemes', () => {
    for (const value of ['👨‍👩‍👧‍👦', 'e\u0301', '👍🏽', '🇨🇳']) {
      expect(graphemeCount(value)).toBe(1)
      expect(deleteGraphemeBefore(value, 1)).toEqual({ value: '', cursor: 0 })
    }
  })

  it('never creates lone surrogate code units while editing emoji', () => {
    const inserted = insertAtGrapheme('😀', 0, '中')
    const deleted = deleteGraphemeBefore(inserted.value, inserted.cursor)
    expect(deleted.value).toBe('😀')
    expect(hasLoneSurrogate(inserted.value)).toBe(false)
    expect(hasLoneSurrogate(deleted.value)).toBe(false)
  })
})

describe('terminal display-cell metrics', () => {
  it('counts ASCII, CJK, emoji and combining sequences by terminal cells', () => {
    expect(terminalCellWidth('abc')).toBe(3)
    expect(terminalCellWidth('中文')).toBe(4)
    expect(terminalCellWidth('😀')).toBe(2)
    expect(terminalCellWidth('e\u0301')).toBe(1)
    expect(terminalCellWidth('👨‍👩‍👧‍👦')).toBe(2)
  })

  it('crops only on grapheme boundaries within the cell budget', () => {
    const cropped = cropTerminalText('ab中文😀tail', 8)
    expect(terminalCellWidth(cropped)).toBeLessThanOrEqual(8)
    expect(hasLoneSurrogate(cropped)).toBe(false)
    expect(cropped.endsWith('…')).toBe(true)
  })

  it('estimates wrapped rows using terminal cells and explicit newlines', () => {
    expect(wrappedTerminalRows('中文ab', 4)).toBe(2)
    expect(wrappedTerminalRows('😀😀', 4)).toBe(1)
    expect(wrappedTerminalRows('a\n中', 4)).toBe(2)
  })
})

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}
