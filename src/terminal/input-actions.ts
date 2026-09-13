import { spawn } from 'node:child_process'
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { readBoundedFile } from '../upstream/bounded-file.js'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { preferencePaths, type Preferences } from '../preferences.js'

export const MAX_INPUT_CHARS = 262_144

/** Directory enumeration only: selected files are never opened or uploaded. */
export async function completeFileReference(workspace: string, input: string): Promise<string[]> {
  const match = /(?:^|\s)@("[^"]*|[^\s]*)$/.exec(input)
  if (!match) return []
  const token = match[1]!.replace(/^"/, '')
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'))
  const directory = slash < 0 ? '' : token.slice(0, slash + 1)
  const prefix = token.slice(slash + 1)
  const location = resolve(workspace, directory || '.')
  // Explicit references may address files outside the workspace. This function
  // still enumerates paths only; the Harness owns subsequent read policy.
  const entries = await readdir(location, { withFileTypes: true })
  return entries.filter(entry => !['.git', 'node_modules'].includes(entry.name)
    && entry.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40)
    .map(entry => {
      const path = `${directory}${entry.name}${entry.isDirectory() ? '/' : ''}`.replaceAll('\\', '/')
      const reference = /\s/.test(path) ? `@"${path}"` : `@${path}`
      return input.slice(0, input.length - match[1]!.length - 1) + reference
    })
}

async function boundedText(path: string): Promise<string> {
  return (await readBoundedFile(path, MAX_INPUT_CHARS)).toString('utf8')
}

/** Templates are Markdown text with $1..$9 and $ARGUMENTS substitution only. */
export async function expandTemplate(workspace: string, name: string, args: readonly string[],
  env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw new Error('Invalid template name')
  const paths = preferencePaths(workspace, env)
  for (const root of [join(dirname(paths.workspacePath), 'templates'), join(dirname(paths.userPath), 'templates')]) {
    try {
      const candidate = await realpath(join(root, `${name}.md`))
      const base = await realpath(root)
      const rel = relative(base, candidate)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Template symlink escapes its directory')
      return (await boundedText(candidate)).replace(/\$ARGUMENTS|\$[1-9]/g,
        token => token === '$ARGUMENTS' ? args.join(' ') : args[Number(token.slice(1)) - 1] ?? '')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  throw new Error(`Template ${name} was not found in .dshc/templates or the user templates directory`)
}

export async function editExternally(text: string, preferences: Partial<Preferences>, workspace: string,
  suspend: (callback: () => Promise<void>) => Promise<void>, signal?: AbortSignal): Promise<string> {
  const command = preferences.externalEditor ?? [process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad.exe' : 'vi')]
  if (!command[0]) throw new Error('Configure externalEditor as [executable, ...arguments]')
  const root = await mkdtemp(join(tmpdir(), 'dshc-editor-'))
  const path = join(root, 'prompt.md')
  try {
    await writeFile(path, text, { mode: 0o600 })
    await suspend(async () => {
      signal?.throwIfAborted()
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(command[0]!, [...command.slice(1), path], {
          cwd: workspace, shell: false, stdio: 'inherit', windowsHide: false,
          ...(signal === undefined ? {} : { signal }),
        })
        child.once('error', reject)
        child.once('close', code => code === 0 ? resolvePromise() : reject(new Error(`Editor exited with code ${code}`)))
      })
    })
    signal?.throwIfAborted()
    return await boundedText(path)
  } finally { await rm(root, { recursive: true, force: true }) }
}

export function keyMatches(input: string, ctrl: boolean, action: 'externalEditor' | 'withdrawQueue', preferences: Partial<Preferences>): boolean {
  const binding = preferences.keybindings?.[action] ?? (action === 'externalEditor' ? 'ctrl+g' : 'ctrl+o')
  return ctrl && binding === `ctrl+${input.toLowerCase()}`
}
