import { describe, expect, it } from 'vitest'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
import type { TranscriptBlock, TranscriptMutation } from '../../src/plugins/api.js'
import { blockElapsedMs, formatElapsedMs } from '../../src/terminal/product.js'
import { normalizeNotification, type NormalizedEvent } from '../../src/session/projection.js'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'

const context = { debug: false, activityId: 'a1', rootSessionId: 'main' }

function sessionEvent(type: string, data: Record<string, unknown>, time?: number): HarnessNotification {
  const event: Record<string, unknown> = { type, data, seq: 1 }
  if (time !== undefined) event.time = time
  return { method: 'session.event', params: { sessionId: 'main', event } }
}

function render(event: NormalizedEvent): readonly TranscriptMutation[] {
  const host = createDefaultTerminalHost()
  const renderer = host.matchingRenderer(event)
  if (renderer === undefined) throw new Error(`no renderer matched ${event.kind}`)
  return renderer.render(event, context)
}

function appended(mutations: readonly TranscriptMutation[]): TranscriptBlock {
  const first = mutations[0]
  if (first?.kind !== 'append') throw new Error('expected an append mutation')
  return first.block
}

function patched(mutations: readonly TranscriptMutation[]): Partial<TranscriptBlock> {
  const first = mutations[0]
  if (first?.kind !== 'patch') throw new Error('expected a patch mutation')
  return first.patch
}

const callEvent = (time?: number) => normalizeNotification(sessionEvent('tool/call', {
  callId: 'c1', name: 'read', arguments: '{"file_path":"src/stats.js"}',
}, time))

const resultEvent = (time?: number, isError = false) => normalizeNotification(sessionEvent('tool/result', {
  message: {
    source: { kind: 'tool', callId: 'c1' },
    content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError }],
  },
}, time))

describe('tool block timestamps', () => {
  it('records the upstream call time on the specialized presentation', () => {
    const block = appended(render(callEvent(1000)))
    expect(block.title).toContain('read')
    expect(block.title).toContain('src/stats.js')
    expect(block.startedAt).toBe(1000)
    expect(block.state).toBe('running')
  })

  it('records the upstream call time on the generic presentation', () => {
    // An argument shape the specialized renderer cannot fully explain falls
    // through to the generic tool block, which must still carry the timestamp.
    const unknown = normalizeNotification(sessionEvent('tool/call', {
      callId: 'c9', name: 'some-future-tool', arguments: '{"whatever":1}',
    }, 500))
    const block = appended(render(unknown))
    expect(block.startedAt).toBe(500)
  })

  it('records the upstream result time and the outcome', () => {
    expect(patched(render(resultEvent(1312)))).toMatchObject({ state: 'success', endedAt: 1312 })
    expect(patched(render(resultEvent(1312, true)))).toMatchObject({ state: 'error', endedAt: 1312 })
  })

  it('omits the timestamp rather than defaulting it when upstream sent none', () => {
    expect(appended(render(callEvent())).startedAt).toBeUndefined()
    expect(patched(render(resultEvent())).endedAt).toBeUndefined()
  })
})

describe('elapsed span', () => {
  const block = (startedAt?: number, endedAt?: number): TranscriptBlock => ({
    id: 'b', kind: 'tool', text: '', ...(startedAt === undefined ? {} : { startedAt }), ...(endedAt === undefined ? {} : { endedAt }),
  })

  it('derives the span from the two upstream timestamps', () => {
    expect(blockElapsedMs(block(1000, 1312))).toBe(312)
  })

  it('is unknown when either end is missing', () => {
    expect(blockElapsedMs(block(1000, undefined))).toBeUndefined()
    expect(blockElapsedMs(block(undefined, 1312))).toBeUndefined()
    expect(blockElapsedMs(block())).toBeUndefined()
  })

  it('refuses a span that runs backwards instead of showing a negative', () => {
    expect(blockElapsedMs(block(2000, 1000))).toBeUndefined()
  })

  it('formats milliseconds under a second and seconds above it', () => {
    expect(formatElapsedMs(0)).toBe('0ms')
    expect(formatElapsedMs(999)).toBe('999ms')
    expect(formatElapsedMs(1000)).toBe('1.0s')
    expect(formatElapsedMs(2149)).toBe('2.1s')
  })
})
