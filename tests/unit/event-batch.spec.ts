import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalEventBatch, coalesceTranscriptDeltas } from '../../src/terminal/event-batch.js'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
import { initialTerminalTranscript, reduceTerminalEvent } from '../../src/terminal/transcript.js'
import { initialTerminalEventHistory, appendTerminalEventBatch } from '../../src/terminal/history.js'
import { accumulateUsage, initialSessionUsage } from '../../src/session/usage.js'
import { SnapshotStore } from '../../src/terminal/snapshot-store.js'
import { replayFixture } from '../fixtures/event-replay.js'
import type { NormalizedEvent } from '../../src/session/projection.js'
import { StreamingMarkdown } from '../../src/terminal/streaming-markdown.js'
import { parseMarkdown } from '../../src/terminal/markdown.js'

afterEach(() => vi.useRealTimers())
describe('event batching correctness and retention', () => {
  it('incremental Markdown equals full parsing across fences, tables and replacement', () => {
    const parser = new StreamingMarkdown()
    const text = '# Heading\n\n| A | B |\n| -- | -- |\n| 1 | 2 |\n\n```ts\nconst x = 1\n\nconsole.log(x)\n```\n\n- **item**\nEnd'
    for (let end = 1; end <= text.length; end++) expect(parser.parse(text.slice(0, end))).toEqual(parseMarkdown(text.slice(0, end)))
    expect(parser.parse('replaced')).toEqual(parseMarkdown('replaced'))
  })
  it('preserves final transcript, tools, session ownership, usage and raw trace', () => {
    const host = createDefaultTerminalHost()
    const events = replayFixture(180)
    let expected = initialTerminalTranscript(); let actual = initialTerminalTranscript()
    let trace = initialTerminalEventHistory()
    let usage = initialSessionUsage()
    const batch = new TerminalEventBatch(values => {
      for (const event of coalesceTranscriptDeltas(values, event => host.matchingRenderer(event) !== undefined)) actual = reduceTerminalEvent(actual, event, host, 'fixture-activity', 'fixture-root')
      trace = appendTerminalEventBatch(trace, values)
      for (const event of values) usage = accumulateUsage(usage, event, 'fixture-root')
    })
    for (const event of events) { expected = reduceTerminalEvent(expected, event, host, 'fixture-activity', 'fixture-root'); batch.push(event) }
    batch.close()
    expect(actual).toEqual(expected)
    expect(trace.total).toBe(events.length)
    expect(trace.items).toHaveLength(2048)
    expect(trace.items).toEqual(events.slice(-2048))
    expect(actual.blocks).toHaveLength(512)
    expect(usage).toEqual(events.reduce((value, event) => accumulateUsage(value, event, 'fixture-root'), initialSessionUsage()))
  })
  it('flushes text before boundaries and rejects late events after cancellation', () => {
    vi.useFakeTimers()
    const received: NormalizedEvent[][] = []
    const batch = new TerminalEventBatch(events => received.push([...events]))
    batch.push({ sequence: 1, kind: 'assistant-delta', sessionId: 'a', text: 'first' })
    expect(received).toHaveLength(0)
    vi.advanceTimersByTime(33)
    expect(received).toHaveLength(1)
    batch.push({ sequence: 2, kind: 'assistant-delta', sessionId: 'a', text: 'second' })
    batch.close()
    batch.push({ sequence: 3, kind: 'assistant-message', sessionId: 'a', text: 'late' })
    vi.runAllTimers()
    expect(received.flat().map(event => event.sequence)).toEqual([1, 2])
  })
  it('caps batches and isolates renderer failures', () => {
    const sizes: number[] = []
    const batch = new TerminalEventBatch(events => sizes.push(events.length))
    const event = { sequence: 0, kind: 'assistant-delta', sessionId: 'a', text: 'x' } as const
    for (let n = 0; n < 1000; n++) batch.push({ ...event, sequence: n })
    batch.close()
    expect(Math.max(...sizes)).toBeLessThanOrEqual(128)
    expect(coalesceTranscriptDeltas([event, event], () => { throw new Error('plugin matcher') })).toHaveLength(2)
  })
  it('retains the latest state while slow stdout blocks notifications', () => {
    let ready = false; let notifications = 0
    const store = new SnapshotStore(0, () => ready)
    store.subscribe(() => notifications++)
    for (let value = 0; value < 10000; value++) store.set(value)
    expect(notifications).toBe(0)
    ready = true; store.notify()
    expect(notifications).toBe(1); expect(store.get()).toBe(9999)
  })
})
