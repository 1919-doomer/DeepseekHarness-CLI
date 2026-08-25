import { describe, expect, it, vi } from 'vitest'
import { RuntimeCloseTracker, type RuntimeCloseTarget } from '../../src/terminal/runtime-ownership.js'

function runtime(close: () => Promise<void>): RuntimeCloseTarget {
  return { close }
}

describe('runtime close ownership', () => {
  it('retains every retired runtime through final drain and reports close failures', async () => {
    let releaseMiddle!: () => void
    const firstClose = vi.fn(async () => undefined)
    const middleClose = vi.fn(() => new Promise<void>((_resolve, reject) => {
      releaseMiddle = () => reject(new Error('middle shutdown failed'))
    }))
    const currentClose = vi.fn(async () => undefined)
    const first = runtime(firstClose)
    const middle = runtime(middleClose)
    const current = runtime(currentClose)
    const tracker = new RuntimeCloseTracker()

    void tracker.track(first)
    void tracker.track(middle)
    expect(firstClose).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(firstClose).toHaveBeenCalledTimes(1)
    expect(middleClose).toHaveBeenCalledTimes(1)

    const drained = tracker.drain(current)
    await Promise.resolve()
    expect(currentClose).toHaveBeenCalledTimes(1)
    releaseMiddle()
    await expect(drained).rejects.toThrow('middle shutdown failed')
    expect(firstClose).toHaveBeenCalledTimes(1)
    expect(middleClose).toHaveBeenCalledTimes(1)
    expect(currentClose).toHaveBeenCalledTimes(1)
  })

  it('tracks one idempotent close task per runtime', async () => {
    const close = vi.fn(async () => undefined)
    const target = runtime(close)
    const tracker = new RuntimeCloseTracker()
    const first = tracker.track(target)
    const second = tracker.track(target)
    expect(second).toBe(first)
    await expect(tracker.drain(target)).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
