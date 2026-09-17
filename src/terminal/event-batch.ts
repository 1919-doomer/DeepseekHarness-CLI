import type { NormalizedEvent } from '../session/projection.js'
import { sanitizeTerminalText } from './sanitize.js'

/** Batches presentation only; the runtime observes every original event. */
export class TerminalEventBatch {
  private events: NormalizedEvent[] = []
  private chars = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  constructor(private readonly publish: (events: readonly NormalizedEvent[]) => void,
    private readonly intervalMs = 33,
    /**
     * Receives anything `publish` throws. Publication runs plugin renderers,
     * transcript reducers and a React render, and a delta batch publishes from
     * a timer — so without this an ordinary rendering bug reached Node as an
     * uncaught exception and killed the process mid-answer, before the terminal
     * could be restored or the reason written anywhere the reader could see.
     */
    private readonly onPublishError?: (error: unknown) => void) {}
  get closed(): boolean { return this.stopped }
  push(event: NormalizedEvent): void {
    if (this.stopped) return
    this.events.push(event)
    this.chars += 'text' in event ? event.text.length : 0
    // Internal events carry nothing to display — reasoning chunks are the bulk
    // of them — but they are not `assistant-delta`, so they used to force a
    // synchronous publish, and with it a full render, for every reasoning token
    // the model produced. That defeated this batch exactly when it mattered:
    // the longest steps are the ones that reason most. They still reach /trace,
    // just on the same 33ms beat as text.
    const deferrable = event.kind === 'assistant-delta' || event.kind === 'internal'
    if (!deferrable || this.events.length >= 128 || this.chars >= 65_536) this.flush()
    else this.timer ??= setTimeout(() => this.flush(), this.intervalMs)
  }
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const events = this.events
    this.events = []
    this.chars = 0
    if (events.length === 0 || this.stopped) return
    try {
      this.publish(events)
    } catch (error) {
      // The batch is already cleared above, so the next flush drains new events
      // rather than retrying a batch that just failed.
      try { this.onPublishError?.(error) } catch { /* reporting must not be fatal either */ }
    }
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
