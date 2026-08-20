import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { describe, expect, it } from 'vitest'
import {
  SessionProjector,
  isInboxReceipt,
  normalizeNotification,
} from '../../src/session/projection.js'

function notification(method: string, params: Record<string, unknown>): HarnessNotification {
  return { method, params }
}

function sessionEvent(type: string, data: Record<string, unknown>): HarnessNotification {
  return notification('session.event', {
    sessionId: 'main',
    event: { type, data, seq: 1, time: 1 },
  })
}

describe('session projection', () => {
  it('recognizes only the durable inbox receipt for the submitted message', () => {
    const receipt = sessionEvent('agent/inbox/spliced', {
      inserted: [{ id: 'm1' }, { id: 'other' }],
    })
    expect(isInboxReceipt(receipt, 'main', 'm1')).toBe(true)
    expect(isInboxReceipt(receipt, 'main', 'missing')).toBe(false)
    expect(isInboxReceipt(receipt, 'other', 'm1')).toBe(false)
  })

  it('surfaces visible text deltas but not reasoning deltas', () => {
    const text = normalizeNotification(sessionEvent('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'visible' },
    }))
    const reasoning = normalizeNotification(sessionEvent('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 1, text: 'hidden' },
    }))
    expect(text).toMatchObject({ kind: 'assistant-delta', text: 'visible' })
    expect(reasoning).toMatchObject({ kind: 'internal', type: 'assistant/chunk' })
  })

  it('tracks committed assistant text, tools, subagents, failures and idle separately', () => {
    const projector = new SessionProjector()
    const inputs: HarnessNotification[] = [
      notification('session.status', { sessionId: 'main', status: 'running' }),
      sessionEvent('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'hel' },
      }),
      sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'c1',
        name: 'read',
        arguments: '{"path":"README.md"}',
      }),
      sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'ok' }],
        },
      }),
      notification('subagent.started', {
        parentSessionId: 'main',
        childSessionId: 'child',
        providerName: 'spawn',
      }),
      notification('subagent.finished', {
        parentSessionId: 'main',
        childSessionId: 'child',
      }),
      sessionEvent('assistant/message', {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      }),
      sessionEvent('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { message: 'provider failed', code: 'PROVIDER' } },
      }),
      notification('session.status', { sessionId: 'main', status: 'idle' }),
    ]

    for (const input of inputs) projector.ingest(input)

    expect(projector.state.activity).toBe('idle')
    expect(projector.state.lastTurnError).toBe('provider failed')
    expect(projector.state.lastAssistantMessage).toBe('hello')
    expect(projector.state.streamedAssistantText).toBe('')
    expect(projector.state.tools.get('c1')).toMatchObject({ name: 'read', result: 'ok', isError: false })
    expect(projector.state.subagents.get('child')).toMatchObject({ status: 'finished', provider: 'spawn' })
  })

  it('counts unknown event vocabulary instead of silently interpreting it', () => {
    const projector = new SessionProjector()
    const event = projector.ingest(sessionEvent('plugin/new-event', { value: 1 }))
    expect(event).toMatchObject({ kind: 'unknown', type: 'plugin/new-event' })
    expect(projector.state.unknownEventCount).toBe(1)
  })
})
