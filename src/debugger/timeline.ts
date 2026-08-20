import type { DebugEventRecord, DebugEventKind, DebugSeverity } from './model.js'

export interface DebugTimelineOptions {
  sessionId: string
}

export function createDebugEvent(input: {
  kind: DebugEventKind
  summary: string
  severity?: DebugSeverity
  detail?: string
  durationMs?: number
  toolName?: string
}): DebugEventRecord {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: Date.now(),
    kind: input.kind,
    severity: input.severity ?? 'info',
    summary: input.summary,
    detail: input.detail,
    durationMs: input.durationMs,
    toolName: input.toolName,
  }
}

export function filterDebugFailures(events: readonly DebugEventRecord[]): readonly DebugEventRecord[] {
  return events.filter(event => event.severity === 'error' || event.kind === 'turn-error')
}

export function formatDebugTimeline(events: readonly DebugEventRecord[]): string {
  return events
    .map(event => {
      const duration = event.durationMs === undefined ? '' : ` (${event.durationMs}ms)`
      const tool = event.toolName === undefined ? '' : ` [${event.toolName}]`
      return `${event.kind}${tool}${duration}: ${event.summary}`
    })
    .join('\n')
}
