import { describe, expect, it } from 'vitest'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
import {
  initialTerminalTranscript,
  reduceTerminalEvent,
} from '../../src/terminal/transcript.js'

describe('M3 terminal transcript', () => {
  it('accumulates assistant streaming and converges to the committed message', () => {
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    state = reduceTerminalEvent(state, { sequence: 0, kind: 'assistant-delta', sessionId: 's', text: 'hel' }, host)
    state = reduceTerminalEvent(state, { sequence: 1, kind: 'assistant-delta', sessionId: 's', text: 'lo' }, host)
    expect(state.blocks).toMatchObject([{ kind: 'assistant', text: 'hello', state: 'running' }])

    state = reduceTerminalEvent(state, { sequence: 2, kind: 'assistant-message', sessionId: 's', text: 'hello' }, host)
    expect(state.blocks).toMatchObject([{ kind: 'assistant', text: 'hello', state: 'success' }])
  })

  it('renders tool calls through the registered specialized renderer and patches results', () => {
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    state = reduceTerminalEvent(state, {
      sequence: 0,
      kind: 'tool-call',
      sessionId: 's',
      callId: 'c',
      name: 'read',
      arguments: '{"path":"README.md"}',
    }, host)
    state = reduceTerminalEvent(state, {
      sequence: 1,
      kind: 'tool-result',
      sessionId: 's',
      callId: 'c',
      text: 'content',
      isError: false,
    }, host)
    expect(state.blocks[0]).toMatchObject({
      id: 'tool-c',
      kind: 'tool',
      title: 'tool · read',
      detail: 'content',
      state: 'success',
      foldable: true,
    })
  })

  it('keeps unknown events silent by default and diagnosable in debug mode', () => {
    const host = createDefaultTerminalHost()
    const event = { sequence: 0, kind: 'unknown' as const, method: 'session.event', type: 'future/event' }
    const quiet = reduceTerminalEvent(initialTerminalTranscript(), event, host, false)
    const debug = reduceTerminalEvent(initialTerminalTranscript(), event, host, true)
    expect(quiet.blocks).toHaveLength(0)
    expect(quiet.unknownEventCount).toBe(1)
    expect(debug.blocks[0]).toMatchObject({ kind: 'debug', title: 'unknown event' })
  })
})
