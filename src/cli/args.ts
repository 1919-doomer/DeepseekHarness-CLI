import { DshcRuntimeError } from '../upstream/errors.js'

export interface CliOptions {
  prompt?: string
  workspace?: string
  provider?: string
  model?: string
  sessionId?: string
  maxTokens?: number
  activityTimeoutMs?: number
  requestTimeoutMs?: number
  runtimeConfig?: string
  json: boolean
  debug: boolean
  help: boolean
  version: boolean
}

export function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    json: false,
    debug: false,
    help: false,
    version: false,
  }
  const positional: string[] = []
  let index = 0

  if (argv[0] === 'run') index++

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

export const HELP_TEXT = `DeepSeek Harness Console (M1 one-shot mode)

Usage:
  dshc [run] [options] <prompt>
  echo "prompt" | dshc [options]

Options:
  -C, --workspace <path>          Workspace (default: current directory)
      --provider <id>             Harness provider (default: deepseek-official)
      --model <id>                Harness model (default: deepseek-v4-flash)
      --session <id>              Explicit session id
      --max-tokens <n>            Positive output-token cap
      --activity-timeout-ms <n>   Bound receipt-to-idle collection
      --request-timeout-ms <n>    Bound individual JSON-RPC requests
      --runtime-config <path>     Override runtime Cordis config
      --json                      Emit one machine-readable result object
      --debug                     Show compatibility and unknown-event diagnostics
  -h, --help                      Show help
  -v, --version                   Show version

M1 is intentionally one-shot. Persistent multi-turn interaction belongs to M2.
`
