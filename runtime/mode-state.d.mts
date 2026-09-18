export declare const WORK_MODES: readonly string[]

export declare const modeState: {
  get(): string
  set(mode: string): boolean
  subscribe(listener: (mode: string, previous: string) => void): () => void
}
