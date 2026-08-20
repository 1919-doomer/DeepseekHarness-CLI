import { describe, expect, it } from 'vitest'
import { PlainRenderer } from '../../src/terminal/plain-renderer.js'
import type { NormalizedEvent } from '../../src/session/projection.js'

class BufferSink {
  value = ''
  write(text: string): void {
    this.value += text
  }
}

function render(
  events: NormalizedEvent[],
  options: { debugUnknownEvents?: boolean; rootSessionId?: string } = {},
): string {
  const sink = new BufferSink()
  const renderer = new PlainRenderer({ output: sink, ...options })
  for (const event of events) renderer.render(event)
  renderer.finish()
  return sink.value
}

describe('PlainRenderer', () => {
  it('streams visible text and does not duplicate the committed message', () => {
    const output = render([
      { sequence: 0, kind: 'assistant-delta', sessionId: 'root', text: 'hel' },
      { sequence: 1, kind: 'assistant-delta', sessionId: 'root', text: 'lo' },
      { sequence: 2, kind: 'assistant-message', sessionId: 'root', text: 'hello' },
    ], { rootSessionId: 'root' })
    expect(output).toBe('assistant> hello\n')
  })

  it('retains streamed-prefix accounting when non-assistant activity breaks the display line', () => {
    const output = render([
      { sequence: 0, kind: 'assistant-delta', sessionId: 'root', text: 'hel' },
      { sequence: 1, kind: 'tool-call', sessionId: 'root', callId: 'c1', name: 'read', arguments: '{}' },
      { sequence: 2, kind: 'tool-result', sessionId: 'root', callId: 'c1', text: 'ok', isError: false },
      { sequence: 3, kind: 'assistant-delta', sessionId: 'root', text: 'lo' },
      { sequence: 4, kind: 'assistant-message', sessionId: 'root', text: 'hello' },
    ], { rootSessionId: 'root' })
    expect(output).toBe('assistant> hel\ntool> read (c1) {}\ntool< c1 ok\nassistant> lo\n')
    expect(output).not.toContain('assistant(committed)>')
  })

  it('keeps interleaved root and descendant streams independent and labels descendant output', () => {
    const output = render([
      { sequence: 0, kind: 'assistant-delta', sessionId: 'root', text: 'ro' },
      { sequence: 1, kind: 'assistant-delta', sessionId: 'child-123456789', text: 'chi' },
      { sequence: 2, kind: 'assistant-delta', sessionId: 'root', text: 'ot' },
      { sequence: 3, kind: 'assistant-message', sessionId: 'child-123456789', text: 'child' },
      { sequence: 4, kind: 'assistant-message', sessionId: 'root', text: 'root' },
    ], { rootSessionId: 'root' })

    expect(output).toBe(
      'assistant> ro\n'
      + 'assistant[child-123456]> chi\n'
      + 'assistant> ot\n'
      + 'assistant[child-123456]> ld\n',
    )
    expect(output).not.toContain('assistant(committed)>')
  })

  it('sanitizes untrusted tool and assistant content', () => {
    const output = render([
      { sequence: 0, kind: 'tool-call', sessionId: 's', callId: 'c1', name: 'read\u001b[31m', arguments: '{}' },
      { sequence: 1, kind: 'assistant-message', sessionId: 's', text: 'ok\u001b]52;c;bad\u0007' },
    ], { rootSessionId: 's' })
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
    expect(render([event], { rootSessionId: 's' })).toBe('')
    expect(render([event], { debugUnknownEvents: true, rootSessionId: 's' }))
      .toContain('debug> unknown session.event/plugin/new [s]')
  })
})
