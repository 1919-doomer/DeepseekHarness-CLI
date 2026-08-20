import type { DebugEvent, DebugTimeline } from './model.js'

export interface FailureInspection {
  count: number
  failures: readonly DebugEvent[]
}

export function inspectFailures(timeline: DebugTimeline): FailureInspection {
  const failures = timeline.events.filter(event => event.level === 'error')
  return { count: failures.length, failures }
}

export function summarizeFailure(event: DebugEvent): string {
  return [
    `failure #${event.sequence}`,
    `kind=${event.kind}`,
    event.message,
    event.durationMs === undefined ? undefined : `duration=${event.durationMs}ms`,
  ].filter((item): item is string => item !== undefined).join('\n')
}
