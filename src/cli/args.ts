import { DshcRuntimeError } from '../upstream/errors.js'

export interface CliOptions {
  command: 'auto' | 'run' | 'doctor'
  prompt?: string
  workspace?: string
  provider?: string
  model?: string
  sessionId?: string
  maxTokens?: number
  activityTimeoutMs?: number
  requestTimeoutMs?: number
  runtimeConfig?: string
  interactive: boolean
  json: boolean
  debug: boolean
  help: boolean
  version: boolean
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: 'auto',
    interactive: false,
    json: false,
    debug: false,
    help: false,
    version: false,
  }
  const positional: string[] = []
  let index = 0

  // pnpm and npm forward `--` into argv, so the documented `pnpm dev -- doctor`
  // arrives as ['--', 'doctor']. A leading `--` in front of an ordinary token
  // never meant anything the bare token did not already mean, so consume it
  // before subcommand detection. `dshc -- --dashed-prompt` keeps POSIX
  // end-of-options semantics, and `dshc run doctor` remains the explicit way to
  // send a subcommand name to the model as a prompt.
  if (argv[index] === '--' && !(argv[index + 1] ?? '-').startsWith('-')) index++

  const subcommand = argv[index]
  if (subcommand === 'run' || subcommand === 'doctor') {
    options.command = subcommand
    index++
  }

  while (index < argv.length) {
    const arg = argv[index]
    if (arg === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      index++
      continue
    }
    if (arg === '--version' || arg === '-v') {
      options.version = true
      index++
      continue
    }
    if (arg === '--interactive') {
      options.interactive = true
      index++
      continue
    }
    if (arg === '--json') {
      options.json = true
      index++
      continue
    }
    if (arg === '--debug') {
      options.debug = true
      index++
      continue
    }
    if (arg === '--workspace' || arg === '-C') {
      options.workspace = requireValue(argv, ++index, arg)
      index++
      continue
    }
    if (arg === '--provider') {
      options.provider = requireValue(argv, ++index, arg)
      index++
      continue
    }
    if (arg === '--model') {
      options.model = requireValue(argv, ++index, arg)
      index++
      continue
    }
    if (arg === '--session') {
      options.sessionId = requireValue(argv, ++index, arg)
      index++
      continue
    }
    if (arg === '--runtime-config') {
      options.runtimeConfig = requireValue(argv, ++index, arg)
      index++
      continue
    }
    if (arg === '--max-tokens') {
      options.maxTokens = positiveInteger(requireValue(argv, ++index, arg), arg)
      index++
      continue
    }
    if (arg === '--activity-timeout-ms') {
      options.activityTimeoutMs = positiveInteger(requireValue(argv, ++index, arg), arg)
      index++
      continue
    }
    if (arg === '--request-timeout-ms') {
      options.requestTimeoutMs = positiveInteger(requireValue(argv, ++index, arg), arg)
      index++
      continue
    }
    if (arg?.startsWith('-')) {
      throw new DshcRuntimeError(`Unknown option: ${arg}`, 'configuration')
    }
    if (arg !== undefined) positional.push(arg)
    index++
  }

  if (positional.length > 0) options.prompt = positional.join(' ')
  return options
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) {
    throw new DshcRuntimeError(`${flag} requires a value.`, 'configuration')
  }
  return value
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DshcRuntimeError(`${flag} must be a positive safe integer.`, 'configuration')
  }
  return value
}

export const HELP_TEXT = `DeepSeek Harness Console

Usage:
  dshc [options]                         Start the persistent interactive loop in a TTY
  dshc [options] <prompt>                Run one prompt and exit
  dshc run [options] <prompt>            Explicit one-shot mode
  dshc doctor [options]                  Diagnose workspace/runtime readiness without a model prompt
  echo "prompt" | dshc [options]          Read one prompt from stdin and exit
  printf "one\\ntwo\\n/exit\\n" | dshc --interactive

Options:
  -C, --workspace <path>          Workspace (default: current directory)
      --provider <id>             Harness provider (default: deepseek-official)
      --model <id>                Harness model (default: deepseek-v4-flash)
      --session <id>              Initial/one-shot session id
      --max-tokens <n>            Positive output-token cap
      --activity-timeout-ms <n>   Bound receipt-to-idle collection
      --request-timeout-ms <n>    Bound individual JSON-RPC requests
      --runtime-config <path>     Override runtime Cordis config
      --interactive               Force the persistent loop even when stdin is piped
      --json                      Emit machine-readable one-shot/doctor output
      --debug                     Show compatibility and unknown-event diagnostics
  -h, --help                      Show help
  -v, --version                   Show version

Doctor:
  dshc doctor never issues session/prompt. It checks the current workspace, pinned DSH packages,
  runtime config, initialize handshake, credential presence (never the value), TTY facts, shipped
  sandbox/approval defaults, protocol limitations and local retention policy.

Interactive commands:
  /help  /status  /session  /new  /clear  /exit

DeepSeek Harness protocol 0.0.1 exposes no prompt-level cancel or session-close request.
`
