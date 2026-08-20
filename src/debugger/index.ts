import type { NormalizedEvent } from '../session/projection.js'

export interface DebugFailure {
  sequence: number
  source: 'turn' | 'tool'
  message: string
}

export interface DebugSessionSummary {
  totalEvents: number
  failures: DebugFailure[]
  toolCalls: number
  assistantMessages: number
}

export function inspectSession(events: readonly NormalizedEvent[]): DebugSessionSummary {
  const failures: DebugFailure[] = []
  let toolCalls = 0
  let assistantMessages = 0

  for (const event of events) {
    if (event.kind === 'tool-call') toolCalls++
    if (event.kind === 'assistant-message') assistantMessages++
    if (event.kind === 'turn-error') {
      failures.push({ sequence: event.sequence, source: 'turn', message: event.message })
    }
    if (event.kind === 'tool-result' && event.isError) {
      failures.push({ sequence: event.sequence, source: 'tool', message: event.text || 'tool execution failed' })
    }
  }

  return {
    totalEvents: events.length,
    failures,
    toolCalls,
    assistantMessages,
  }
}
