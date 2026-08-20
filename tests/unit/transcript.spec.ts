import { describe, expect, it } from 'vitest'
import { TERMINAL_PLUGIN_API_VERSION } from '../../src/plugins/api.js'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
import { TerminalPluginHost } from '../../src/plugins/host.js'
import {
  initialTerminalTranscript,
  reduceTerminalEvent,
  terminalBlockId,
} from '../../src/terminal/transcript.js'

describe('M3 terminal transcript', () => {
  it('accumulates assistant streaming and converges to the committed message', () => {
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    state = reduceTerminalEvent(state, { sequence: 0, kind: 'assistant-delta', sessionId: 's', text: 'hel' }, host, 'activity-1', 's')
    state = reduceTerminalEvent(state, { sequence: 1, kind: 'assistant-delta', sessionId: 's', text: 'lo' }, host, 'activity-1', 's')
    expect(state.blocks).toMatchObject([{ kind: 'assistant', text: 'hello', state: 'running', sessionId: 's' }])
    state = reduceTerminalEvent(state, { sequence: 2, kind: 'assistant-message', sessionId: 's', text: 'hello' }, host, 'activity-1', 's')
    expect(state.blocks).toMatchObject([{ kind: 'assistant', text: 'hello', state: 'success', sessionId: 's' }])
  })

  it('preserves multiple committed assistant steps inside one activity', () => {
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    state = reduceTerminalEvent(state, { sequence: 0, kind: 'assistant-delta', sessionId: 'root', text: 'working' }, host, 'activity-1', 'root')
    state = reduceTerminalEvent(state, { sequence: 1, kind: 'assistant-message', sessionId: 'root', text: 'working' }, host, 'activity-1', 'root')
    state = reduceTerminalEvent(state, { sequence: 2, kind: 'assistant-delta', sessionId: 'root', text: 'hello' }, host, 'activity-1', 'root')
    state = reduceTerminalEvent(state, { sequence: 3, kind: 'assistant-message', sessionId: 'root', text: 'hello' }, host, 'activity-1', 'root')
    const assistants = state.blocks.filter(block => block.kind === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants.map(block => block.text)).toEqual(['working', 'hello'])
    expect(new Set(assistants.map(block => block.id)).size).toBe(2)
  })

  it('keeps root and descendant assistant streams separate inside one activity', () => {
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    state = reduceTerminalEvent(state, { sequence: 0, kind: 'assistant-delta', sessionId: 'root', text: 'ro' }, host, 'activity-1', 'root')
    state = reduceTerminalEvent(state, { sequence: 1, kind: 'assistant-delta', sessionId: 'child', text: 'chi' }, host, 'activity-1', 'root')
    state = reduceTerminalEvent(state, { sequence: 2, kind: 'assistant-message', sessionId: 'child', text: 'child' }, host, 'activity-1', 'root')
    state = reduceTerminalEvent(state, { sequence: 3, kind: 'assistant-delta', sessionId: 'root', text: 'ot' }, host, 'activity-1', 'root')
    state = reduceTerminalEvent(state, { sequence: 4, kind: 'assistant-message', sessionId: 'root', text: 'root' }, host, 'activity-1', 'root')
    const root = state.blocks.find(block => block.kind === 'assistant' && block.sessionId === 'root')
    const child = state.blocks.find(block => block.kind === 'assistant' && block.sessionId === 'child')
    expect(root).toMatchObject({ text: 'root', title: 'assistant', state: 'success' })
    expect(child).toMatchObject({ text: 'child', state: 'success' })
    expect(child?.title).toContain('child')
    expect(root?.id).not.toBe(child?.id)
  })

  it('preserves multiple assistant turns that share one Harness session', () => {
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    state = reduceTerminalEvent(state, { sequence: 0, kind: 'assistant-message', sessionId: 'same-session', text: 'first' }, host, 'activity-1', 'same-session')
    state = reduceTerminalEvent(state, { sequence: 0, kind: 'assistant-message', sessionId: 'same-session', text: 'second' }, host, 'activity-2', 'same-session')
    expect(state.blocks.map(block => block.text)).toEqual(['first', 'second'])
    expect(state.blocks[0]?.activityId).toBe('activity-1')
    expect(state.blocks[1]?.activityId).toBe('activity-2')
  })

  it('keeps identical tool call ids isolated by session', () => {
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    for (const sessionId of ['root', 'child']) {
      state = reduceTerminalEvent(state, { sequence: 0, kind: 'tool-call', sessionId, callId: 'same-call', name: `${sessionId}-read`, arguments: '{}' }, host, 'activity-1', 'root')
    }
    state = reduceTerminalEvent(state, { sequence: 1, kind: 'tool-result', sessionId: 'child', callId: 'same-call', text: 'child result', isError: false }, host, 'activity-1', 'root')
    state = reduceTerminalEvent(state, { sequence: 2, kind: 'tool-result', sessionId: 'root', callId: 'same-call', text: 'root result', isError: false }, host, 'activity-1', 'root')
    const root = state.blocks.find(block => block.id === terminalBlockId('tool', 'activity-1', 'root', 'same-call'))
    const child = state.blocks.find(block => block.id === terminalBlockId('tool', 'activity-1', 'child', 'same-call'))
    expect(root).toMatchObject({ sessionId: 'root', detail: 'root result', state: 'success' })
    expect(child).toMatchObject({ sessionId: 'child', detail: 'child result', state: 'success' })
    expect(child?.title).toContain('child')
  })

  it('falls back safely when a renderer callback throws', () => {
    const host = new TerminalPluginHost()
    host.register({
      id: 'thrower', version: '1', apiVersion: TERMINAL_PLUGIN_API_VERSION,
      eventRenderers: [{ id: 'throwing-renderer', priority: 100, match: () => true, render: () => { throw new Error('renderer exploded\u001b[31m') } }],
    })
    const state = reduceTerminalEvent(initialTerminalTranscript(), { sequence: 0, kind: 'assistant-message', sessionId: 'root', text: 'visible' }, host, 'activity-1', 'root')
    expect(state.blocks.some(block => block.kind === 'assistant' && block.text === 'visible')).toBe(true)
    const error = state.blocks.find(block => block.title === 'terminal renderer error')
    expect(error?.text).toContain('renderer exploded\\x1b[31m')
  })

  it('keeps unknown events silent by default and diagnosable in debug mode', () => {
    const host = createDefaultTerminalHost()
    const event = { sequence: 0, kind: 'unknown' as const, method: 'session.event', type: 'future/event' }
    const quiet = reduceTerminalEvent(initialTerminalTranscript(), event, host, 'activity-1', 'root', false)
    const debug = reduceTerminalEvent(initialTerminalTranscript(), event, host, 'activity-1', 'root', true)
    expect(quiet.blocks).toHaveLength(0)
    expect(quiet.unknownEventCount).toBe(1)
    expect(debug.blocks[0]).toMatchObject({ kind: 'debug', title: 'unknown event' })
  })
})
