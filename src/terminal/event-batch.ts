import type { NormalizedEvent } from '../session/projection.js'
import { sanitizeTerminalText } from './sanitize.js'

/** Batches presentation only; the runtime observes every original event. */
export class TerminalEventBatch {
  private events: NormalizedEvent[] = []
  private chars = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  constructor(private readonly publish: (events: readonly NormalizedEvent[]) => void,
    private readonly intervalMs = 33) {}
  get closed(): boolean { return this.stopped }
  push(event: NormalizedEvent): void {
    if (this.stopped) return
    this.events.push(event)
    this.chars += 'text' in event ? event.text.length : 0
    if (event.kind !== 'assistant-delta' || this.events.length >= 128 || this.chars >= 65_536) this.flush()
    else this.timer ??= setTimeout(() => this.flush(), this.intervalMs)
  }
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const events = this.events
    this.events = []
    this.chars = 0
    if (events.length > 0 && !this.stopped) this.publish(events)
  }
  close(): void { this.flush(); this.stopped = true }
}

/** Trace keeps original envelopes. Sanitize chunks before joining, preserving
 * the existing split-control boundary. Custom renderers receive original events. */
export function coalesceTranscriptDeltas(events: readonly NormalizedEvent[],
  hasRenderer: (event: NormalizedEvent) => boolean): readonly NormalizedEvent[] {
  const specialized = (event: NormalizedEvent): boolean => {
    try { return hasRenderer(event) } catch { return true } // reducer owns plugin failure reporting
  }
  const result: NormalizedEvent[] = []
  for (const event of events) {
    const previous = result.at(-1)
    if (event.kind !== 'assistant-delta' || specialized(event)) { result.push(event); continue }
    const text = sanitizeTerminalText(event.text)
    if (previous?.kind === 'assistant-delta' && previous.sessionId === event.sessionId && !specialized(previous)) {
      result[result.length - 1] = { ...previous, text: previous.text + text }
    } else result.push({ ...event, text })
  }
  return result
}
