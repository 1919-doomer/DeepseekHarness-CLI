import { describeToolCall } from '../plugins/coding.js'
import { toolCallDurations, toolProjectionKey, type NormalizedEvent } from '../session/projection.js'
import { sanitizeTerminalText } from './sanitize.js'
import { cropTerminalText } from './text-metrics.js'

/** Indent past this depth is reported numerically instead of growing forever. */
export const MAX_ACTIVITY_DEPTH = 3

export type ToolActivityState = 'running' | 'success' | 'error'

export interface ToolActivityRow {
  /** `(sessionId, callId)` identity; a call id alone is never sufficient. */
  key: string
  sessionId: string
  callId: string
  state: ToolActivityState
  /** The same description the transcript shows, or the bare tool name. */
  label: string
  /** Nesting under the root session, bounded by MAX_ACTIVITY_DEPTH. */
  depth: number
  /** True when the parent chain to the root could not be observed. */
  orphaned: boolean
  elapsedMs?: number
}

export interface ToolActivityCounts {
  total: number
  running: number
  success: number
  error: number
}

export interface ToolActivityProjection {
  rows: readonly ToolActivityRow[]
  counts: ToolActivityCounts
}

/**
 * Project the retained event tail into one row per tool call.
 *
 * This is a projection of exactly what `/trace` queries, never a second source
 * of truth: it can show nothing `/trace` cannot. Rows carry only facts already
 * on the wire — the tool name, the arguments the model actually sent, the
 * outcome, and a span between two upstream timestamps.
 *
 * A descendant whose parent chain to the root was never observed — because
 * retention evicted it, or because the relationship is malformed — is reported
 * as orphaned at depth 1 rather than being reattached to something else. The
 * same refusal to invent links that `/agents` makes.
 */
export function projectToolActivity(
  events: readonly NormalizedEvent[],
  rootSessionId: string,
): ToolActivityProjection {
  const parents = new Map<string, string>()
  for (const event of events) {
    if (event.kind === 'subagent-started') parents.set(event.childSessionId, event.parentSessionId)
  }

  const durations = toolCallDurations(events)
  const order: string[] = []
  const byKey = new Map<string, ToolActivityRow>()

  for (const event of events) {
    if (event.kind === 'tool-call') {
      const key = toolProjectionKey(event.sessionId, event.callId)
      const placement = placeSession(event.sessionId, rootSessionId, parents)
      const row: ToolActivityRow = {
        key,
        sessionId: event.sessionId,
        callId: event.callId,
        state: 'running',
        label: describeToolCall(event.name, event.arguments) ?? sanitizeTerminalText(event.name),
        depth: placement.depth,
        orphaned: placement.orphaned,
      }
      if (!byKey.has(key)) order.push(key)
      byKey.set(key, row)
      continue
    }

    if (event.kind !== 'tool-result') continue
    const key = toolProjectionKey(event.sessionId, event.callId)
    const existing = byKey.get(key)
    const elapsed = durations.get(key)
    if (existing === undefined) {
      // A result whose call was evicted still happened; showing it without its
      // description beats dropping observed activity.
      const placement = placeSession(event.sessionId, rootSessionId, parents)
      order.push(key)
      byKey.set(key, {
        key,
        sessionId: event.sessionId,
        callId: event.callId,
        state: event.isError ? 'error' : 'success',
        label: 'call evicted from local retention',
        depth: placement.depth,
        orphaned: placement.orphaned,
        ...(elapsed === undefined ? {} : { elapsedMs: elapsed }),
      })
      continue
    }
    byKey.set(key, {
      ...existing,
      state: event.isError ? 'error' : 'success',
      ...(elapsed === undefined ? {} : { elapsedMs: elapsed }),
    })
  }

  const rows = order.map(key => byKey.get(key)).filter((row): row is ToolActivityRow => row !== undefined)
  return {
    rows,
    counts: {
      total: rows.length,
      running: rows.filter(row => row.state === 'running').length,
      success: rows.filter(row => row.state === 'success').length,
      error: rows.filter(row => row.state === 'error').length,
    },
  }
}

export interface ToolActivityDetail {
  row: ToolActivityRow
  /** Raw arguments the model sent, as they appeared on the wire. */
  argumentsText?: string
  /** Retained result text; retention may already have truncated it. */
  resultText?: string
}

/**
 * Everything observed about one call, for the detail panel. Absent fields mean
 * the event was never seen or was already evicted — they are not filled in.
 */
export function findToolActivityDetail(
  events: readonly NormalizedEvent[],
  rootSessionId: string,
  key: string,
): ToolActivityDetail | undefined {
  const row = projectToolActivity(events, rootSessionId).rows.find(candidate => candidate.key === key)
  if (row === undefined) return undefined

  const detail: ToolActivityDetail = { row }
  for (const event of events) {
    if (event.kind === 'tool-call' && toolProjectionKey(event.sessionId, event.callId) === key) {
      detail.argumentsText = event.arguments
      continue
    }
    if (event.kind === 'tool-result' && toolProjectionKey(event.sessionId, event.callId) === key) {
      detail.resultText = event.text
    }
  }
  return detail
}

function placeSession(
  sessionId: string,
  rootSessionId: string,
  parents: ReadonlyMap<string, string>,
): { depth: number; orphaned: boolean } {
  if (sessionId === rootSessionId) return { depth: 0, orphaned: false }

  const seen = new Set<string>([sessionId])
  let current = sessionId
  let depth = 0
  while (depth <= MAX_ACTIVITY_DEPTH) {
    const parent = parents.get(current)
    if (parent === undefined) return { depth: Math.max(1, depth), orphaned: true }
    depth++
    if (parent === rootSessionId) return { depth, orphaned: false }
    if (seen.has(parent)) return { depth, orphaned: true }
    seen.add(parent)
    current = parent
  }
  return { depth: MAX_ACTIVITY_DEPTH, orphaned: false }
}

export function activityGlyph(state: ToolActivityState): string {
  switch (state) {
    case 'running': return '▸'
    case 'success': return '✓'
    case 'error': return '✗'
  }
}

/**
 * One call is one row, hard-cropped on a grapheme boundary. Rows never wrap, so
 * every layout question stays on the transcript side of the split.
 */
export function formatActivityRow(row: ToolActivityRow, width: number): string {
  const indent = row.depth <= MAX_ACTIVITY_DEPTH
    ? '  '.repeat(row.depth)
    : `  +${row.depth} `
  const mark = row.orphaned ? '?' : activityGlyph(row.state)
  const elapsed = row.elapsedMs === undefined ? '' : ` ${formatActivityElapsed(row.elapsedMs)}`
  return cropTerminalText(`${indent}${mark} ${row.label}${elapsed}`, Math.max(4, width))
}

export function formatActivityElapsed(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * Counter line, in words rather than by colour. Running calls are named when
 * there are any, so the parts always reconcile with the total instead of
 * silently leaving some calls unaccounted for.
 */
export function formatActivityCounts(counts: ToolActivityCounts): string {
  const parts = [`${counts.total} calls`, `${counts.success} ok`, `${counts.error} failed`]
  if (counts.running > 0) parts.push(`${counts.running} running`)
  return parts.join(' · ')
}
