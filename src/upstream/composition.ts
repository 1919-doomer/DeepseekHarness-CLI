import { access, copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export interface CompositionEntry {
  /** Plugin id as written in the composition file. */
  id: string
  /** Setting lines under this entry, verbatim apart from whitespace. */
  settings: readonly string[]
}

/**
 * Where the composition dshc launched with came from.
 *
 * `workspace` exists because a fork that nothing ever reads is not a fork. Until
 * this was distinguished, `/config fork` wrote a file into the workspace and
 * every later launch silently used the shipped one instead unless the person
 * remembered `--runtime-config` by hand.
 */
export type CompositionSource = 'shipped-default' | 'workspace' | 'override'

export interface CompositionSummary {
  path: string
  source: CompositionSource
  entries: readonly CompositionEntry[]
}

/** Composition a workspace may carry, relative to its root. */
export const WORKSPACE_COMPOSITION_PATH = ['.dshc', 'cordis.yml'] as const

export function workspaceCompositionPath(workspace: string): string {
  return join(workspace, ...WORKSPACE_COMPOSITION_PATH)
}

export interface ResolvedComposition {
  path: string
  source: CompositionSource
}

/**
 * Decide which composition a launch uses: an explicit `--runtime-config` first,
 * then the workspace's own, then the shipped default.
 *
 * An explicit path is never second-guessed — if it does not exist the launch
 * must fail naming that path, rather than quietly falling back to a different
 * composition than the one that was asked for.
 */
export async function resolveComposition(
  workspace: string,
  explicit: string | undefined,
  shippedPath: string,
): Promise<ResolvedComposition> {
  if (explicit !== undefined) return { path: resolve(explicit), source: 'override' }

  const candidate = workspaceCompositionPath(workspace)
  try {
    await access(candidate)
    return { path: candidate, source: 'workspace' }
  } catch {
    return { path: shippedPath, source: 'shipped-default' }
  }
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
  source: CompositionSource,
): Promise<CompositionSummary | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }

  const entries: CompositionEntry[] = []
  let current: { id: string; settings: string[] } | undefined
  // Indent of the key that opened a `|`/`>` block scalar, while its body runs.
  let blockIndent: number | undefined
  let blockKey = ''
  let blockLines = 0
  let blockOwner: { settings: string[] } | undefined

  const closeBlock = (): void => {
    blockOwner?.settings.push(`${blockKey}: ${blockLines} line${blockLines === 1 ? '' : 's'}`)
    blockIndent = undefined
    blockOwner = undefined
    blockLines = 0
  }

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const indent = line.length - line.trimStart().length

    // A block scalar's body is prose — a persona is hundreds of words — and
    // listing it line by line would bury the settings this summary exists to
    // show. The key stays; the body is summarised by its line count.
    if (blockIndent !== undefined) {
      if (line.trim().length === 0 || indent > blockIndent) {
        if (line.trim().length > 0) blockLines += 1
        continue
      }
      closeBlock()
    }

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
    if (indent < 4) continue
    const setting = line.trim()
    if (setting.startsWith('-')) continue

    const block = /^([^:]+):\s*[|>][-+0-9]*$/.exec(setting)
    if (block?.[1] !== undefined) {
      blockIndent = indent
      blockKey = block[1]
      blockLines = 0
      blockOwner = current
      continue
    }
    current.settings.push(setting)
  }

  if (blockIndent !== undefined) closeBlock()
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
