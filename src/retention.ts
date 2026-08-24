import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { NormalizedEvent } from './session/projection.js'

/** Per-activity diagnostic tails returned by HarnessRuntime.run(). */
export const MAX_RETAINED_ACTIVITY_NOTIFICATIONS = 512
export const MAX_RETAINED_ACTIVITY_EVENTS = 1_024

/** Process-lifetime terminal observability tails. */
export const MAX_RETAINED_TERMINAL_EVENTS = 2_048
export const MAX_RETAINED_TRANSCRIPT_BLOCKS = 512
export const MAX_RETAINED_TOPOLOGY_ENTRIES = 1_024

/**
 * Retained diagnostic payloads are intentionally much smaller than protocol
 * payloads. Projection/onEvent still see the complete event before this copy is
 * compacted; only the local history copy is bounded.
 */
export const MAX_RETAINED_EVENT_TEXT_CHARS = 8_192
export const MAX_RETAINED_NOTIFICATION_STRING_CHARS = 8_192
export const MAX_RETAINED_TRANSCRIPT_FIELD_CHARS = 32_768

export interface RetainedTail<T> {
  items: readonly T[]
  total: number
  dropped: number
}

export function initialRetainedTail<T>(): RetainedTail<T> {
  return { items: [], total: 0, dropped: 0 }
}

export function appendRetainedTail<T>(
  state: RetainedTail<T>,
  value: T,
  limit: number,
): RetainedTail<T> {
  const total = state.total + 1
  if (state.items.length < limit) return { items: [...state.items, value], total, dropped: state.dropped }
  return {
    items: [...state.items.slice(1), value],
    total,
    dropped: state.dropped + 1,
  }
}

export interface RetainedText {
  text: string
  droppedChars: number
}

export function retainText(text: string, maxChars: number): RetainedText {
  if (text.length <= maxChars) return { text, droppedChars: 0 }
  if (maxChars < 128) {
    const kept = text.slice(0, Math.max(0, maxChars))
    return { text: kept, droppedChars: text.length - kept.length }
  }

  const markerBudget = 96
  const contentBudget = Math.max(32, maxChars - markerBudget)
  const headChars = Math.max(16, Math.floor(contentBudget * 0.75))
  const tailChars = Math.max(16, contentBudget - headChars)
  const droppedChars = Math.max(0, text.length - headChars - tailChars)
  const marker = `\n… ${droppedChars} chars evicted from local retention; upstream execution unchanged …\n`
  return {
    text: `${text.slice(0, headChars)}${marker}${text.slice(-tailChars)}`,
    droppedChars,
  }
}

export function retainNormalizedEvent(event: NormalizedEvent): NormalizedEvent {
  switch (event.kind) {
    case 'user-message':
    case 'assistant-delta':
    case 'assistant-message':
      return { ...event, text: retainText(event.text, MAX_RETAINED_EVENT_TEXT_CHARS).text }
    case 'tool-call':
      return { ...event, arguments: retainText(event.arguments, MAX_RETAINED_EVENT_TEXT_CHARS).text }
    case 'tool-result':
      return {
        ...event,
        text: retainText(event.text, MAX_RETAINED_EVENT_TEXT_CHARS).text,
        ...(event.metadata === undefined ? {} : {
          metadata: Object.fromEntries(Object.entries(event.metadata).map(([key, value]) => [
            key,
            value === undefined ? undefined : retainText(value, MAX_RETAINED_EVENT_TEXT_CHARS).text,
          ])),
        }),
      }
    case 'turn-error':
      return { ...event, message: retainText(event.message, MAX_RETAINED_EVENT_TEXT_CHARS).text }
    case 'session-title':
      return { ...event, title: retainText(event.title, MAX_RETAINED_EVENT_TEXT_CHARS).text }
    case 'context-compacted':
      return { ...event, summary: retainText(event.summary, MAX_RETAINED_EVENT_TEXT_CHARS).text }
    case 'session-status':
    case 'subagent-started':
    case 'subagent-finished':
    case 'internal':
    case 'unknown':
      return event
  }
}

/**
 * Raw notifications are retained for diagnostics only. The full notification is
 * delivered to projection and callbacks first. This copy recursively bounds
 * strings/collections so one giant tool result cannot remain pinned by the
 * diagnostic tail after processing.
 */
export function retainHarnessNotification(notification: HarnessNotification): HarnessNotification {
  return compactDiagnosticValue(notification, 0) as HarnessNotification
}

function compactDiagnosticValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return retainText(value, MAX_RETAINED_NOTIFICATION_STRING_CHARS).text
  }
  if (value === null || typeof value !== 'object') return value
  if (depth >= 12) return '[diagnostic depth truncated]'

  if (Array.isArray(value)) {
    const limit = 128
    if (value.length <= limit) return value.map(item => compactDiagnosticValue(item, depth + 1))
    const head = value.slice(0, 96).map(item => compactDiagnosticValue(item, depth + 1))
    const tail = value.slice(-31).map(item => compactDiagnosticValue(item, depth + 1))
    return [...head, `[${value.length - 127} array items evicted from local retention]`, ...tail]
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const limit = 128
  const selected = entries.length <= limit
    ? entries
    : [...entries.slice(0, 96), ...entries.slice(-31)]
  const result: Record<string, unknown> = {}
  for (const [key, item] of selected) result[key] = compactDiagnosticValue(item, depth + 1)
  if (entries.length > limit) result.__dshcRetention = `${entries.length - 127} object fields evicted`
  return result
}
