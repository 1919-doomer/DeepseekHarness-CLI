import { describe, expect, it } from 'vitest'
import { sanitizeTerminalText } from '../../src/terminal/sanitize.js'

describe('sanitizeTerminalText', () => {
  it('neutralizes ANSI, OSC, C0/C1 and bidi controls while keeping normal text', () => {
    const input = `hello\u001b]52;c;clipboard\u0007\nworld\t\u009b31m\u202Eevil`
    expect(sanitizeTerminalText(input)).toBe(
      'hello\\x1b]52;c;clipboard\\x07\nworld\t\\u009b31m\\u202eevil',
    )
  })

  it('keeps ordinary Unicode readable', () => {
    expect(sanitizeTerminalText('中文 · café · λ')).toBe('中文 · café · λ')
  })
})
