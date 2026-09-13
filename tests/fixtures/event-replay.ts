import type { NormalizedEvent } from '../../src/session/projection.js'

/** Synthetic public event shapes: no workspace, credentials or user text. */
export function replayFixture(turns = 12): NormalizedEvent[] {
  const events: NormalizedEvent[] = []
  let sequence = 0
  const add = (event: Omit<NormalizedEvent, 'sequence'>): void => { events.push({ ...event, sequence: sequence++ } as NormalizedEvent) }
  for (let turn = 0; turn < turns; turn++) {
    const root = 'fixture-root'; const child = `fixture-child-${turn}`
    add({ kind: 'session-status', sessionId: root, status: 'running' } as NormalizedEvent)
    add({ kind: 'subagent-started', parentSessionId: root, childSessionId: child } as NormalizedEvent)
    let rootText = ''; let childText = ''
    for (let delta = 0; delta < 80; delta++) {
      const sessionId = delta % 17 === 0 ? child : root
      const text = `片段${delta} fragment `
      if (sessionId === root) rootText += text; else childText += text
      add({ kind: 'assistant-delta', sessionId, text } as NormalizedEvent)
    }
    add({ kind: 'assistant-message', sessionId: child, text: childText, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 8 } } as NormalizedEvent)
    add({ kind: 'subagent-finished', parentSessionId: root, childSessionId: child } as NormalizedEvent)
    add({ kind: 'tool-call', sessionId: root, name: 'read', callId: `${turn}`, arguments: '{"file_path":"fixture.txt"}' } as NormalizedEvent)
    add({ kind: 'tool-result', sessionId: root, callId: `${turn}`, text: turn % 3 === 0 ? 'expected fixture error' : 'fixture result', isError: turn % 3 === 0 } as NormalizedEvent)
    add({ kind: 'assistant-message', sessionId: root, text: rootText, usage: { inputTokens: 15, outputTokens: 40, cacheReadTokens: 30 } } as NormalizedEvent)
    if (turn % 4 === 0) add({ kind: 'turn-error', sessionId: root, message: 'fixture abnormal completion' } as NormalizedEvent)
    add({ kind: 'session-status', sessionId: root, status: 'idle' } as NormalizedEvent)
  }
  return events
}
