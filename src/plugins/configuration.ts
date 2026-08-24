import { sanitizeTerminalText } from '../terminal/sanitize.js'
import {
  TERMINAL_PLUGIN_API_VERSION,
  type TerminalCommandOutcome,
  type TerminalPluginSpec,
  type TerminalViewContext,
} from './api.js'

/**
 * Every configuration change restarts the runtime, and a restart starts a new
 * session. That has to be known before committing, not discovered afterwards,
 * so a change is stated first and applied only when confirmed.
 */
export const CONFIRM_TOKEN = '--yes'

export const CONFIG_USAGE = [
  'Configuration is applied by restarting the Harness runtime, because protocol',
  '0.0.1 exposes no way to reconfigure a live one. A restart starts a NEW',
  'session: the current conversation does not carry over.',
  '',
  'Each command states the change and does nothing until confirmed:',
  '',
  '  /model <id> [--yes]        select a different model',
  '  /provider <id> [--yes]     select a different provider',
  '  /reload [path] [--yes]     restart, optionally with another composition file',
  '  /config                    show shipped, patched and effective configuration',
  '  /config fork               create an empty workspace patch layer',
  '',
  'Patches at <workspace>/.dshc/cordis.patch.yml are applied over the shipped',
  'composition on every launch. --runtime-config selects an explicit base and',
  'does not inherit the workspace patch.',
  'In --dev, the built-in trusted Cordis layer appears before the workspace patch.',
].join('\n')

export function configurationPlugin(): TerminalPluginSpec {
  return {
    id: 'dshc.configuration',
    version: '1.0.0',
    apiVersion: TERMINAL_PLUGIN_API_VERSION,
    commands: [
      {
        name: 'config',
        summary: 'Show base, patch and effective requested configuration; /config fork creates the patch',
        usage: '/config [fork]',
        execute: (context, args) => {
          if (args.length === 0) return { kind: 'view', viewId: 'config' }
          if (args.length === 1 && args[0]?.toLowerCase() === 'fork') {
            return { kind: 'fork-composition' }
          }
          return { kind: 'message', title: 'config', text: 'usage: /config [fork]' }
        },
      },
      {
        name: 'model',
        summary: 'Select a different model; restarts the runtime and starts a new session',
        usage: '/model <id> [--yes]',
        execute: (_context, args) => selectionCommand('model', args),
      },
      {
        name: 'provider',
        summary: 'Select a different provider; restarts the runtime and starts a new session',
        usage: '/provider <id> [--yes]',
        execute: (_context, args) => selectionCommand('provider', args),
      },
      {
        name: 'reload',
        summary: 'Restart the runtime, optionally with another composition file',
        usage: '/reload [path] [--yes]',
        execute: (_context, args) => reloadCommand(args),
      },
    ],
    views: [{ id: 'config', title: 'Runtime Configuration', render: renderConfiguration }],
  }
}

function selectionCommand(
  field: 'model' | 'provider',
  args: readonly string[],
): TerminalCommandOutcome {
  const values = args.filter(arg => arg !== CONFIRM_TOKEN)
  const confirmed = args.includes(CONFIRM_TOKEN)
  const value = values[0]

  if (values.length !== 1 || value === undefined || value.length === 0) {
    return { kind: 'message', title: field, text: `usage: /${field} <id> [${CONFIRM_TOKEN}]` }
  }

  const safe = sanitizeTerminalText(value)
  if (!confirmed) {
    return {
      kind: 'message',
      title: field,
      text: [
        `Selecting ${field} ${safe} restarts the Harness runtime.`,
        '',
        'The current session ends and a new one begins; this conversation does',
        'not carry over, because protocol 0.0.1 has no way to reconfigure a live',
        'runtime and no way to resume a session.',
        '',
        `Run  /${field} ${safe} ${CONFIRM_TOKEN}  to proceed.`,
      ].join('\n'),
    }
  }

  return {
    kind: 'restart-runtime',
    selection: field === 'model' ? { model: value } : { provider: value },
    summary: `${field} ${safe}`,
  }
}

function reloadCommand(args: readonly string[]): TerminalCommandOutcome {
  const values = args.filter(arg => arg !== CONFIRM_TOKEN)
  const confirmed = args.includes(CONFIRM_TOKEN)
  const path = values[0]

  if (values.length > 1) {
    return { kind: 'message', title: 'reload', text: `usage: /reload [path] [${CONFIRM_TOKEN}]` }
  }

  const target = path === undefined
    ? 'the current composition'
    : sanitizeTerminalText(path)

  if (!confirmed) {
    return {
      kind: 'message',
      title: 'reload',
      text: [
        `Restarting the Harness runtime with ${target}.`,
        '',
        'The current session ends and a new one begins; this conversation does',
        'not carry over.',
        '',
        path === undefined
          ? 'dshc does not read the composition file, so whether the change is'
          : 'dshc does not interpret this file, so whether its contents are',
        'valid is decided by Harness at startup. Run dshc doctor afterwards to',
        'see what the new composition actually reports.',
        '',
        `Run  /reload ${path === undefined ? '' : `${target} `}${CONFIRM_TOKEN}  to proceed.`,
      ].join('\n'),
    }
  }

  return {
    kind: 'restart-runtime',
    selection: path === undefined ? {} : { runtimeConfig: path },
    summary: path === undefined ? 'the current composition' : target,
  }
}

/**
 * Reports the composition the runtime was launched with, read from the config
 * file rather than from the runtime. Protocol 0.0.1 exposes no plugin
 * inventory, so this is what dshc asked for — not confirmation of what loaded.
 */
function renderConfiguration(context: TerminalViewContext): string {
  const lines = [
    'Launched with',
    `  provider: ${sanitizeTerminalText(context.runtime.provider)}`,
    `  model: ${sanitizeTerminalText(context.runtime.model)}`,
    `  workspace: ${sanitizeTerminalText(context.runtime.workspace)}`,
    `  runtime: ${sanitizeTerminalText(context.runtime.serverName)}/${sanitizeTerminalText(context.runtime.protocolVersion)}`,
    '',
  ]

  const composition = context.composition
  if (composition === undefined) {
    lines.push('Composition file unavailable; dshc could not read the config it launched with.')
    return lines.join('\n')
  }

  lines.push(
    `Base composition (${composition.base.source})`,
    `  ${sanitizeTerminalText(composition.base.path)}`,
    ...renderPatchLayers(composition),
    '',
    'Effective requested configuration',
    'Protocol 0.0.1 exposes no runtime plugin inventory, so this is the composed',
    'request, not confirmation of what actually loaded. Harness owns the values.',
    '',
  )

  for (const entry of composition.entries) {
    const settings = entry.settings.length === 0
      ? ''
      : ` · ${entry.settings.map(setting => sanitizeTerminalText(setting)).join(', ')}`
    lines.push(`  ${sanitizeTerminalText(entry.id)}${settings}`)
  }

  lines.push('', CONFIG_USAGE)
  return lines.join('\n')
}

function renderPatchLayers(composition: NonNullable<TerminalViewContext['composition']>): string[] {
  const layers = composition.patches
  if (layers === undefined || layers.length === 0) {
    return [`Workspace patch: ${composition.patch === undefined ? 'none' : `${sanitizeTerminalText(composition.patch.path)} (${composition.patch.patchCount} patch entries)`}`]
  }
  return layers.map(layer => {
    const label = layer.kind === 'developer' ? 'Built-in developer patch' : 'Workspace patch'
    return `${label}: ${sanitizeTerminalText(layer.path)} (${layer.patchCount} patch entries)`
  })
}
