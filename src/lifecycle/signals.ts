export interface CloseableRuntime {
  close(): Promise<void>
}

export interface SignalHandlerOptions {
  onSignal?: (signal: NodeJS.Signals) => void
  onCloseError?: (error: unknown) => void
}

export interface SignalController {
  readonly interrupted: boolean
  readonly exitCode: number | undefined
  dispose(): void
}

/**
 * M1 owns one runtime process. A signal therefore closes that whole runtime;
 * it is never presented as prompt-level cancellation because DSH does not
 * expose such a wire operation yet.
 */
export function installSignalHandlers(
  runtime: CloseableRuntime,
  options: SignalHandlerOptions = {},
): SignalController {
  let interrupted = false
  let exitCode: number | undefined
  let closing = false

  const handle = (signal: NodeJS.Signals): void => {
    interrupted = true
    exitCode = signal === 'SIGINT' ? 130 : 143
    options.onSignal?.(signal)

    if (closing) return
    closing = true
    void runtime.close().catch((error) => options.onCloseError?.(error))
  }

  process.on('SIGINT', handle)
  process.on('SIGTERM', handle)

  return {
    get interrupted() {
      return interrupted
    },
    get exitCode() {
      return exitCode
    },
    dispose() {
      process.off('SIGINT', handle)
      process.off('SIGTERM', handle)
    },
  }
}
