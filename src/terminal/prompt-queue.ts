export interface QueuedPrompt { id: number; sessionId: string; text: string }
/** A terminal outbox, never a Harness inbox or a persisted session. */
export class PromptQueue {
  private items: QueuedPrompt[] = []
  private serial = 0
  paused = false
  list(): readonly QueuedPrompt[] { return this.items.map(item => ({ ...item })) }
  add(sessionId: string, text: string): void {
    if (!text.trim()) return
    if (this.items.length >= 32 || this.items.reduce((n, item) => n + item.text.length, text.length) > 262_144) throw new Error('Pending prompt queue is full')
    this.items.push({ id: ++this.serial, sessionId, text })
  }
  remove(id: number): void {
    const index = this.items.findIndex(item => item.id === id)
    if (index < 0) throw new Error(`No queued prompt ${id}`)
    this.items.splice(index, 1)
  }
  edit(id: number, text: string): void {
    const item = this.items.find(item => item.id === id)
    if (item === undefined) throw new Error(`No queued prompt ${id}`)
    if (!text.trim() || this.items.reduce((n, entry) => n + (entry === item ? 0 : entry.text.length), text.length) > 262_144) throw new Error('Invalid queued prompt size')
    item.text = text
  }
  withdraw(): string | undefined { this.paused = true; return this.items.pop()?.text }
  pause(): void { this.paused = true }
  resume(sessionId: string): void {
    if (this.items.some(item => item.sessionId !== sessionId)) throw new Error('Queued messages belong to another session. Withdraw and resubmit them explicitly.')
    this.paused = false
  }
  take(sessionId: string): QueuedPrompt | undefined {
    if (this.paused) return undefined
    if (this.items[0]?.sessionId !== sessionId) { if (this.items.length) this.paused = true; return undefined }
    return this.items.shift()
  }
}
