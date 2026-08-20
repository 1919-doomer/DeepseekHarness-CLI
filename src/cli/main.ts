import { installSignalHandlers } from '../lifecycle/signals.js'
import { PlainRenderer } from '../terminal/plain-renderer.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { classifyRuntimeError } from '../upstream/errors.js'
import { HarnessRuntime } from '../upstream/runtime.js'
import { DSHC_VERSION } from '../version.js'
import { HELP_TEXT, parseCliArgs } from './args.js'

const MAX_STDIN_BYTES = 4 * 1024 * 1024

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options
  try {
    options = parseCliArgs(argv)
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
    process.stderr.write('dshc: a prompt is required in M1 one-shot mode. Use --help for usage.\n')
    return 1
  }

  const runtime = new HarnessRuntime({
    workspace: options.workspace,
    provider: options.provider,
    model: options.model,
    maxTokens: options.maxTokens,
    configPath: options.runtimeConfig,
    activityTimeoutMs: options.activityTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
  })
  const renderer = options.json ? undefined : new PlainRenderer({ debugUnknownEvents: options.debug })
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
      process.stdout.write(`${JSON.stringify({
        sessionId: result.sessionId,
        messageId: result.messageId,
        finalResponse: result.finalResponse,
        turnError: result.projection.lastTurnError ?? null,
        eventCount: result.events.length,
        notificationCount: result.notifications.length,
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
    if (bytes > MAX_STDIN_BYTES) {
      throw new Error(`stdin prompt exceeds ${MAX_STDIN_BYTES} bytes`)
    }
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
