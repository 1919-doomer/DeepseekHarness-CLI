import { installSignalHandlers } from '../lifecycle/signals.js'
import { PlainRenderer } from '../terminal/plain-renderer.js'
import { runTerminalProduct } from '../terminal/product.js'
import { sanitizeTerminalText, stringifyTerminalSafeJson } from '../terminal/sanitize.js'
import { classifyRuntimeError, DshcRuntimeError } from '../upstream/errors.js'
import { HarnessRuntime } from '../upstream/runtime.js'
import { DSHC_VERSION } from '../version.js'
import { HELP_TEXT, parseCliArgs, type CliOptions } from './args.js'
import { collectDoctorReport, doctorExitCode, renderDoctorHuman } from './doctor.js'
import { runInteractiveLoop } from './interactive.js'

const MAX_STDIN_BYTES = 4 * 1024 * 1024

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options: CliOptions
  try {
    options = parseCliArgs(argv)
    validateModeOptions(options)
  } catch (error) {
    writeError(error)
    return 1
  }

  if (options.help) {
    process.stdout.write(HELP_TEXT)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${DSHC_VERSION}\n`)
    return 0
  }
  if (options.command === 'doctor') return runDoctorCommand(options)

  if (shouldRunInteractive(options)) return runInteractiveMode(options)

  let prompt = options.prompt
  if (prompt === undefined && !process.stdin.isTTY) {
    try {
      prompt = await readPromptFromStdin()
    } catch (error) {
      writeError(error)
      return 1
    }
  }
  if (prompt === undefined || prompt.trim().length === 0) {
    process.stderr.write('dshc: a prompt is required in one-shot mode. Use `dshc` without `run` to start the interactive terminal product.\n')
    return 1
  }

  return runOneShot(options, prompt)
}

function shouldRunInteractive(options: CliOptions): boolean {
  if (options.command === 'run' || options.command === 'doctor' || options.json) return false
  if (options.interactive) return true
  if (options.prompt !== undefined) return false
  return process.stdin.isTTY === true
}

function validateModeOptions(options: CliOptions): void {
  if (options.command === 'doctor') {
    if (options.interactive) {
      throw new DshcRuntimeError('`doctor` cannot be combined with `--interactive`.', 'configuration')
    }
    if (options.prompt !== undefined) {
      throw new DshcRuntimeError('`doctor` does not accept a positional prompt.', 'configuration')
    }
    if (options.sessionId !== undefined) {
      throw new DshcRuntimeError('`doctor` does not create or select a session; remove `--session`.', 'configuration')
    }
    if (options.maxTokens !== undefined) {
      throw new DshcRuntimeError('`doctor` does not issue a model request; remove `--max-tokens`.', 'configuration')
    }
    if (options.activityTimeoutMs !== undefined) {
      throw new DshcRuntimeError('`doctor` has no prompt activity; remove `--activity-timeout-ms`.', 'configuration')
    }
    return
  }

  if (!options.interactive) return
  if (options.command === 'run') {
    throw new DshcRuntimeError('`run` and `--interactive` select conflicting modes.', 'configuration')
  }
  if (options.prompt !== undefined) {
    throw new DshcRuntimeError('`--interactive` cannot be combined with a positional one-shot prompt.', 'configuration')
  }
  if (options.json) {
    throw new DshcRuntimeError('`--json` is a one-shot/doctor output mode and cannot be combined with `--interactive`.', 'configuration')
  }
}

function createRuntime(options: CliOptions): HarnessRuntime {
  return new HarnessRuntime({
    workspace: options.workspace,
    provider: options.provider,
    model: options.model,
    maxTokens: options.maxTokens,
    configPath: options.runtimeConfig,
    activityTimeoutMs: options.activityTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
  })
}

async function runDoctorCommand(options: CliOptions): Promise<number> {
  try {
    const report = await collectDoctorReport({
      workspace: options.workspace,
      provider: options.provider,
      model: options.model,
      configPath: options.runtimeConfig,
      requestTimeoutMs: options.requestTimeoutMs,
    })
    process.stdout.write(options.json
      ? `${stringifyTerminalSafeJson(report)}\n`
      : renderDoctorHuman(report))
    return doctorExitCode(report)
  } catch (error) {
    writeError(error)
    return 1
  }
}

async function runInteractiveMode(options: CliOptions): Promise<number> {
  const runtime = createRuntime(options)
  let primaryFailure = false
  let exitCode = 0

  try {
    if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
      // Ink installs its richer product-level SIGINT/SIGTERM handlers after it
      // has runtime metadata. This outer owner exists solely to cover the
      // startup interval as well; once Ink is active both handlers may call the
      // idempotent runtime.close(), but only the product decides its UI result.
      const startupSignals = installSignalHandlers(runtime, {
        onCloseError: (error) => {
          if (options.debug) process.stderr.write(`dshc: startup signal cleanup: ${safeErrorMessage(error)}\n`)
        },
      })
      try {
        const result = await runTerminalProduct(runtime, {
          initialSessionId: options.sessionId,
          debug: options.debug,
        })
        exitCode = result.exitCode
      } catch (error) {
        if (startupSignals.interrupted) {
          exitCode = startupSignals.exitCode ?? 130
        } else {
          throw error
        }
      } finally {
        startupSignals.dispose()
      }
    } else {
      const result = await runInteractiveLoop(runtime, {
        initialSessionId: options.sessionId,
        debug: options.debug,
      })
      exitCode = result.exitCode
    }
  } catch (error) {
    primaryFailure = true
    writeError(error)
    exitCode = 1
  } finally {
    try {
      await runtime.close()
    } catch (error) {
      if (!primaryFailure && exitCode === 0) {
        writeError(error)
        exitCode = 1
      } else if (options.debug) {
        process.stderr.write(`dshc: cleanup: ${safeErrorMessage(error)}\n`)
      }
    }
  }

  return exitCode
}

async function runOneShot(options: CliOptions, prompt: string): Promise<number> {
  const runtime = createRuntime(options)
  const renderer = options.json ? undefined : new PlainRenderer({
    debugUnknownEvents: options.debug,
    rootSessionId: options.sessionId,
  })
  const signals = installSignalHandlers(runtime, {
    onSignal: (signal) => {
      process.stderr.write(
        `\ndshc: ${signal} closes the entire Harness runtime; the current DSH protocol has no prompt-level cancel.\n`,
      )
    },
    onCloseError: (error) => {
      if (options.debug) process.stderr.write(`dshc: signal cleanup: ${safeErrorMessage(error)}\n`)
    },
  })

  let exitCode = 0
  let primaryFailure = false

  try {
    const metadata = await runtime.start()
    if (options.debug) {
      process.stderr.write(
        `dshc: runtime ${metadata.serverName}/${metadata.protocolVersion}; SDK ${metadata.sdkVersion ?? 'unverified'}; package ${metadata.runtimePackageVersion ?? 'unverified'}; model ${sanitizeTerminalText(metadata.model)}\n`,
      )
    }

    const result = await runtime.run(prompt, {
      sessionId: options.sessionId,
      onEvent: (event) => renderer?.render(event),
    })
    renderer?.finish()

    if (options.json) {
      process.stdout.write(`${stringifyTerminalSafeJson({
        sessionId: result.sessionId,
        messageId: result.messageId,
        finalResponse: result.finalResponse,
        turnError: result.projection.lastTurnError ?? null,
        eventCount: result.eventCount,
        retainedEventCount: result.events.length,
        droppedEventCount: result.droppedEventCount,
        notificationCount: result.notificationCount,
        retainedNotificationCount: result.notifications.length,
        droppedNotificationCount: result.droppedNotificationCount,
        unknownEventCount: result.projection.unknownEventCount,
        runtime: metadata,
      })}\n`)
    }

    if (result.projection.lastTurnError !== undefined) exitCode = 2
  } catch (error) {
    primaryFailure = true
    if (signals.interrupted) {
      exitCode = signals.exitCode ?? 130
    } else {
      writeError(error)
      exitCode = 1
    }
  } finally {
    renderer?.finish()
    signals.dispose()
    try {
      await runtime.close()
    } catch (error) {
      if (!primaryFailure && !signals.interrupted) {
        writeError(error)
        exitCode = 1
      } else if (options.debug) {
        process.stderr.write(`dshc: cleanup: ${safeErrorMessage(error)}\n`)
      }
    }
  }

  return exitCode
}

async function readPromptFromStdin(): Promise<string> {
  process.stdin.setEncoding('utf8')
  let input = ''
  let bytes = 0
  for await (const chunk of process.stdin) {
    const text = String(chunk)
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_STDIN_BYTES) throw new Error(`stdin prompt exceeds ${MAX_STDIN_BYTES} bytes`)
    input += text
  }
  return input.trimEnd()
}

function writeError(error: unknown): void {
  const classified = classifyRuntimeError(error)
  process.stderr.write(`dshc: ${sanitizeTerminalText(classified.message)}\n`)
}

function safeErrorMessage(error: unknown): string {
  return sanitizeTerminalText(classifyRuntimeError(error).message)
}
