import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { describe, expect, it } from 'vitest'
import { formatTraceEvent } from '../../src/plugins/builtins.js'
import {
  normalizeNotification,
  toolCallDurations,
  toolProjectionKey,
  type NormalizedEvent,
} from '../../src/session/projection.js'

// Envelope shape captured from @deepseek-ai/dsh-sdk-client 0.1.1-rc.1: a
// tool/result carries its own timestamp and links back to the call it derives
// from through sourceEventSeqs.
function sessionEvent(
  type: string,
  data: Record<string, unknown>,
  envelope: { seq?: number; time?: number; sourceEventSeqs?: unknown } = {},
  sessionId = 'main',
): HarnessNotification {
  const event: Record<string, unknown> = { type, data }
  if (envelope.seq !== undefined) event.seq = envelope.seq
  if (envelope.time !== undefined) event.time = envelope.time
  if (envelope.sourceEventSeqs !== undefined) event.sourceEventSeqs = envelope.sourceEventSeqs
  return { method: 'session.event', params: { sessionId, event } }
}

function toolCall(seq: number, time: number, callId = 'c1'): NormalizedEvent {
  return normalizeNotification(
    sessionEvent('tool/call', { callId, name: 'read', arguments: '{}' }, { seq, time }),
  )
}

function toolResult(
  seq: number,
  time: number,
  options: { callId?: string; sources?: number[]; isError?: boolean } = {},
): NormalizedEvent {
  const callId = options.callId ?? 'c1'
  return normalizeNotification(sessionEvent('tool/result', {
    message: {
      source: { kind: 'tool', callId },
      content: [{
        type: 'tool-result',
        toolCallId: callId,
        content: [{ type: 'text', text: 'ok' }],
        isError: options.isError ?? false,
      }],
    },
  }, { seq, time, ...(options.sources === undefined ? {} : { sourceEventSeqs: options.sources }) }))
}

describe('upstream event envelope', () => {
  it('carries time, seq and sourceEventSeqs onto the normalized event', () => {
    const event = toolResult(136, 1787305435549, { sources: [135] })
    expect(event).toMatchObject({
      kind: 'tool-result',
      upstreamSeq: 136,
      upstreamTime: 1787305435549,
      sourceEventSeqs: [135],
    })
  })

  it('leaves envelope fields absent rather than defaulting them', () => {
    const event = normalizeNotification(sessionEvent('tool/call', { callId: 'c1', name: 'read', arguments: '{}' }))
    expect(event.upstreamTime).toBeUndefined()
    expect(event.upstreamSeq).toBeUndefined()
    expect(event.sourceEventSeqs).toBeUndefined()
  })

  it('keeps the local sequence counter distinct from the upstream seq', () => {
    const event = normalizeNotification(
      sessionEvent('tool/call', { callId: 'c1', name: 'read', arguments: '{}' }, { seq: 135 }),
      7,
    )
    expect(event.sequence).toBe(7)
    expect(event.upstreamSeq).toBe(135)
  })

  it('ignores a non-numeric sourceEventSeqs rather than trusting it', () => {
    const event = toolResult(2, 100, { sources: ['nope' as unknown as number] })
    expect(event.sourceEventSeqs).toBeUndefined()
  })
})

describe('toolCallDurations', () => {
  const key = toolProjectionKey('main', 'c1')

  it('measures the span from upstream timestamps', () => {
    const durations = toolCallDurations([toolCall(135, 1000), toolResult(136, 1016, { sources: [135] })])
    expect(durations.get(key)).toBe(16)
  })

  it('prefers the upstream causal link over matching call ids', () => {
    // Two calls share a call id; sourceEventSeqs names which one this result
    // came from, so the span must be measured against that one.
    const events = [
      toolCall(10, 1000),
      toolCall(20, 5000),
      toolResult(21, 5040, { sources: [20] }),
    ]
    expect(toolCallDurations(events).get(key)).toBe(40)
  })

  it('falls back to the call id when upstream sent no causal link', () => {
    expect(toolCallDurations([toolCall(1, 1000), toolResult(2, 1250)]).get(key)).toBe(250)
  })

  it('reports nothing when either end lacks a timestamp', () => {
    const noCallTime = normalizeNotification(
      sessionEvent('tool/call', { callId: 'c1', name: 'read', arguments: '{}' }, { seq: 1 }),
    )
    expect(toolCallDurations([noCallTime, toolResult(2, 1250)]).size).toBe(0)
  })

  it('refuses a span that runs backwards instead of reporting a negative', () => {
    expect(toolCallDurations([toolCall(1, 2000), toolResult(2, 1000)]).size).toBe(0)
  })

  it('keeps distinct sessions apart', () => {
    const child = normalizeNotification(
      sessionEvent('tool/call', { callId: 'c1', name: 'read', arguments: '{}' }, { seq: 1, time: 1 }, 'child'),
    )
    const durations = toolCallDurations([child, toolCall(2, 1000), toolResult(3, 1300)])
    expect(durations.get(key)).toBe(300)
    expect(durations.get(toolProjectionKey('child', 'c1'))).toBeUndefined()
  })
})

describe('trace formatting of durations', () => {
  it('shows milliseconds under a second and seconds above it', () => {
    const result = toolResult(2, 1250)
    expect(formatTraceEvent(result, 2, new Map([[toolProjectionKey('main', 'c1'), 250]])))
      .toContain('250ms')
    expect(formatTraceEvent(result, 2, new Map([[toolProjectionKey('main', 'c1'), 2100]])))
      .toContain('2.1s')
  })

  it('omits the span entirely when it is unknown', () => {
    const line = formatTraceEvent(toolResult(2, 1250), 2)
    expect(line).toContain('tool.result')
    expect(line).not.toContain('ms')
    expect(line).not.toMatch(/\d+\.\ds/)
  })

  it('reports a failed call with its span', () => {
    const failure = toolResult(2, 1250, { isError: true })
    const line = formatTraceEvent(failure, 2, new Map([[toolProjectionKey('main', 'c1'), 900]]))
    expect(line).toContain('tool.error')
    expect(line).toContain('900ms')
  })
})
