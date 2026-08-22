import { describe, expect, it } from 'vitest'
import { formatTraceEvent } from '../../src/plugins/builtins.js'
import { retainNormalizedEvent } from '../../src/retention.js'
import { normalizeNotification } from '../../src/session/projection.js'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
import { initialTerminalTranscript, reduceTerminalEvent } from '../../src/terminal/transcript.js'

// Payload read from @deepseek-ai/dsh-compaction-basic, which appends
// compaction/summary with the compaction id, the summary text, the shadowed
// sequence list and the shadowed token count.
function compactionSummary(data: Record<string, unknown>) {
  return normalizeNotification({
    method: 'session.event',
    params: { sessionId: 'main', event: { type: 'compaction/summary', data, seq: 9, time: 1 } },
  })
}

describe('compaction visibility', () => {
  it('projects a summary as a visible event, not as internal noise', () => {
    const event = compactionSummary({
      compactionId: 'c-1',
      summary: 'Earlier work established the parser layout.',
      shadowedSeqs: [1, 2, 3, 4, 5],
      shadowedTokenCount: 12480,
      shadowedRange: { start: 1, end: 5 },
    })

    expect(event).toMatchObject({
      kind: 'context-compacted',
      sessionId: 'main',
      shadowedEvents: 5,
      shadowedTokens: 12480,
      summary: 'Earlier work established the parser layout.',
    })
  })

  it('leaves an unreported token count absent rather than guessing zero', () => {
    const event = compactionSummary({ summary: 's', shadowedSeqs: [1] })
    if (event.kind !== 'context-compacted') throw new Error('expected a compaction projection')
    expect(event.shadowedTokens).toBeUndefined()
    expect(event.shadowedEvents).toBe(1)
  })

  it('treats the start marker as internal, since it carries nothing to show', () => {
    const start = normalizeNotification({
      method: 'session.event',
      params: { sessionId: 'main', event: { type: 'compaction/start', data: { compactionId: 'c-1', turn: 1 }, seq: 8 } },
    })
    expect(start.kind).toBe('internal')
  })

  it('reports the shadowed counts in the trace', () => {
    const line = formatTraceEvent(compactionSummary({
      summary: 's', shadowedSeqs: [1, 2], shadowedTokenCount: 900,
    }), 9)
    expect(line).toContain('context.compacted')
    expect(line).toContain('2 events')
    expect(line).toContain('900 tokens')
  })

  it('appends a transcript block naming what was replaced', () => {
    const state = reduceTerminalEvent(
      initialTerminalTranscript(),
      compactionSummary({ summary: 'the summary text', shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4096 }),
      createDefaultTerminalHost(),
      'a1',
      'main',
    )
    const block = state.blocks.at(-1)
    expect(block?.title).toContain('context compacted')
    expect(block?.title).toContain('3 earlier events')
    expect(block?.title).toContain('4096 tokens')
    // The replacement summary is what the model can still see, so it is shown
    // rather than hidden, and folded like any other long body.
    expect(block?.text).toBe('the summary text')
    expect(block?.foldable).toBe(true)
  })

  it('bounds a long summary under local retention', () => {
    const event = compactionSummary({ summary: 'x'.repeat(90_000), shadowedSeqs: [] })
    const retained = retainNormalizedEvent(event)
    if (retained.kind !== 'context-compacted') throw new Error('expected a compaction projection')
    expect(retained.summary.length).toBeLessThan(90_000)
  })
})
