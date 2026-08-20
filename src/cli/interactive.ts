import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { INTERACTIVE_HELP, parseInteractiveInput } from '../commands/interactive.js'
import { installSignalHandlers, type SignalController } from '../lifecycle/signals.js'
import { InteractiveSessionState, type InteractiveSessionSnapshot } from '../session/interactive-state.js'
import { PlainRenderer } from '../terminal/plain-renderer.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { classifyRuntimeError } from '../upstream/errors.js'
import { HarnessRuntime, type HarnessRuntimeMetadata } from '../upstream/runtime.js'
import { DSHC_VERSION } from '../version.js'

export interface InteractiveLoopOptions {
  input?: Readable
  output?: Writable
  error?: Writable
  terminal?: boolean
  debug?: boolean
  initialSessionId?: string
  installSignals?: boolean
}

export interface InteractiveLoopResult {
  exitCode: number
  interrupted: boolean
  totalTurns: number
  session: InteractiveSessionSnapshot
}

type InteractivePhase = 'input' | 'running'

export async function runInteractiveLoop(
  runtime: HarnessRuntime,
  options: InteractiveLoopOptions = {},
): Promise<InteractiveLoopResult> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const errorOutput = options.error ?? process.stderr
  const terminal = options.terminal ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)
  const state = new InteractiveSessionState(options.initialSessionId)
  const renderer = new PlainRenderer({ output, debugUnknownEvents: options.debug })
  const metadata = await runtime.start()
  const rl = createInterface({ input, output, terminal, crlfDelay: Infinity })
  let phase: InteractivePhase = 'input'
  let totalTurns = 0

  const signals = options.installSignals === false
    ? inertSignalController()
    : installSignalHandlers(runtime, {
      onSignal: (signal) => {
        if (phase === 'running') {
          errorOutput.write(
            `\ndshc: ${signal} closes the entire Harness runtime; DeepSeek Harness ${metadata.protocolVersion} has no prompt-level cancel.\n`,
          )
        } else {
          errorOutput.write(`\ndshc: ${signal}; closing the Harness runtime.\n`)
        }
        rl.close()
      },
      onCloseError: (error) => {
        if (options.debug) {
          errorOutput.write(`dshc: signal cleanup: ${safeErrorMessage(error)}\n`)
        }
      },
    })

  writeBanner(output, metadata, state.sessionId)
  rl.setPrompt(promptFor(state.sessionId))
  if (terminal) rl.prompt()

  try {
    for await (const rawLine of rl) {
      if (signals.interrupted) break
      const action = parseInteractiveInput(rawLine)

      if (action.kind === 'empty') {
        promptAgain(rl, terminal, state.sessionId)
        continue
      }

      if (action.kind === 'unknown-command') {
        output.write(`dshc> unknown command ${sanitizeTerminalText(action.name)}; use /help\n`)
        promptAgain(rl, terminal, state.sessionId)
        continue
      }

      if (action.kind === 'command') {
        if (action.command === 'exit') break
        handleLocalCommand(action.command, output, terminal, state, metadata)
        promptAgain(rl, terminal, state.sessionId)
        continue
      }

      if (!terminal) output.write(`user> ${sanitizeTerminalText(action.text)}\n`)
      phase = 'running'
      if (terminal) rl.pause()
      try {
        const result = await runtime.run(action.text, {
          sessionId: state.sessionId,
          onEvent: (event) => renderer.render(event),
        })
        renderer.finish()
        state.recordCompletedTurn()
        totalTurns++
        if (result.projection.lastTurnError !== undefined) {
          errorOutput.write('dshc: the Harness turn ended with an error; the runtime remains open.\n')
        }
      } catch (error) {
        renderer.finish()
        if (signals.interrupted) break
        throw classifyRuntimeError(error)
      } finally {
        phase = 'input'
        if (terminal && !signals.interrupted) rl.resume()
      }

      promptAgain(rl, terminal, state.sessionId)
    }
  } finally {
    renderer.finish()
    rl.close()
    signals.dispose()
  }

  return {
    exitCode: signals.exitCode ?? 0,
    interrupted: signals.interrupted,
    totalTurns,
    session: state.snapshot(),
  }
}

function handleLocalCommand(
  command: 'help' | 'status' | 'session' | 'new' | 'clear',
  output: Writable,
  terminal: boolean,
  state: InteractiveSessionState,
  metadata: HarnessRuntimeMetadata,
): void {
  switch (command) {
    case 'help':
      output.write(INTERACTIVE_HELP)
      return
    case 'status':
      output.write(
        `status> runtime=ready provider=${sanitizeTerminalText(metadata.provider)} model=${sanitizeTerminalText(metadata.model)} session=${sanitizeTerminalText(state.sessionId)} turns=${state.turnCount} workspace=${sanitizeTerminalText(metadata.workspace)}\n`,
      )
      return
    case 'session':
      output.write(`session> ${sanitizeTerminalText(state.sessionId)} (turns=${state.turnCount})\n`)
      return
    case 'new': {
      const previous = state.sessionId
      const next = state.newSession()
      output.write(
        `session> new ${sanitizeTerminalText(next)} (previous ${sanitizeTerminalText(previous)} remains runtime-owned until exit; the current protocol has no session-close request)\n`,
      )
      return
    }
    case 'clear':
      if (terminal) output.write('\u001B[2J\u001B[H')
      else output.write('--- local terminal presentation cleared; Harness history unchanged ---\n')
      return
  }
}

function promptAgain(rl: ReturnType<typeof createInterface>, terminal: boolean, sessionId: string): void {
  if (!terminal) return
  rl.setPrompt(promptFor(sessionId))
  rl.prompt()
}

function promptFor(sessionId: string): string {
  const compact = sessionId.startsWith('session-') ? sessionId.slice(-8) : sessionId.slice(0, 12)
  return `dshc[${sanitizeTerminalText(compact)}]> `
}

function writeBanner(output: Writable, metadata: HarnessRuntimeMetadata, sessionId: string): void {
  output.write(
    `DeepSeek Harness Console ${DSHC_VERSION} · interactive M2\n`
    + `runtime ${sanitizeTerminalText(metadata.serverName)}/${sanitizeTerminalText(metadata.protocolVersion)} · ${sanitizeTerminalText(metadata.model)}\n`
    + `session ${sanitizeTerminalText(sessionId)} · /help for commands\n`,
  )
}

function safeErrorMessage(error: unknown): string {
  return sanitizeTerminalText(classifyRuntimeError(error).message)
}

function inertSignalController(): SignalController {
  return {
    interrupted: false,
    exitCode: undefined,
    dispose() {},
  }
}
