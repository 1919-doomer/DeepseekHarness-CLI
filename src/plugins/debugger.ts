import type { TerminalPluginSpec } from './api.js'
import { TERMINAL_PLUGIN_API_VERSION } from './api.js'
import { inspectDebugSession } from '../debugger/index.js'
import type { NormalizedEvent } from '../session/projection.js'

export function debuggerPlugin(events: readonly NormalizedEvent[]): TerminalPluginSpec {
  return {
    id: 'dshc.debugger',
    version: '1.0.0',
    apiVersion: TERMINAL_PLUGIN_API_VERSION,
    commands: [
      {
        name: 'debug',
        summary: 'Inspect retained session failures and runtime diagnostics',
        execute: () => ({
          kind: 'message',
          title: 'debug',
          text: inspectDebugSession(events),
        }),
      },
      {
        name: 'debug-failures',
        summary: 'Show only failed runtime events',
        execute: () => ({
          kind: 'message',
          title: 'debug failures',
          text: inspectDebugSession(events, { failuresOnly: true }),
        }),
      },
    ],
  }
}
