import { describe, expect, it } from 'vitest'
import { normalizeNotification } from '../../src/session/projection.js'
import { retainNormalizedEvent } from '../../src/retention.js'
import {
  accumulateUsage,
  describeSessionUsage,
  formatSessionUsage,
  initialSessionUsage,
} from '../../src/session/usage.js'

/**
 * Payload captured from a live 0.1.1-rc.1 runtime, not invented here. `usage` is
 * a sibling of `message`, one level above where a reasonable guess would put it
 * — the same mistake that made every tool result project as a success in #84.
 */
function assistantMessage(sessionId: string, usage?: Record<string, number>, seq = 14) {
  return normalizeNotification({
    method: 'session.event',
    params: {
      sessionId,
      event: {
        type: 'assistant/message',
        seq,
        time: 1787474868428,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
            id: 'aa4329a4',
          },
          ...(usage === undefined ? {} : { usage }),
        },
        sourceEventSeqs: [9, 10, 11, 12, 13],
      },
    },
  })
}

describe('token usage projection', () => {
  it('reads usage from beside the message, where the runtime actually puts it', () => {
    const event = assistantMessage('main', {
      inputTokens: 4267, outputTokens: 2, cacheReadTokens: 384, reasoningTokens: 0,
    })
    if (event.kind !== 'assistant-message') throw new Error('expected an assistant message')
    expect(event.text).toBe('ok')
    expect(event.usage).toEqual({
      inputTokens: 4267, outputTokens: 2, cacheReadTokens: 384, reasoningTokens: 0,
    })
  })

  it('leaves usage absent when the adapter reported none', () => {
    const event = assistantMessage('main')
    if (event.kind !== 'assistant-message') throw new Error('expected an assistant message')
    expect(event.usage).toBeUndefined()
  })

  it('omits a field the adapter did not send rather than reporting a zero', () => {
    const event = assistantMessage('main', { inputTokens: 10, outputTokens: 1 })
    if (event.kind !== 'assistant-message') throw new Error('expected an assistant message')
    expect(event.usage).toEqual({ inputTokens: 10, outputTokens: 1 })
    expect(event.usage && 'cacheWriteTokens' in event.usage).toBe(false)
  })

  it('survives local retention, which truncates text but must not drop numbers', () => {
    const retained = retainNormalizedEvent(assistantMessage('main', { inputTokens: 7, outputTokens: 3 }))
    if (retained.kind !== 'assistant-message') throw new Error('expected an assistant message')
    expect(retained.usage?.inputTokens).toBe(7)
  })

  it('treats the streaming usage chunk as internal, so totals are not doubled', () => {
    // The same numbers arrive twice: once as this chunk and once on the durable
    // assistant/message. Only the message is folded.
    const chunk = normalizeNotification({
      method: 'session.event',
      params: {
        sessionId: 'main',
        event: {
          type: 'assistant/chunk',
          seq: 12,
          data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 4267, outputTokens: 2 } } },
        },
      },
    })
    expect(chunk.kind).toBe('internal')
    expect(accumulateUsage(initialSessionUsage(), chunk, 'main').requests).toBe(0)
  })
})

describe('usage accumulation', () => {
  const fold = (events: readonly ReturnType<typeof assistantMessage>[], selected = 'main') =>
    events.reduce((state, event) => accumulateUsage(state, event, selected), initialSessionUsage())

  it('adds up every session, because every session is billed', () => {
    const usage = fold([
      assistantMessage('main', { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 }),
      assistantMessage('child', { inputTokens: 900, outputTokens: 90 }),
    ])
    expect(usage.inputTokens).toBe(1000)
    expect(usage.outputTokens).toBe(100)
    expect(usage.requests).toBe(2)
  })

  it('keeps latest-input scoped to the selected session', () => {
    // A subagent's request size says nothing about how large this conversation
    // is, which is the question the number on screen is answering.
    const usage = fold([
      assistantMessage('main', { inputTokens: 100, outputTokens: 1 }),
      assistantMessage('child', { inputTokens: 90_000, outputTokens: 1 }),
    ])
    expect(usage.latestInputTokens).toBe(100)
  })

  it('tracks the latest request rather than the largest', () => {
    const usage = fold([
      assistantMessage('main', { inputTokens: 5000, outputTokens: 1 }),
      assistantMessage('main', { inputTokens: 200, outputTokens: 1 }),
    ])
    expect(usage.latestInputTokens).toBe(200)
  })
})

describe('usage presentation', () => {
  it('says nothing at all until a request has reported', () => {
    expect(formatSessionUsage(initialSessionUsage())).toBeUndefined()
  })

  it('reports absolute numbers and a cache ratio', () => {
    const usage = accumulateUsage(
      initialSessionUsage(),
      assistantMessage('main', { inputTokens: 4267, outputTokens: 2100, cacheReadTokens: 384 }),
      'main',
    )
    expect(formatSessionUsage(usage)).toBe('ctx 4.3K out 2.1K cache 9%')
  })

  it('never renders a percentage of a context window', () => {
    // Upstream reports no window on this transport, and the number would have to
    // be hardcoded here — an upstream schema copied into dshc.
    const usage = accumulateUsage(
      initialSessionUsage(),
      assistantMessage('main', { inputTokens: 500_000, outputTokens: 1 }),
      'main',
    )
    const rendered = `${formatSessionUsage(usage)} ${describeSessionUsage(usage).join(' ')}`
    expect(rendered).not.toMatch(/\d+%\s*(of|full|used)/)
    expect(describeSessionUsage(usage).join(' ')).toContain('will not invent one')
  })
})
