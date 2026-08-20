import { describe, expect, it } from 'vitest'
import { PlainRenderer } from '../../src/terminal/plain-renderer.js'
import type { NormalizedEvent } from '../../src/session/projection.js'

class BufferSink {
  value = ''
  write(text: string): void {
    this.value += text
  }
}

function render(events: NormalizedEvent[], debugUnknownEvents = false): string {
  const sink = new BufferSink()
  const renderer = new PlainRenderer({ output: sink, debugUnknownEvents })
  for (const event of events) renderer.render(event)
  renderer.finish()
  return sink.value
}

describe('PlainRenderer', () => {
  it('streams visible text and does not duplicate the committed message', () => {
    const output = render([
      { sequence: 0, kind: 'assistant-delta', sessionId: 's', text: 'hel' },
      { sequence: 1, kind: 'assistant-delta', sessionId: 's', text: 'lo' },
      { sequence: 2, kind: 'assistant-message', sessionId: 's', text: 'hello' },
    ])
    expect(output).toBe('assistant> hello\n')
  })

  it('sanitizes untrusted tool and assistant content', () => {
    const output = render([
      { sequence: 0, kind: 'tool-call', sessionId: 's', callId: 'c1', name: 'read\u001b[31m', arguments: '{}' },
      { sequence: 1, kind: 'assistant-message', sessionId: 's', text: 'ok\u001b]52;c;bad\u0007' },
    ])
    expect(output).not.toContain('\u001b')
    expect(output).toContain('read\\x1b[31m')
    expect(output).toContain('ok\\x1b]52;c;bad\\x07')
  })

  it('shows unknown vocabulary only in debug mode', () => {
    const event: NormalizedEvent = {
      sequence: 0,
      kind: 'unknown',
      sessionId: 's',
      method: 'session.event',
      type: 'plugin/new',
    }
    expect(render([event])).toBe('')
    expect(render([event], true)).toContain('debug> unknown session.event/plugin/new')
  })
})
