import { describe, expect, it } from 'vitest'
import {
  looksLikeMarkdown,
  parseMarkdown,
  parseSpans,
  spanText,
  tableColumnWidths,
} from '../../src/terminal/markdown.js'
import { menuWindow } from '../../src/terminal/product.js'

describe('inline markdown', () => {
  it('reads bold, italic and inline code', () => {
    expect(parseSpans('a **b** c')).toEqual([
      { text: 'a ' }, { text: 'b', bold: true }, { text: ' c' },
    ])
    expect(parseSpans('*it*')).toEqual([{ text: 'it', italic: true }])
    expect(parseSpans('use `npm ci`')).toEqual([
      { text: 'use ' }, { text: 'npm ci', code: true },
    ])
  })

  it('never re-scans the inside of inline code', () => {
    // Quoting a snippet is a request to leave it alone; emphasis inside it
    // would silently change what the reader is told to type.
    expect(parseSpans('`a * b ** c`')).toEqual([{ text: 'a * b ** c', code: true }])
  })

  it('leaves snake_case alone', () => {
    expect(spanText(parseSpans('call read_image_now'))).toBe('call read_image_now')
    expect(parseSpans('call read_image_now').some(span => span.italic === true)).toBe(false)
  })

  it('honours a backslash escape', () => {
    expect(parseSpans(String.raw`literal \*stars\*`)).toEqual([{ text: 'literal *stars*' }])
  })

  it('leaves an unclosed marker as text rather than eating the rest', () => {
    expect(spanText(parseSpans('2 * 3 = 6'))).toBe('2 * 3 = 6')
    expect(spanText(parseSpans('an **unclosed run'))).toBe('an **unclosed run')
  })

  it('adds nothing to the text it was given', () => {
    // The parser only removes markers it consumed; it must never introduce a
    // character. Escapes are the sanitizer's job, upstream of here, and this
    // renderer must not become a way to put them back — every style it applies
    // is an Ink prop, never a byte in the string.
    for (const source of [
      'a **b** c `d` *e*',
      'plain prose with no markers at all',
      '2 * 3 = 6 and a_b_c',
      `text with ${String.fromCharCode(27)}[31m in the middle`,
    ]) {
      const parsed = parseSpans(source)
      for (const span of parsed) expect(source).toContain(span.text)
      expect(spanText(parsed).length).toBeLessThanOrEqual(source.length)
    }
  })
})

describe('block markdown', () => {
  it('reads headings, bullets, quotes and rules', () => {
    const lines = parseMarkdown([
      '## Title',
      '- one',
      '2. two',
      '> quoted',
      '---',
    ].join('\n'))
    expect(lines.map(line => line.kind)).toEqual(['heading', 'bullet', 'bullet', 'quote', 'rule'])
    expect(lines[0]).toMatchObject({ level: 2 })
    expect(lines[1]).toMatchObject({ marker: '•' })
    expect(lines[2]).toMatchObject({ marker: '2.' })
  })

  it('keeps a fenced block verbatim, markers and all', () => {
    const lines = parseMarkdown(['```ts', 'const a = **b**', '```'].join('\n'))
    expect(lines).toEqual([{ kind: 'code', text: 'const a = **b**', language: 'ts' }])
  })

  it('runs an unterminated fence to the end instead of losing the content', () => {
    const lines = parseMarkdown(['```', 'still mine'].join('\n'))
    expect(lines).toEqual([{ kind: 'code', text: 'still mine' }])
  })

  it('needs a divider before it will call something a table', () => {
    const table = parseMarkdown(['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n'))
    expect(table[0]?.kind).toBe('table')
    // A sentence containing a pipe is a sentence.
    const prose = parseMarkdown('run a | b to pipe it')
    expect(prose[0]?.kind).toBe('text')
  })

  it('measures table columns in terminal cells, not characters', () => {
    // Eight CJK characters occupy sixteen columns; padding by string length
    // would leave the second column ragged.
    const table = parseMarkdown(['| 中文标题 | b |', '| - | - |', '| x | y |'].join('\n'))
    if (table[0]?.kind !== 'table') throw new Error('expected a table')
    expect(tableColumnWidths(table[0].rows)[0]).toBe(8)
  })

  it('recognises prose that is not markdown, so it is left alone', () => {
    expect(looksLikeMarkdown('just a sentence with an * in it')).toBe(false)
    expect(looksLikeMarkdown('## heading')).toBe(true)
    expect(looksLikeMarkdown('- item')).toBe(true)
    expect(looksLikeMarkdown('a **bold** word')).toBe(true)
    expect(looksLikeMarkdown('use `code`')).toBe(true)
  })
})

describe('slash menu window', () => {
  it('shows everything when it all fits', () => {
    expect(menuWindow(3, 8, 0)).toEqual({ offset: 0, shown: 3, above: 0, below: 3 - 3 })
  })

  it('follows the selection past the fold instead of truncating', () => {
    // Before this the menu stopped at the capacity and printed "… N more",
    // so an entry below the fold could be counted but never reached.
    const window = menuWindow(20, 5, 12)
    expect(window.shown).toBe(5)
    expect(window.offset).toBe(8)
    expect(window.above).toBe(8)
    expect(window.below).toBe(7)
  })

  it('stops at the ends rather than scrolling past them', () => {
    expect(menuWindow(20, 5, 0).offset).toBe(0)
    expect(menuWindow(20, 5, 19)).toMatchObject({ offset: 15, below: 0 })
  })

  it('survives a viewport with no room at all', () => {
    expect(menuWindow(20, 0, 4)).toEqual({ offset: 0, shown: 0, above: 0, below: 0 })
  })
})
