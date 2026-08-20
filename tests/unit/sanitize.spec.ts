import { describe, expect, it } from 'vitest'
import { sanitizeTerminalText, stringifyTerminalSafeJson } from '../../src/terminal/sanitize.js'

describe('sanitizeTerminalText', () => {
  it('neutralizes ANSI, OSC, C0/C1 and bidi controls while keeping normal text', () => {
    const input = `hello\u001b]52;c;clipboard\u0007\nworld\t\u009b31m\u061c\u200e\u200f\u202Eevil`
    expect(sanitizeTerminalText(input)).toBe(
      'hello\\x1b]52;c;clipboard\\x07\nworld\t\\u009b31m\\u061c\\u200e\\u200f\\u202eevil',
    )
  })

  it('keeps ordinary Unicode readable', () => {
    expect(sanitizeTerminalText('中文 · café · λ')).toBe('中文 · café · λ')
  })
})

describe('stringifyTerminalSafeJson', () => {
  it('escapes terminal-active controls while preserving parsed JSON values', () => {
    const value = {
      text: `safe\u009b\u061c\u200e\u200f\u202evalue`,
      nested: ['中文', '\u2067rtl\u2069'],
    }
    const serialized = stringifyTerminalSafeJson(value)

    expect(serialized).not.toContain('\u009b')
    expect(serialized).not.toContain('\u061c')
    expect(serialized).not.toContain('\u202e')
    expect(serialized).toContain('\\u009b')
    expect(serialized).toContain('\\u061c')
    expect(serialized).toContain('\\u202e')
    expect(JSON.parse(serialized)).toEqual(value)
  })
})
