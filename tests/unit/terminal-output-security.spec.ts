import { describe, expect, it } from 'vitest'
import { PlainRenderer } from '../../src/terminal/plain-renderer.js'
import { stringifyTerminalSafeJson } from '../../src/terminal/sanitize.js'

const OSC = '\u001b]52;c;cGxhaW4tb3duZWQ=\u0007'
const C1 = '\u009b31m'
const BIDI = '\u202e'

describe('plain terminal security boundary', () => {
  it('renders hostile assistant/tool/error content as inert visible text', () => {
    let output = ''
    const renderer = new PlainRenderer({ output: { write: text => { output += text } }, rootSessionId: 'root' })

    renderer.render({ sequence: 0, kind: 'assistant-delta', sessionId: 'root', text: `assistant${OSC}` })
    renderer.render({
      sequence: 1,
      kind: 'tool-call',
      sessionId: 'root',
      callId: `call${C1}`,
      name: `tool${BIDI}`,
      arguments: `{"payload":"${OSC}"}`,
    })
    renderer.render({
      sequence: 2,
      kind: 'turn-error',
      sessionId: 'root',
      message: `error${OSC}${C1}${BIDI}`,
    })
    renderer.finish()

    expect(output).toContain('assistant\\x1b]52;c;cGxhaW4tb3duZWQ=\\x07')
    expect(output).toContain('tool\\u202e')
    expect(output).toContain('call\\u009b31m')
    expect(output).not.toContain(OSC)
    expect(output).not.toContain(C1)
    expect(output).not.toContain(BIDI)
  })
})

describe('machine JSON terminal security boundary', () => {
  it('keeps parsed values exact without emitting attacker terminal controls raw', () => {
    const value = { finalResponse: `assistant${OSC}${C1}${BIDI}`, nested: ['中文', '👨‍👩‍👧‍👦'] }
    const serialized = stringifyTerminalSafeJson(value)

    expect(serialized).not.toContain(OSC)
    expect(serialized).not.toContain(C1)
    expect(serialized).not.toContain(BIDI)
    expect(serialized).toContain('\\u001b]52;c;cGxhaW4tb3duZWQ=\\u0007')
    expect(serialized).toContain('\\u009b')
    expect(serialized).toContain('\\u202e')
    expect(JSON.parse(serialized)).toEqual(value)
  })
})
