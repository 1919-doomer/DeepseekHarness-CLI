import { describe, expect, it } from 'vitest'
import { splitKeystrokes } from '../../src/terminal/product.js'

const plain = {
  ctrl: false, meta: false, escape: false, tab: false, return: false,
  backspace: false, delete: false,
  leftArrow: false, rightArrow: false, upArrow: false, downArrow: false,
}

const CR = '\r'
const LF = '\n'

describe('stdin chunk splitting', () => {
  it('leaves an ordinary keystroke untouched', () => {
    expect(splitKeystrokes('a', plain)).toEqual([{ text: 'a', key: plain }])
  })

  it('recovers a submit that coalesced with the following keystroke', () => {
    // Observed on Windows: the carriage return that submits one command and the
    // next keystroke arrive as one chunk, so `key.return` is false for the whole
    // chunk and the raw control character used to be typed into the prompt.
    const strokes = splitKeystrokes(`${CR}q`, plain)
    expect(strokes.map(stroke => stroke.text)).toEqual([CR, 'q'])
    expect(strokes[0]?.key.return).toBe(true)
    expect(strokes[1]?.key.return).toBe(false)
  })

  it('turns pasted multi-line text into text and submit strokes in order', () => {
    const strokes = splitKeystrokes(`first${LF}second${LF}`, plain)
    expect(strokes.map(stroke => [stroke.text, stroke.key.return])).toEqual([
      ['first', false],
      [LF, true],
      ['second', false],
      [LF, true],
    ])
  })

  it('never emits a raw control character as prompt text', () => {
    for (const stroke of splitKeystrokes(`a${CR}b${LF}c`, plain)) {
      if (stroke.key.return) continue
      expect(stroke.text).not.toContain(CR)
      expect(stroke.text).not.toContain(LF)
    }
  })

  it('does not split a parsed control sequence', () => {
    // Ctrl+J inserts a literal newline; splitting it would submit instead.
    const ctrlJ = { ...plain, ctrl: true }
    expect(splitKeystrokes(LF, ctrlJ)).toEqual([{ text: LF, key: ctrlJ }])

    const arrow = { ...plain, upArrow: true }
    expect(splitKeystrokes('[A', arrow)).toEqual([{ text: '[A', key: arrow }])
  })
})
