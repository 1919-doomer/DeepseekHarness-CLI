import { DshcRuntimeError } from '../upstream/errors.js'

export interface RuntimeCloseTarget {
  close(): Promise<void>
}

/**
 * Retain every runtime close task until terminal shutdown has observed it.
 *
 * A replacement may start serving before its predecessor finishes closing,
 * but ownership of that predecessor cannot disappear with a fire-and-forget
 * promise. Repeated tracking is safe because HarnessRuntime.close() is itself
 * idempotent and this map preserves the first returned task.
 */
export class RuntimeCloseTracker<T extends RuntimeCloseTarget = RuntimeCloseTarget> {
  private readonly tasks = new Map<T, Promise<void>>()

  track(runtime: T): Promise<void> {
    const existing = this.tasks.get(runtime)
    if (existing !== undefined) return existing

    const task = Promise.resolve().then(() => runtime.close())
    this.tasks.set(runtime, task)
    // The final drain owns the diagnostic. Attach a handler immediately so a
    // fast rejection cannot become an unhandled promise before terminal exit.
    void task.catch(() => undefined)
    return task
  }

  async drain(current: T): Promise<void> {
    this.track(current)
    const settled = await Promise.allSettled(this.tasks.values())
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length === 0) return

    const detail = failures
      .map(error => error instanceof Error ? error.message : String(error))
      .join('; ')
    const first = failures[0]
    throw new DshcRuntimeError(
      `Failed to close ${failures.length} owned Harness runtime${failures.length === 1 ? '' : 's'}: ${detail}`,
      'runtime',
      { cause: first instanceof Error ? first : undefined },
    )
  }
}
