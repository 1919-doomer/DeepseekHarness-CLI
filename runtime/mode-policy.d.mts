export declare const name: string
export declare const inject: readonly string[]
export declare function allowedToolsFor(mode: string, interactionAvailable: boolean): ReadonlySet<string> | undefined
export declare function modeContextText(mode: string, interactionAvailable: boolean): string
export declare function apply(ctx: unknown): void
