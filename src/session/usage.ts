import type { NormalizedEvent, TokenUsage } from './projection.js'

/**
 * Running token accounting for one runtime, folded from what upstream reported.
 *
 * Deliberately absolute. `TokenUsage` carries no context window. The `/context`
 * view may correlate these totals with a separately observed public
 * `request/context` event, but this fold never hardcodes model capacity.
 *
 * Harness token counts are disjoint: `inputTokens` is uncached input, while
 * cache reads and writes are reported separately. `latestInputTokens` folds
 * those fields back into the selected session's total request input because it
 * answers "how large is this conversation now", and a subagent's request says
 * nothing about that. The cumulative totals include every session, because
 * those are what the person is actually billed for.
 */
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Total input tokens of the most recent request in the selected session. */
  latestInputTokens: number
  /** Output tokens of the most recent reported request in the selected session. */
  latestOutputTokens?: number
  /** Cache-read tokens of that same selected-session request. */
  latestCacheReadTokens?: number
  /** Model requests that reported usage at all. */
  requests: number
}

export function initialSessionUsage(): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    latestInputTokens: 0,
    latestOutputTokens: 0,
    latestCacheReadTokens: 0,
    requests: 0,
  }
}

export function accumulateUsage(
  previous: SessionUsage,
  event: NormalizedEvent,
  selectedSessionId: string,
): SessionUsage {
  if (event.kind !== 'assistant-message' || event.usage === undefined) return previous
  const usage: TokenUsage = event.usage
  const requestInputTokens = totalInputTokens(usage)

  return {
    inputTokens: previous.inputTokens + usage.inputTokens,
    outputTokens: previous.outputTokens + usage.outputTokens,
    cacheReadTokens: previous.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: previous.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: previous.reasoningTokens + (usage.reasoningTokens ?? 0),
    latestInputTokens: event.sessionId === selectedSessionId
      ? requestInputTokens
      : previous.latestInputTokens,
    latestOutputTokens: event.sessionId === selectedSessionId
      ? usage.outputTokens
      : previous.latestOutputTokens,
    latestCacheReadTokens: event.sessionId === selectedSessionId
      ? (usage.cacheReadTokens ?? 0)
      : previous.latestCacheReadTokens,
    requests: previous.requests + 1,
  }
}

/** Compact status-line form, or `undefined` before any request has reported usage. */
export function formatSessionUsage(usage: SessionUsage): string | undefined {
  if (usage.requests === 0) return undefined
  const parts = [`ctx ${formatTokens(usage.latestInputTokens)}`, `out ${formatTokens(usage.outputTokens)}`]
  const cumulativeInputTokens = totalInputTokens(usage)
  if (cumulativeInputTokens > 0 && usage.cacheReadTokens > 0) {
    const percentage = Math.max(0, Math.min(100, Math.round((usage.cacheReadTokens / cumulativeInputTokens) * 100)))
    parts.push(`cache ${percentage}%`)
  }
  return parts.join(' ')
}

/** Longer form for `/status`, where there is room to name every field. */
export function describeSessionUsage(usage: SessionUsage): readonly string[] {
  if (usage.requests === 0) return ['No model request has reported token usage yet.']
  const cumulativeInputTokens = totalInputTokens(usage)
  const lines = [
    `latest request input: ${usage.latestInputTokens.toLocaleString('en-US')} tokens`,
    `cumulative total input: ${cumulativeInputTokens.toLocaleString('en-US')}`,
    `cumulative uncached input: ${usage.inputTokens.toLocaleString('en-US')}`,
    `cumulative output: ${usage.outputTokens.toLocaleString('en-US')}`,
  ]
  if (usage.reasoningTokens > 0) lines.push(`of which reasoning: ${usage.reasoningTokens.toLocaleString('en-US')}`)
  if (usage.cacheReadTokens > 0) lines.push(`cache reads: ${usage.cacheReadTokens.toLocaleString('en-US')}`)
  if (usage.cacheWriteTokens > 0) lines.push(`cache writes: ${usage.cacheWriteTokens.toLocaleString('en-US')}`)
  lines.push(
    `requests reporting usage: ${usage.requests}`,
    '',
    'Totals cover this runtime including subagents; "latest request input" is the',
    'selected session only. This usage fold has no capacity. `/context` reports',
    'a percentage only after observing public runtime capacity; dshc will not invent one.',
  )
  return lines
}

function totalInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}
