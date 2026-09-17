import { describe, expect, it } from 'vitest'
import { TerminalEventBatch } from '../../src/terminal/event-batch.js'
import { describeCrash, restoreTerminalForCrash } from '../../src/terminal/crash-guard.js'
import type { NormalizedEvent } from '../../src/session/projection.js'

const delta = (text: string): NormalizedEvent =>
  ({ sequence: 1, kind: 'assistant-delta', sessionId: 'main', text })
const status = (sequence: number): NormalizedEvent =>
  ({ sequence, kind: 'session-status', sessionId: 'main', status: 'idle' })

/** Whatever escapes to the process while `run` is in flight, or `undefined`. */
async function escapedFromTimer(run: () => void, waitMs = 250): Promise<unknown> {
  return await new Promise(resolve => {
    const onUncaught = (error: unknown): void => { cleanup(); resolve(error) }
    const timer = setTimeout(() => { cleanup(); resolve(undefined) }, waitMs)
    function cleanup(): void {
      clearTimeout(timer)
      process.off('uncaughtException', onUncaught)
    }
    process.once('uncaughtException', onUncaught)
    run()
  })
}

describe('streaming publish failures', () => {
  it('does not escape into the timer callback that killed the process', async () => {
    // A delta is the one event kind that defers publication to a timer. Before
    // this was isolated, a throwing reducer, plugin renderer or render pass
    // reached Node as an uncaught exception, which exits immediately — without
    // running the finally that writes ALT_SCREEN_OFF. Node's report went into
    // the alternate screen buffer and vanished with it, so the product simply
    // disappeared mid-answer with nothing on screen to explain it.
    const failures: unknown[] = []
    const batch = new TerminalEventBatch(
      () => { throw new Error('reducer exploded') },
      20,
      error => { failures.push(error) },
    )

    const escaped = await escapedFromTimer(() => batch.push(delta('streaming')))

    expect(escaped).toBeUndefined()
    expect(failures).toHaveLength(1)
    expect((failures[0] as Error).message).toContain('reducer exploded')
  })

  it('reports a synchronous publish failure rather than throwing at the caller', () => {
    // Non-delta events publish immediately, on the runtime's own event callback,
    // where a throw would reject inside the SDK notification dispatch instead.
    const failures: unknown[] = []
    const batch = new TerminalEventBatch(
      () => { throw new Error('renderer exploded') },
      20,
      error => { failures.push(error) },
    )
    expect(() => batch.push(status(2))).not.toThrow()
    expect(failures).toHaveLength(1)
  })

  it('keeps draining after a failed batch instead of wedging the stream', () => {
    const published: number[] = []
    let first = true
    const batch = new TerminalEventBatch(events => {
      if (first) { first = false; throw new Error('first batch only') }
      published.push(events.length)
    }, 20, () => undefined)

    batch.push(status(3))
    batch.push(status(4))
    expect(published).toEqual([1])
  })

  it('never lets the failure reporter itself become the fatal error', () => {
    const batch = new TerminalEventBatch(
      () => { throw new Error('publish') },
      20,
      () => { throw new Error('reporter') },
    )
    expect(() => batch.push(status(5))).not.toThrow()
  })
})

describe('streaming cost', () => {
  const internal = (sequence: number): NormalizedEvent =>
    ({ sequence, kind: 'internal', sessionId: 'main', type: 'assistant/chunk' })

  it('batches reasoning chunks instead of rendering once per token', () => {
    // Reasoning deltas project to `internal`, which is not `assistant-delta`,
    // so each one used to force a synchronous publish and a full render. One
    // observed session streamed 4,776 events across 31 minutes before dying
    // mid-reasoning.
    let publishes = 0
    const batch = new TerminalEventBatch(() => { publishes += 1 }, 20, () => undefined)
    for (let index = 0; index < 50; index += 1) batch.push(internal(index))
    expect(publishes).toBe(0)
    batch.flush()
    expect(publishes).toBe(1)
  })

  it('still publishes an event the reader is waiting to see immediately', () => {
    let publishes = 0
    const batch = new TerminalEventBatch(() => { publishes += 1 }, 20, () => undefined)
    batch.push(status(9))
    expect(publishes).toBe(1)
  })

  it('does not let a long internal run sit unbounded', () => {
    let published = 0
    const batch = new TerminalEventBatch(events => { published += events.length }, 20, () => undefined)
    for (let index = 0; index < 300; index += 1) batch.push(internal(index))
    expect(published).toBeGreaterThan(0)
  })
})

describe('crash reporting', () => {
  it('leaves the alternate screen before writing, so the reason survives', () => {
    // Order is the whole point. Written while the alternate screen is still on,
    // the report lands in a buffer the terminal discards on exit.
    const writes: string[] = []
    restoreTerminalForCrash({
      stdout: { write: (chunk: string) => { writes.push(chunk); return true } },
      alternateEntered: true,
      stdin: { isTTY: true, setRawMode: () => undefined },
    })
    expect(writes.join('')).toContain('\u001B[?1049l')
  })

  it('does not leave the alternate screen this process never entered', () => {
    const writes: string[] = []
    restoreTerminalForCrash({
      stdout: { write: (chunk: string) => { writes.push(chunk); return true } },
      alternateEntered: false,
      stdin: { isTTY: true, setRawMode: () => undefined },
    })
    expect(writes.join('')).not.toContain('\u001B[?1049l')
  })

  it('restores cooked input so the shell is usable afterwards', () => {
    const modes: boolean[] = []
    restoreTerminalForCrash({
      stdout: { write: () => true },
      alternateEntered: false,
      stdin: { isTTY: true, setRawMode: (mode: boolean) => { modes.push(mode) } },
    })
    expect(modes).toEqual([false])
  })

  it('survives a terminal that cannot be restored', () => {
    // A crash is already the unhappy path; a stdout that has gone away must not
    // stop the raw-mode restore that leaves the shell usable.
    expect(() => restoreTerminalForCrash({
      stdout: { write: () => { throw new Error('stdout is gone') } },
      alternateEntered: true,
      stdin: { isTTY: true, setRawMode: () => { throw new Error('no raw mode') } },
    })).not.toThrow()
  })

  it('names the failure and says what was lost', () => {
    const report = describeCrash(new Error('reducer exploded'), 'en')
    expect(report).toContain('reducer exploded')
    // A report that does not say the session is gone invites the reader to wait
    // for a recovery that is never coming.
    expect(report).toContain('session ended')
  })

  it('reports a non-Error rejection without pretending it has a stack', () => {
    expect(describeCrash('plain string', 'en')).toContain('plain string')
    expect(describeCrash(undefined, 'en')).toContain('no reason reported')
  })

  it('reports in Chinese when that is the session language', () => {
    const report = describeCrash(new Error('boom'), 'zh-CN')
    expect(report).toContain('boom')
    expect(report).toMatch(/[\u4e00-\u9fa5]/)
  })
})
