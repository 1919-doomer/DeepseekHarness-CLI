import { TERMINAL_PLUGIN_API_VERSION, type TerminalPluginSpec } from './api.js'
import { expandTemplate } from '../terminal/input-actions.js'

export function inputPlugin(): TerminalPluginSpec {
  return { id: 'dshc.input', version: '1.0.0', apiVersion: TERMINAL_PLUGIN_API_VERSION, commands: [
    { name: 'template', summary: 'Expand a text template into the editor', usage: '/template <name> [arguments]',
      async execute(context, args) {
        if (!args[0]) throw new Error('usage: /template <name> [arguments]')
        return { kind: 'edit-input', text: await expandTemplate(context.runtime.workspace, args[0], args.slice(1)) }
      } },
    { name: 'edit', summary: 'Open the external editor', execute: () => ({ kind: 'external-editor' }) },
    { name: 'queue', summary: 'List, edit, remove, withdraw or resume pending messages',
      usage: '/queue [list|remove N|edit N text|withdraw|resume]', execute: () => ({ kind: 'message', text: 'The pending queue is owned by the interactive terminal.' }) },
  ] }
}
