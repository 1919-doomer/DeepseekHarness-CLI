import { copyFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readFile } from 'node:fs/promises'

export interface CompositionEntry {
  /** Plugin id as written in the composition file. */
  id: string
  /** Setting lines under this entry, verbatim apart from whitespace. */
  settings: readonly string[]
}

export interface CompositionSummary {
  path: string
  source: 'shipped-default' | 'override'
  entries: readonly CompositionEntry[]
}

/**
 * Read the composition dshc launched with, for display only.
 *
 * This is a shallow read of the file's own structure. dshc deliberately does
 * not parse the YAML into upstream's settings model, and does not know what any
 * of these values mean: encoding an upstream schema here is what turns a
 * release of theirs into a lie of ours. Harness owns the meaning; this reports
 * what was asked for.
 *
 * It is also not the runtime's inventory — protocol 0.0.1 exposes none — so the
 * caller must present it as requested configuration, never as confirmation of
 * what loaded.
 */
export async function readCompositionSummary(
  path: string,
  source: 'shipped-default' | 'override',
): Promise<CompositionSummary | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }

  const entries: CompositionEntry[] = []
  let current: { id: string; settings: string[] } | undefined

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue

    const entry = /^-\s+id:\s*(.+)$/.exec(line.trim())
    if (entry?.[1] !== undefined) {
      if (current !== undefined) entries.push(current)
      current = { id: entry[1].trim(), settings: [] }
      continue
    }

    if (current === undefined) continue
    // Settings sit deeper than the entry's own keys; anything at four spaces or
    // more belongs to a config block rather than to the entry itself.
    const indent = line.length - line.trimStart().length
    if (indent < 4) continue
    const setting = line.trim()
    if (setting.startsWith('-')) continue
    current.settings.push(setting)
  }

  if (current !== undefined) entries.push(current)
  return { path, source, entries }
}

export interface CompositionForkResult {
  path: string
  created: boolean
}

/**
 * Copy a composition so it can be edited without touching the shipped one.
 *
 * Refuses to overwrite: a fork that silently replaced local edits would lose
 * work, and there is no undo in a terminal.
 */
export async function forkComposition(
  from: string,
  to: string,
): Promise<CompositionForkResult> {
  await mkdir(dirname(to), { recursive: true })
  try {
    // COPYFILE_EXCL: fail rather than clobber an existing file.
    await copyFile(from, to, 1)
    return { path: to, created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { path: to, created: false }
    throw error
  }
}
