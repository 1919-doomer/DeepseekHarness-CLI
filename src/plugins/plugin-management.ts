import { sanitizeTerminalText } from '../terminal/sanitize.js'
import {
  TERMINAL_PLUGIN_API_VERSION,
  type TerminalCommandOutcome,
  type TerminalPluginSpec,
} from './api.js'

const USAGE = [
  '/plugin search <terms>',
  '/plugin install <@deepseek-ai/package[@version]> [--yes]',
  '',
  'Install is restricted to @deepseek-ai packages. The first command resolves',
  'and displays an exact package@version; only that exact named command with',
  '--yes may change the workspace patch and restart the runtime.',
].join('\n')

export function pluginManagementPlugin(): TerminalPluginSpec {
  return {
    id: 'dshc.plugin-management',
    version: '1.0.0',
    apiVersion: TERMINAL_PLUGIN_API_VERSION,
    commands: [{
      name: 'plugin',
      summary: 'Search or transactionally install an @deepseek-ai Harness plugin',
      usage: '/plugin <search|install> ...',
      execute: (_context, args) => pluginCommand(args),
    }],
  }
}

function pluginCommand(args: readonly string[]): TerminalCommandOutcome {
  const action = args[0]?.toLowerCase()
  if (action === 'search') {
    const query = args.slice(1).join(' ').trim()
    return query.length === 0
      ? { kind: 'message', title: 'plugin', text: USAGE }
      : { kind: 'plugin-search', query }
  }
  if (action === 'install') {
    const confirmed = args.includes('--yes')
    const values = args.slice(1).filter(value => value !== '--yes')
    const spec = values[0]
    if (values.length !== 1 || spec === undefined) {
      return { kind: 'message', title: 'plugin', text: USAGE }
    }
    return { kind: 'plugin-install', spec: sanitizeTerminalText(spec), confirmed }
  }
  return { kind: 'message', title: 'plugin', text: USAGE }
}
