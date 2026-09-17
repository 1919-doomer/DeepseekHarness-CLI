import { expect, it } from 'vitest'
import { AgentWindowFormatter } from '../../runtime/agent-window-format.mjs'
import { terminalCellWidth } from '../../src/terminal/text-metrics.ts'

// eslint-disable-next-line no-control-regex -- Measure visible cells after stripping our renderer's SGR styling.
const strip = text => text.replace(/\x1b\[[0-9;]*m/g, '')
it('keeps CJK and emoji card borders aligned across widths and resize', () => {
  let columns = 42
  const renderer = new AgentWindowFormatter({ columns: () => columns, color: true, zh: true })
  for (columns of [42, 24, 100]) {
    const card = renderer.entry({ kind: 'call', title: 'read', text: JSON.stringify({ file_path: 'C:\\项目\\示例😀.txt', content: '中文与 English 混排 '.repeat(15) }) })
    expect(card).toContain('\x1b[38;2;103;198;211m')
    const lines = strip(card).trimEnd().split('\n').filter(Boolean)
    expect(new Set(lines.map(terminalCellWidth))).toEqual(new Set([columns - 1]))
    expect(card).not.toContain('"file_path"')
  }
})
it('contains terminal escapes, discloses clipping and keeps narrow/plain output readable', () => {
  const renderer = new AgentWindowFormatter({ columns: () => 40, color: false, zh: true })
  const card = renderer.entry({ kind: 'error', title: '\x1b[31merror', text: '出错内容\x1b]52;c;abc\x07\n'.repeat(40) })
  expect(card).not.toContain('\x1b')
  expect(card).toContain('/trace')
  expect(card).toContain('失败')
  const tiny = new AgentWindowFormatter({ columns: () => 12 })
  expect(tiny.header('hello')).toContain('hello')
  expect(tiny.header('hello')).not.toContain('╭')
})
it('formats filesystem envelopes and keeps a single heading across streamed increments', () => {
  const renderer = new AgentWindowFormatter({ zh: true })
  const result = renderer.entry({ kind: 'result', title: 'read', text: '<path>C:\\项目\\test.txt</path>\n<type>file</type>\n<content>\n1: hello\n</content>' })
  expect(result).toContain('路径')
  expect(result).toContain('1: hello')
  expect(result).not.toContain('<content>')
  const first = renderer.entry({ kind: 'delta', text: '正在' })
  const second = renderer.entry({ kind: 'delta', text: '检查' })
  expect(first).toContain('● Agent')
  expect(second).toBe('检查')
  expect(renderer.entry({ kind: 'message-end', text: '' })).toBe('\n')
})
