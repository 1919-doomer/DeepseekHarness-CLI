import { DEFAULT_PREFERENCES, LOCALES, WORK_MODES, OUTPUT_STYLES, validatePreferences, type Preferences } from '../preferences.js'
import { resolveLocale, translate } from '../i18n.js'
import { TERMINAL_PLUGIN_API_VERSION, type TerminalCommandContext, type TerminalCommandOutcome, type TerminalPluginSpec } from './api.js'
import type { HarnessRuntimeMetadata } from '../upstream/runtime.js'

export function preferencesPlugin(): TerminalPluginSpec {
  const fields = { language: 'locale', 'reply-language': 'replyLanguage', mode: 'mode', style: 'style', effort: 'reasoningEffort' } as const
  return { id: 'dshc.preferences', version: '1.0.0', apiVersion: TERMINAL_PLUGIN_API_VERSION,
    commands: [{ name: 'audit', summary: 'Review each turn that changed something', usage: '/audit [on|off]', execute(context, args) {
      if (args.length > 1 || (args[0] !== undefined && !['on', 'off'].includes(args[0]))) throw new Error('usage: /audit [on|off]')
      const zh = (context.locale ?? resolveLocale()) === 'zh-CN'
      if (args[0] === undefined) {
        const on = (context.preferences?.operationReview ?? DEFAULT_PREFERENCES.operationReview) !== false
        return { kind: 'message', title: 'audit', text: zh
          ? `操作审查：${on ? '开' : '关'}。每个有改动的回合结束后，用一个只能读文件的独立会话，把做了什么和你要求的、它计划的、它声称的对照一遍。每次审查多一次模型调用，模型和强度与主会话相同。/audit on|off 切换。`
          : `Operation review: ${on ? 'on' : 'off'}. After each turn that changed something, a separate read-only session compares what was done with what was asked, planned and claimed. Each review is one more model call, on the same model and effort as the session. /audit on|off switches it.` }
      }
      return { kind: 'preferences', patch: { operationReview: args[0] === 'on' } }
    } }, { name: 'sidebar', summary: 'Switch overview and tools sidebar', usage: '/sidebar [overview|tools]', execute(_context, args) {
      if (args.length > 1 || (args[0] !== undefined && !['overview', 'tools'].includes(args[0]))) throw new Error('usage: /sidebar [overview|tools]')
      return { kind: 'sidebar', page: args[0] as 'overview' | 'tools' | undefined }
    } }, { name: 'plan', summary: 'Enter read-only interactive planning', usage: '/plan [--yes]', execute(context, args) {
      if (args.some(arg => arg !== '--yes')) throw new Error('usage: /plan [--yes]')
      // No confirmation needed: switching in place keeps the conversation.
      // --yes only matters as consent to a restart if in-place switching fails.
      return { kind: 'switch-mode', mode: 'plan', allowRestart: args.includes('--yes') }
    } }, { name: 'profile', summary: 'Select bundled runtime or an official SDK Profile', usage: '/profile <bundled|name> [--yes]',
      execute(context: TerminalCommandContext, args: readonly string[]): TerminalCommandOutcome {
        const values = args.filter(arg => arg !== '--yes')
        if (values.length > 1) throw new Error('usage: /profile <bundled|name> [--yes]')
        const name = values[0]
        if (!name) return { kind: 'message', title: 'profile', text: JSON.stringify(context.runtime.profile ?? { backend: context.runtime.backend ?? 'bundled' }, null, 2) }
        const patch = name === 'bundled' ? { runtime: 'bundled' as const } : validatePreferences({ runtime: 'dsh-profile', dshProfile: name })
        if (!args.includes('--yes')) return { kind: 'message', title: 'profile', text: restartPreview(context.locale ?? 'en', 'profile', name) }
        return { kind: 'restart-runtime', selection: patch, summary: `Profile ${name}` }
      } }, ...Object.entries(fields).map(([name, field]) => ({ name,
      summary: `Configure ${field}`, usage: `/${name} <value>${field === 'mode' || field === 'style' || field === 'reasoningEffort' ? ' [--yes]' : ''}`,
      execute(context: TerminalCommandContext, args: readonly string[]): TerminalCommandOutcome {
        const locale = context.locale ?? resolveLocale()
        const values = args.filter(arg => arg !== '--yes')
        if (values.length === 0) {
          const value = String(context.preferences?.[field] ?? DEFAULT_PREFERENCES[field] ?? 'adapter default')
          const choices = field === 'mode' ? WORK_MODES : field === 'style' ? OUTPUT_STYLES
            : field === 'locale' || field === 'replyLanguage' ? LOCALES : undefined
          return { kind: 'message', title: name,
            text: choices ? translate(locale, 'currentChoices', { value, options: choices.join(' | ') }) : value }
        }
        if (values.length !== 1) throw new Error(`usage: /${name} <value>`)
        const patch = validatePreferences({ [field]: values[0] })
        if (field === 'locale' || field === 'replyLanguage') return { kind: 'preferences', patch }
        if (field === 'mode' && patch.mode !== undefined) {
          return { kind: 'switch-mode', mode: patch.mode, allowRestart: args.includes('--yes') }
        }
        if (!args.includes('--yes')) return { kind: 'message', title: name, text: restartPreview(locale, name, values[0]!) }
        return { kind: 'restart-runtime', selection: patch, summary: `${name}: ${values[0]}` }
      },
    }))],
  }
}

function restartPreview(locale: 'en' | 'zh-CN', name: string, value: string): string {
  return translate(locale, 'confirmCommand', {
    selection: `${name}: ${value}`, warning: translate(locale, 'restart'), command: `/${name} ${value} --yes`,
  })
}

export function describePreferences(preferences: Partial<Preferences>, locale = resolveLocale(preferences.locale), runtime?: HarnessRuntimeMetadata): string {
  const applied = runtime?.requestedPreferences ?? DEFAULT_PREFERENCES
  const pending = (['replyLanguage', 'mode', 'style', 'reasoningEffort', 'runtime', 'dshProfile'] as const)
    .filter(key => (preferences[key] ?? DEFAULT_PREFERENCES[key]) !== (applied[key] ?? DEFAULT_PREFERENCES[key]))
  return [
    `${translate(locale, 'backend')}: ${runtime?.backend ?? preferences.runtime ?? 'bundled'}`,
    `${translate(locale, 'requested')}: ${JSON.stringify(preferences)}`,
    `${translate(locale, 'startupSettings')}: ${JSON.stringify(applied)}`,
    `${translate(locale, 'settingSources')}: ${JSON.stringify(runtime?.preferenceSources ?? {})}`,
    `${translate(locale, 'pending')}: ${pending.join(', ') || '—'}`,
    ...(runtime ? [`${translate(locale, 'observed')}: ${runtime.serverName}/${runtime.protocolVersion}`] : []),
    ...(runtime?.profile ? [`Profile: ${runtime.profile.name}`, ...runtime.profile.configurationSources] : []),
  ].join('\n')
}
