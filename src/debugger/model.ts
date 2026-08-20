export type DebugSeverity = 'info' | 'warning' | 'error'

export type DebugEventKind =
  | 'turn-start'
  | 'tool-call'
  | 'tool-result'
  | 'turn-error'
  | 'session-status'
  | 'unknown'

export interface DebugEventRecord {
  id: string
  timestamp: number
  kind: DebugEventKind
  severity: DebugSeverity
  summary: string
  detail?: string
  durationMs?: number
  toolName?: string
}

export interface DebugTurnSummary {
  turnId: string
  startedAt: number
  endedAt?: number
  durationMs?: number
  events: readonly DebugEventRecord[]
  failures: readonly DebugEventRecord[]
}

export interface DebugSessionSnapshot {
  sessionId: string
  turns: readonly DebugTurnSummary[]
  failures: readonly DebugEventRecord[]
}
