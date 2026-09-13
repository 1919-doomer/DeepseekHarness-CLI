import { toolProjectionKey, type NormalizedEvent } from '../session/projection.js'
export interface ActivityMetrics {
  elapsedMs: number; firstEventMs?: number; firstTextMs?: number; events: number; bytes: number
  peakEventsPerSecond: number; peakBytesPerSecond: number
  observedRequestMs: number; observedToolMs: number; toolCalls: number
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
}
/** Local observation spans include transport overhead; overlapping agents add
 * spans, so request/tool durations must not be subtracted from wall time. */
export class ActivityMeter {
  private started = performance.now()
  private firstEventMs?: number
  private firstTextMs?: number
  private events = 0; private bytes = 0
  private bucket = 0; private bucketEvents = 0; private bucketBytes = 0
  private peakEvents = 0; private peakBytes = 0
  private requests = new Map<string, number>()
  private tools = new Map<string, number>()
  private requestMs = 0; private toolMs = 0; private calls = 0
  private usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  observe(event: NormalizedEvent): void {
    const elapsed = performance.now() - this.started
    this.firstEventMs ??= elapsed
    const bucket = Math.floor(elapsed / 100)
    if (bucket !== this.bucket) { this.bucket = bucket; this.bucketEvents = 0; this.bucketBytes = 0 }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    this.events++; this.bytes += bytes; this.bucketEvents++; this.bucketBytes += bytes
    this.peakEvents = Math.max(this.peakEvents, this.bucketEvents * 10)
    this.peakBytes = Math.max(this.peakBytes, this.bucketBytes * 10)
    if (event.kind === 'assistant-delta') this.firstTextMs ??= elapsed
    if (event.kind === 'request-context') this.requests.set(event.sessionId, elapsed)
    if (event.kind === 'assistant-message') {
      const start = this.requests.get(event.sessionId)
      if (start !== undefined) { this.requestMs += elapsed - start; this.requests.delete(event.sessionId) }
      if (event.usage) for (const key of Object.keys(this.usage) as (keyof typeof this.usage)[]) this.usage[key] += event.usage[key] ?? 0
    }
    if (event.kind === 'tool-call') { this.calls++; this.tools.set(toolProjectionKey(event.sessionId, event.callId), elapsed) }
    if (event.kind === 'tool-result') {
      const key = toolProjectionKey(event.sessionId, event.callId); const start = this.tools.get(key)
      if (start !== undefined) { this.toolMs += elapsed - start; this.tools.delete(key) }
    }
    // Malformed/missing completions must not turn diagnostics into unbounded state.
    if (this.requests.size > 1024) this.requests.delete(this.requests.keys().next().value!)
    if (this.tools.size > 1024) this.tools.delete(this.tools.keys().next().value!)
  }
  snapshot(): ActivityMetrics {
    return { elapsedMs: performance.now() - this.started, firstEventMs: this.firstEventMs, firstTextMs: this.firstTextMs,
      events: this.events, bytes: this.bytes, peakEventsPerSecond: this.peakEvents, peakBytesPerSecond: this.peakBytes,
      observedRequestMs: this.requestMs, observedToolMs: this.toolMs, toolCalls: this.calls, usage: { ...this.usage } }
  }
}
