export type InteractiveCommand = 'help' | 'status' | 'session' | 'new' | 'clear' | 'exit'

export type InteractiveInput =
  | { kind: 'empty' }
  | { kind: 'prompt'; text: string }
  | { kind: 'command'; command: InteractiveCommand }
  | { kind: 'unknown-command'; name: string }

const COMMANDS = new Set<InteractiveCommand>(['help', 'status', 'session', 'new', 'clear', 'exit'])

export function parseInteractiveInput(raw: string): InteractiveInput {
  if (raw.trim().length === 0) return { kind: 'empty' }

  if (raw.startsWith('//')) {
    return { kind: 'prompt', text: raw.slice(1) }
  }

  if (!raw.startsWith('/')) {
    return { kind: 'prompt', text: raw }
  }

  const token = raw.trim().split(/\s+/, 1)[0] ?? ''
  const name = token.slice(1).toLowerCase()
  if (COMMANDS.has(name as InteractiveCommand) && raw.trim() === token) {
    return { kind: 'command', command: name as InteractiveCommand }
  }
  return { kind: 'unknown-command', name: token.length > 1 ? token : raw.trim() }
}

export const INTERACTIVE_HELP = `Interactive commands:
  /help       Show this command list
  /status     Show runtime, model, workspace, session, and turn status
  /session    Show the current Harness session id
  /new        Start a fresh Harness session without restarting the runtime
  /clear      Clear local terminal presentation only; Harness history is unchanged
  /exit       Close the Harness runtime and exit

Prefix a literal prompt beginning with / by doubling the slash, for example //review README.md.
`
