import type { NormalizedEvent } from './projection.js'
export interface SessionTiming { elapsedMs: number; runningMs: number; waitingMs: number; turnMs: number }
export interface CompactionStats { state: 'none' | 'running' | 'completed' | 'failed'; count: number; elapsedMs?: number; shadowedTokens?: number; shadowedEvents?: number }
export class SessionClock {
  private session = ''
  private born = 0
  private turn?: number
  private lastTurn = 0
  private running = 0
  private waiting = 0
  private mark = 0
  private active = false
  private awaiting = false
  private compactStart?: number
  compaction: CompactionStats = { state: 'none', count: 0 }
  constructor(private now = () => performance.now()) {}
  reset(session: string): void {
    if (this.session === session) return
    this.session = session; this.born = this.mark = this.now(); this.turn = undefined
    this.lastTurn = this.running = this.waiting = 0; this.active = this.awaiting = false
    this.compactStart = undefined; this.compaction = { state: 'none', count: 0 }
  }
  private settle(): void { const now = this.now(); if (this.active) { if (this.awaiting) this.waiting += now - this.mark; else this.running += now - this.mark } this.mark = now }
  start(): void { this.settle(); this.turn = this.now(); this.active = true }
  wait(value: boolean): void { this.settle(); this.awaiting = value }
  stop(): void { this.settle(); this.lastTurn = this.turn === undefined ? 0 : this.now() - this.turn; this.turn = undefined; this.active = this.awaiting = false }
  snapshot(): SessionTiming {
    const delta = this.now() - this.mark
    return { elapsedMs: this.now() - this.born, runningMs: this.running + (this.active && !this.awaiting ? delta : 0),
      waitingMs: this.waiting + (this.active && this.awaiting ? delta : 0), turnMs: this.turn === undefined ? this.lastTurn : this.now() - this.turn }
  }
  observe(event: NormalizedEvent): void {
    if (!('sessionId' in event) || event.sessionId !== this.session) return
    if (event.kind === 'internal' && event.type === 'compaction/start') {
      this.compactStart = this.now(); this.compaction = { state: 'running', count: this.compaction.count }
    } else if (event.kind === 'context-compacted') {
      this.compaction = { state: 'completed', count: this.compaction.count + 1,
        elapsedMs: this.compactStart === undefined ? undefined : this.now() - this.compactStart,
        shadowedTokens: event.shadowedTokens, shadowedEvents: event.shadowedEvents }
    } else if ((event.kind === 'internal' && event.type === 'compaction/end') || event.kind === 'turn-error') {
      if (this.compaction.state === 'running') this.compaction = { state: 'failed', count: this.compaction.count,
        elapsedMs: this.compactStart === undefined ? undefined : this.now() - this.compactStart }
      this.compactStart = undefined
    }
  }
}
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
