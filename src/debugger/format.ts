import type { DebugFailure, DebugInspection } from './index.js'

export function formatDebugInspection(report: DebugInspection): string {
  const lines = [
    `events: ${report.totalEvents}`,
    `failures: ${report.failures.length}`,
    `tools: ${report.toolCalls}`,
    `assistant messages: ${report.assistantMessages}`,
  ]

  if (report.failures.length > 0) {
    lines.push('', ...report.failures.map(formatFailure))
  }

  return lines.join('\n')
}

function formatFailure(failure: DebugFailure): string {
  return [
    `[${failure.kind}] ${failure.message}`,
    failure.sequence === undefined ? undefined : `  sequence: ${failure.sequence}`,
  ].filter((line): line is string => line !== undefined).join('\n')
}
