import type { NormalizedEvent, TokenUsage } from './projection.js'

/**
 * Running token accounting for one runtime, folded from what upstream reported.
 *
 * Deliberately absolute. `TokenUsage` carries no context window, and protocol
 * 0.0.1 does not expose the model catalog where `contextWindow` actually lives,
 * so a percentage would have to come from a number hardcoded here — an upstream
 * schema copied into dshc, which is the coupling that produced #83 and #84. A
 * real percentage needs #36.
 *
 * `latestInputTokens` is scoped to the selected session because it answers "how
 * large is this conversation now", and a subagent's request says nothing about
 * that. The cumulative totals include every session, because those are what the
 * person is actually billed for.
 */
export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Input tokens of the most recent request in the selected session. */
  latestInputTokens: number
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

  return {
    inputTokens: previous.inputTokens + usage.inputTokens,
    outputTokens: previous.outputTokens + usage.outputTokens,
    cacheReadTokens: previous.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: previous.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
    reasoningTokens: previous.reasoningTokens + (usage.reasoningTokens ?? 0),
    latestInputTokens: event.sessionId === selectedSessionId
      ? usage.inputTokens
      : previous.latestInputTokens,
    requests: previous.requests + 1,
  }
}

/** Compact status-line form, or `undefined` before any request has reported usage. */
export function formatSessionUsage(usage: SessionUsage): string | undefined {
  if (usage.requests === 0) return undefined
  const parts = [`ctx ${formatTokens(usage.latestInputTokens)}`, `out ${formatTokens(usage.outputTokens)}`]
  // Cached input is a subset of input, so the ratio is meaningful only once
  // there is input to be a fraction of.
  if (usage.inputTokens > 0 && usage.cacheReadTokens > 0) {
    parts.push(`cache ${Math.round((usage.cacheReadTokens / usage.inputTokens) * 100)}%`)
  }
  return parts.join(' ')
}

/** Longer form for `/status`, where there is room to name every field. */
export function describeSessionUsage(usage: SessionUsage): readonly string[] {
  if (usage.requests === 0) return ['No model request has reported token usage yet.']
  const lines = [
    `latest request input: ${usage.latestInputTokens.toLocaleString('en-US')} tokens`,
    `cumulative input: ${usage.inputTokens.toLocaleString('en-US')}`,
    `cumulative output: ${usage.outputTokens.toLocaleString('en-US')}`,
  ]
  if (usage.reasoningTokens > 0) lines.push(`of which reasoning: ${usage.reasoningTokens.toLocaleString('en-US')}`)
  if (usage.cacheReadTokens > 0) lines.push(`cache reads: ${usage.cacheReadTokens.toLocaleString('en-US')}`)
  if (usage.cacheWriteTokens > 0) lines.push(`cache writes: ${usage.cacheWriteTokens.toLocaleString('en-US')}`)
  lines.push(
    `requests reporting usage: ${usage.requests}`,
    '',
    'Totals cover this runtime including subagents; "latest request input" is the',
    'selected session only. There is no percentage: upstream reports no context',
    'window on this transport, and dshc will not invent one.',
  )
  return lines
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}
