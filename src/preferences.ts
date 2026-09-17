import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export const LOCALES = ['auto', 'zh-CN', 'en'] as const
export const WORK_MODES = ['code', 'plan', 'review', 'research'] as const
export const OUTPUT_STYLES = ['default', 'explanatory', 'learning'] as const
export type LocaleSetting = typeof LOCALES[number]
export type WorkMode = typeof WORK_MODES[number]
export type OutputStyle = typeof OUTPUT_STYLES[number]
export type RuntimeBackend = 'bundled' | 'dsh-profile'
export interface Preferences {
  animation?: boolean
  subagentWindows?: boolean
  locale: LocaleSetting
  replyLanguage: string
  mode: WorkMode
  style: OutputStyle
  runtime: RuntimeBackend
  dshProfile: string
  /** Adapter-owned identifier, never interpreted as a universal enum. */
  reasoningEffort?: string
  keybindings?: { externalEditor?: string; withdrawQueue?: string }
  /** Executable + argv; no shell evaluation. */
  externalEditor?: string[]
}
export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
  locale: 'auto', replyLanguage: 'auto', mode: 'code', style: 'default', runtime: 'bundled', dshProfile: 'sdk', animation: true, subagentWindows: true,
})
export interface ResolvedPreferences {
  values: Preferences
  sources: Partial<Record<keyof Preferences, 'cli' | 'workspace' | 'user' | 'default'>>
  workspacePath: string
  userPath: string
}
export function pickPreferences(value: Partial<Preferences>): Partial<Preferences> {
  return validatePreferences(Object.fromEntries(
    ['locale', 'replyLanguage', 'mode', 'style', 'runtime', 'dshProfile', 'reasoningEffort', 'externalEditor', 'keybindings', 'animation', 'subagentWindows']
      .flatMap(key => {
        const item = value[key as keyof Preferences]
        return item === undefined ? [] : [[key, item]]
      }),
  ))
}
export function preferencePaths(workspace: string, env: NodeJS.ProcessEnv = process.env) {
  return { workspacePath: join(resolve(workspace), '.dshc', 'settings.json'),
    userPath: join(env.DSHC_HOME ?? join(homedir(), '.dshc'), 'settings.json') }
}
export async function resolvePreferences(workspace: string, cli: Partial<Preferences> = {},
  env: NodeJS.ProcessEnv = process.env): Promise<ResolvedPreferences> {
  const paths = preferencePaths(workspace, env)
  const values = { ...DEFAULT_PREFERENCES }
  const sources: ResolvedPreferences['sources'] = Object.fromEntries(Object.keys(values).map(key => [key, 'default']))
  for (const [source, patch] of [
    ['user', await readPreferences(paths.userPath)], ['workspace', await readPreferences(paths.workspacePath)],
    ['cli', validatePreferences(Object.fromEntries(Object.entries(cli).filter(([, value]) => value !== undefined)))],
  ] as const) {
    Object.assign(values, patch)
    for (const key of Object.keys(patch) as (keyof Preferences)[]) sources[key] = source
  }
  return { values, sources, ...paths }
}
export async function readPreferences(path: string): Promise<Partial<Preferences>> {
  try { return validatePreferences(JSON.parse(await readFile(path, 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`Invalid preferences at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
export function validatePreferences(value: unknown): Partial<Preferences> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be an object')
  const result: Partial<Preferences> = {}
  const input = value as Record<string, unknown>
  const enums = { locale: LOCALES, mode: WORK_MODES, style: OUTPUT_STYLES, runtime: ['bundled', 'dsh-profile'] } as const
  for (const key of Object.keys(input)) {
    const value = input[key]
    if (key in enums) {
      const allowed: readonly string[] = enums[key as keyof typeof enums]
      if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`Invalid ${key}; expected ${allowed.join(', ')}`)
    } else if (key === 'animation' || key === 'subagentWindows') {
      if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
    } else if (key === 'replyLanguage') {
      if (typeof value !== 'string' || !/^(auto|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(value)) throw new Error('Invalid replyLanguage')
    } else if (key === 'dshProfile') {
      if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error('Invalid dshProfile')
    } else if (key === 'reasoningEffort') {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error('Invalid adapter effort identifier')
    } else if (key === 'externalEditor') {
      if (!Array.isArray(value) || value.length === 0 || value.some(v => typeof v !== 'string' || v.includes('\0') || /[\r\n]/.test(v))) throw new Error('externalEditor must be an executable/argv array')
    } else if (key === 'keybindings') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid keybindings')
      for (const [action, binding] of Object.entries(value)) {
        if (!['externalEditor', 'withdrawQueue'].includes(action) || typeof binding !== 'string' || !/^ctrl\+[a-z]$/.test(binding) || ['ctrl+c', 'ctrl+d'].includes(binding)) throw new Error('Invalid or reserved keybinding')
      }
      const bindings = Object.values({ externalEditor: 'ctrl+g', withdrawQueue: 'ctrl+o', ...value })
      if (new Set(bindings).size !== bindings.length) throw new Error('Duplicate keybinding')
    } else throw new Error(`Unknown settings key: ${key}; credentials belong to the provider configuration`)
    Object.assign(result, { [key]: value })
  }
  return result
}
export async function savePreferences(path: string, patch: Partial<Preferences>): Promise<void> {
  const next = validatePreferences({ ...await readPreferences(path), ...patch })
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}
