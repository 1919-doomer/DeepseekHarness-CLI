import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { describe, expect, it } from 'vitest'
import {
  SessionProjector,
  isInboxReceipt,
  normalizeNotification,
  toolProjectionKey,
} from '../../src/session/projection.js'

function notification(method: string, params: Record<string, unknown>): HarnessNotification {
  return { method, params }
}

function sessionEvent(
  type: string,
  data: Record<string, unknown>,
  sessionId = 'main',
): HarnessNotification {
  return notification('session.event', {
    sessionId,
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

  it('keeps root response/activity isolated from descendant sessions and namespaces tool calls', () => {
    const projector = new SessionProjector('main')
    const inputs: HarnessNotification[] = [
      notification('session.status', { sessionId: 'main', status: 'running' }),
      notification('subagent.started', {
        parentSessionId: 'main',
        childSessionId: 'child',
        providerName: 'spawn',
      }),
      notification('session.status', { sessionId: 'child', status: 'running' }),
      sessionEvent('assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'child-' },
      }, 'child'),
      sessionEvent('tool/call', {
        turn: 1,
        step: 1,
        callId: 'same-call',
        name: 'child-read',
        arguments: '{}',
      }, 'child'),
      sessionEvent('tool/result', {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          toolCallId: 'same-call',
          content: [{ type: 'text', text: 'child-result' }],
        },
      }, 'child'),
      sessionEvent('assistant/message', {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'child-answer' }] },
      }, 'child'),
      notification('session.status', { sessionId: 'child', status: 'idle' }),
      sessionEvent('assistant/chunk', {
        turn: 1,
        step: 2,
        chunk: { type: 'text-delta', index: 0, text: 'root-' },
      }),
      sessionEvent('tool/call', {
        turn: 1,
        step: 2,
        callId: 'same-call',
        name: 'root-read',
        arguments: '{}',
      }),
      sessionEvent('tool/result', {
        turn: 1,
        step: 2,
        message: {
          role: 'tool',
          toolCallId: 'same-call',
          content: [{ type: 'text', text: 'root-result' }],
        },
      }),
      sessionEvent('assistant/message', {
        turn: 1,
        step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: 'root-answer' }] },
      }),
      sessionEvent('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { message: 'root failure', code: 'PROVIDER' } },
      }),
      sessionEvent('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { message: 'child failure', code: 'PROVIDER' } },
      }, 'child'),
      notification('subagent.finished', {
        parentSessionId: 'main',
        childSessionId: 'child',
      }),
      notification('session.status', { sessionId: 'main', status: 'idle' }),
    ]

    for (const input of inputs) projector.ingest(input)

    expect(projector.state.rootSessionId).toBe('main')
    expect(projector.state.activity).toBe('idle')
    expect(projector.state.lastTurnError).toBe('root failure')
    expect(projector.state.lastAssistantMessage).toBe('root-answer')
    expect(projector.state.streamedAssistantText).toBe('')
    expect(projector.state.tools.get(toolProjectionKey('main', 'same-call'))).toMatchObject({
      sessionId: 'main',
      name: 'root-read',
      result: 'root-result',
      isError: false,
    })
    expect(projector.state.tools.get(toolProjectionKey('child', 'same-call'))).toMatchObject({
      sessionId: 'child',
      name: 'child-read',
      result: 'child-result',
      isError: false,
    })
    expect(projector.state.subagents.get('child')).toMatchObject({ status: 'finished', provider: 'spawn' })
  })

  it('counts unknown event vocabulary instead of silently interpreting it', () => {
    const projector = new SessionProjector('main')
    const event = projector.ingest(sessionEvent('plugin/new-event', { value: 1 }))
    expect(event).toMatchObject({ kind: 'unknown', type: 'plugin/new-event' })
    expect(projector.state.unknownEventCount).toBe(1)
  })
})
