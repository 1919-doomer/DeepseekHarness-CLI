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
  it('projects public request capacity and approval audit events without parsing prose', () => {
    expect(normalizeNotification(sessionEvent('request/context', {
      provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 131_072,
    }))).toMatchObject({
      kind: 'request-context', provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 131_072,
    })
    expect(normalizeNotification(sessionEvent('approval/asked', {
      id: 'approval-1', toolName: 'pwsh', callId: 'call-1', reason: 'run tests',
    }))).toMatchObject({
      kind: 'approval-asked', requestId: 'approval-1', toolName: 'pwsh', callId: 'call-1', reason: 'run tests',
    })
    expect(normalizeNotification(sessionEvent('approval/decided', {
      id: 'approval-1', outcome: 'allowed-once',
    }))).toMatchObject({ kind: 'approval-decided', requestId: 'approval-1', outcome: 'allowed-once' })
    expect(normalizeNotification(sessionEvent('approval/policy', {
      policy: 'never', source: 'delegation',
    }))).toMatchObject({ kind: 'approval-policy', policy: 'never', source: 'delegation' })
    expect(normalizeNotification(sessionEvent('approval/decided', {
      id: 'approval-1', outcome: 'allowed-forever',
    }))).toMatchObject({ kind: 'internal', type: 'approval/decided' })
  })

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

  it('keeps malformed tool identities diagnostic instead of correlating them through a fabricated id', () => {
    const projector = new SessionProjector('main')
    const legitimate = projector.ingest(sessionEvent('tool/call', {
      callId: 'unknown-call',
      name: 'literal-id-tool',
      arguments: '{}',
    }))
    const malformedCall = projector.ingest(sessionEvent('tool/call', {
      name: 'missing-id',
      arguments: '{}',
    }))
    const malformedResult = projector.ingest(sessionEvent('tool/result', {
      message: {
        role: 'tool',
        content: [{ type: 'text', text: 'must not attach to the literal id' }],
      },
    }))

    expect(legitimate).toMatchObject({ kind: 'tool-call', callId: 'unknown-call' })
    expect(malformedCall).toMatchObject({ kind: 'unknown', type: 'tool/call' })
    expect(malformedResult).toMatchObject({ kind: 'unknown', type: 'tool/result' })
    const projected = projector.state.tools.get(toolProjectionKey('main', 'unknown-call'))
    expect(projected).toMatchObject({ name: 'literal-id-tool' })
    expect(projected).not.toHaveProperty('result')
    expect(projector.state.tools.size).toBe(1)
    expect(projector.state.unknownEventCount).toBe(2)
  })
})

describe('tool result projection against the live DSH payload', () => {
  // Re-captured from @deepseek-ai/dsh-sdk-client 0.1.1-rc.2 running the `read`
  // tool. The call id, output text and error flag all live on the nested
  // tool-result block rather than on the message.
  function liveToolResult(overrides: {
    callId?: string
    text?: string
    isError?: boolean
    toolCallId?: string | undefined
  } = {}) {
    const callId = overrides.callId ?? 'call_00_live'
    const block: Record<string, unknown> = {
      type: 'tool-result',
      content: [{ type: 'text', text: overrides.text ?? '<content>README</content>' }],
      isError: overrides.isError ?? false,
    }
    if (overrides.toolCallId !== undefined) block.toolCallId = overrides.toolCallId
    return sessionEvent('tool/result', {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId },
        content: [block],
        role: 'user',
        id: '4434b4cd-c6c1-4627-97ab-067da69d2bf2',
      },
    })
  }

  it('reads the call id and output out of the nested tool-result block', () => {
    const event = normalizeNotification(liveToolResult({ toolCallId: 'call_00_live' }))
    expect(event).toMatchObject({
      kind: 'tool-result',
      callId: 'call_00_live',
      text: '<content>README</content>',
      isError: false,
    })
  })

  it('detects a failed tool call instead of reporting every result as success', () => {
    const event = normalizeNotification(liveToolResult({
      toolCallId: 'call_00_boom',
      callId: 'call_00_boom',
      text: 'permission denied',
      isError: true,
    }))
    expect(event).toMatchObject({
      kind: 'tool-result',
      callId: 'call_00_boom',
      text: 'permission denied',
      isError: true,
    })
  })

  it('falls back to message.source.callId when the block omits toolCallId', () => {
    const event = normalizeNotification(liveToolResult({ callId: 'call_00_source_only' }))
    expect(event).toMatchObject({ kind: 'tool-result', callId: 'call_00_source_only' })
  })

  it('never reports an unresolved call id or empty output for a real result', () => {
    const event = normalizeNotification(liveToolResult({ toolCallId: 'call_00_live' }))
    expect(event).toMatchObject({ kind: 'tool-result' })
    if (event.kind !== 'tool-result') throw new Error('expected a tool-result projection')
    expect(event.callId).not.toBe('unknown-call')
    expect(event.text).not.toBe('')
  })

  it('still degrades a flat text-block result rather than dropping it', () => {
    const event = normalizeNotification(sessionEvent('tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: 'call-legacy',
        content: [{ type: 'text', text: 'legacy output' }],
      },
    }))
    expect(event).toMatchObject({
      kind: 'tool-result',
      callId: 'call-legacy',
      text: 'legacy output',
      isError: false,
    })
  })
})
