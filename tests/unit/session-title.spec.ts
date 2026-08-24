import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { describe, expect, it } from 'vitest'
import { formatTraceEvent } from '../../src/plugins/builtins.js'
import { retainNormalizedEvent } from '../../src/retention.js'
import { normalizeNotification } from '../../src/session/projection.js'

const ESCAPE = ''
const BELL = ''
const RIGHT_TO_LEFT_OVERRIDE = '‮'

// Re-captured from @deepseek-ai/dsh-sdk-client 0.1.1-rc.2. The event was
// introduced in rc.1; it names the session and is not agent activity.
function titleEvent(data: Record<string, unknown>): HarnessNotification {
  return {
    method: 'session.event',
    params: { sessionId: 'main', event: { type: 'session/title', data, seq: 6, time: 1 } },
  }
}

describe('session/title projection', () => {
  it('classifies the event instead of leaving it unknown', () => {
    const event = normalizeNotification(titleEvent({
      title: 'say ok',
      messageSeqs: [4],
      source: { kind: 'fallback' },
    }))
    expect(event).toMatchObject({
      kind: 'session-title',
      sessionId: 'main',
      title: 'say ok',
      source: 'fallback',
    })
  })

  it('tolerates a missing title and a missing source', () => {
    const event = normalizeNotification(titleEvent({ messageSeqs: [4] }))
    expect(event).toMatchObject({ kind: 'session-title', title: '' })
    if (event.kind !== 'session-title') throw new Error('expected a session-title projection')
    expect(event.source).toBeUndefined()
  })

  it('renders a model-authored title inert in the trace', () => {
    // The title is model-authored text and reaches the terminal like any other
    // untrusted string.
    const event = normalizeNotification(titleEvent({
      title: `${ESCAPE}]52;c;aGFja2Vk${BELL}${RIGHT_TO_LEFT_OVERRIDE}renamed`,
      source: { kind: 'model' },
    }))
    const line = formatTraceEvent(event)
    expect(line).toContain('session.title')
    expect(line).toContain('model')
    expect(line).not.toContain(ESCAPE)
    expect(line).not.toContain(BELL)
    expect(line).not.toContain(RIGHT_TO_LEFT_OVERRIDE)
  })

  it('bounds a long title under local retention', () => {
    const event = normalizeNotification(titleEvent({ title: 'x'.repeat(80_000) }))
    const retained = retainNormalizedEvent(event)
    if (retained.kind !== 'session-title') throw new Error('expected a session-title projection')
    expect(retained.title.length).toBeLessThan(80_000)
  })
})
