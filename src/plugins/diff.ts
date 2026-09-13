import { captureProcess } from '../upstream/process.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { resolveLocale, translate } from '../i18n.js'
import { TERMINAL_PLUGIN_API_VERSION, type TerminalPluginSpec } from './api.js'

export async function readWorkspaceDiff(workspace: string, staged = false, path?: string, signal?: AbortSignal): Promise<string> {
  const base = ['--no-pager', '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color',
    ...(staged ? ['--cached'] : [])]
  const selection = path === undefined ? [] : [`:(literal)${path}`]
  const options = { cwd: workspace, signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' } }
  const stats = await captureProcess('git', [...base, '--stat', '--', ...selection], options)
  if (!stats.trim()) return ''
  const diff = await captureProcess('git', [...base, '--', ...selection], options)
  return sanitizeTerminalText(`${staged ? 'staged' : 'unstaged'}\n${stats}\n${diff}`)
}
export function diffPlugin(): TerminalPluginSpec {
  let result = ''
  return { id: 'dshc.diff', version: '1.0.0', apiVersion: TERMINAL_PLUGIN_API_VERSION,
    views: [{ id: 'diff', title: 'Workspace changes', eventKinds: [], render: () => result }],
    commands: [{ name: 'diff', summary: 'Inspect tracked workspace changes without inferring ownership',
      usage: '/diff [staged|unstaged] [file]', execute: async (context, args, signal) => {
        const mode = args[0] ?? 'unstaged'
        if (!['staged', 'unstaged'].includes(mode) || args.length > 2) throw new Error('usage: /diff [staged|unstaged] [file]')
        const locale = context.locale ?? resolveLocale()
        const text = await readWorkspaceDiff(context.runtime.workspace, mode === 'staged', args[1], signal)
        result = `${translate(locale, 'diffTitle')}\n${text || translate(locale, 'noDiff')}`
        return { kind: 'view', viewId: 'diff' }
      } }],
  }
}
