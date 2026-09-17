/**
 * Type surface for the steering plugin, which is plain ESM because it is loaded
 * into the Harness process by the Cordis loader rather than bundled with the
 * terminal. Declared here so tests import it typed instead of suppressed.
 */
export declare const name: string
export declare const inject: readonly string[]

/** Cordis plugin entry. Resolves once steering is registered, or degraded. */
export declare function apply(ctx: unknown): Promise<void>
