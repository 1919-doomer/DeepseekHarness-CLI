/**
 * The work mode, as a value that can change while the runtime lives.
 *
 * Every dshc runtime plugin used to read DSHC_WORK_MODE once, at load. That
 * made the mode a property of the process, so the only way to change it was
 * to start another process — and protocol 0.0.1 has no session resume, so
 * every /plan or /code threw the conversation away.
 *
 * Nothing about a mode actually needs a new process. Its three effects are a
 * tool guard (a closure that can read this), a per-agent tool restriction
 * (which returns an exact disposer and can be swapped), and prompt text (a
 * runtime-context snapshot that is re-evaluated at each assembly). This module
 * is the one value they all read.
 */

export const WORK_MODES = ['code', 'plan', 'review', 'research']

function initialMode() {
  const requested = process.env.DSHC_WORK_MODE ?? 'code'
  if (!WORK_MODES.includes(requested)) throw new Error(`Unknown dshc work mode: ${requested}`)
  return requested
}

let current = initialMode()
const listeners = new Set()

export const modeState = {
  get() { return current },

  /**
   * Switch modes for the live runtime. Returns false when nothing changed, so
   * callers never replay listeners for a no-op.
   */
  set(mode) {
    if (!WORK_MODES.includes(mode)) throw new Error(`Unknown dshc work mode: ${mode}`)
    if (mode === current) return false
    const previous = current
    current = mode
    for (const listener of listeners) {
      // One listener failing must not leave the others on the old mode: a
      // half-applied switch is the worst available state for a permission.
      try { listener(mode, previous) } catch (error) {
        process.stderr.write(`dshc-mode: listener failed during ${previous} -> ${mode}: ${error instanceof Error ? error.message : String(error)}
`)
      }
    }
    return true
  },

  subscribe(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
}
