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
    state = reduceTerminalEvent(state, { sequence: 0, kind: 'assistant-delta', sessionId: 's', text: 'hel' }, host, 'activity-1')
    state = reduceTerminalEvent(state, { sequence: 1, kind: 'assistant-delta', sessionId: 's', text: 'lo' }, host, 'activity-1')
    expect(state.blocks).toMatchObject([{ id: 'assistant-activity-1', kind: 'assistant', text: 'hello', state: 'running' }])

    state = reduceTerminalEvent(state, { sequence: 2, kind: 'assistant-message', sessionId: 's', text: 'hello' }, host, 'activity-1')
    expect(state.blocks).toMatchObject([{ id: 'assistant-activity-1', kind: 'assistant', text: 'hello', state: 'success' }])
  })

  it('preserves multiple assistant turns that share one Harness session', () => {
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    state = reduceTerminalEvent(state, { sequence: 0, kind: 'assistant-message', sessionId: 'same-session', text: 'first' }, host, 'activity-1')
    state = reduceTerminalEvent(state, { sequence: 0, kind: 'assistant-message', sessionId: 'same-session', text: 'second' }, host, 'activity-2')

    expect(state.blocks).toMatchObject([
      { id: 'assistant-activity-1', sessionId: 'same-session', text: 'first' },
      { id: 'assistant-activity-2', sessionId: 'same-session', text: 'second' },
    ])
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
    }, host, 'activity-1')
    state = reduceTerminalEvent(state, {
      sequence: 1,
      kind: 'tool-result',
      sessionId: 's',
      callId: 'c',
      text: 'content',
      isError: false,
    }, host, 'activity-1')
    expect(state.blocks[0]).toMatchObject({
      id: 'tool-activity-1-c',
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
    const quiet = reduceTerminalEvent(initialTerminalTranscript(), event, host, 'activity-1', false)
    const debug = reduceTerminalEvent(initialTerminalTranscript(), event, host, 'activity-1', true)
    expect(quiet.blocks).toHaveLength(0)
    expect(quiet.unknownEventCount).toBe(1)
    expect(debug.blocks[0]).toMatchObject({ kind: 'debug', title: 'unknown event' })
  })
})
