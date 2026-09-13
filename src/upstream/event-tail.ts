/** Mutable runtime-owned ring; only snapshots cross the public run() boundary. */
export class EventTail<T> {
  private values: T[] = []
  private cursor = 0
  total = 0
  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid event capacity')
  }
  push(value: T): void {
    this.total++
    if (this.values.length < this.capacity) this.values.push(value)
    else { this.values[this.cursor] = value; this.cursor = (this.cursor + 1) % this.capacity }
  }
  get dropped(): number { return Math.max(0, this.total - this.capacity) }
  snapshot(): T[] { return [...this.values.slice(this.cursor), ...this.values.slice(0, this.cursor)] }
}
