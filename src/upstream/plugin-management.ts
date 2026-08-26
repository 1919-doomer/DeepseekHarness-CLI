import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { healProfilesModuleFallback, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { dump } from 'js-yaml'
import { DshcRuntimeError } from './errors.js'

const execFileAsync = promisify(execFile)
const ALLOWED_SCOPE = '@deepseek-ai/'
const EXACT_VERSION = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?'
const PLUGIN_SPEC = new RegExp(`^(@deepseek-ai/[a-z0-9][a-z0-9._-]*)(?:@(${EXACT_VERSION}))?$`)

export interface PluginSearchResult {
  name: string
  version: string
  description: string
}

export type NpmRunner = (
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout?: number,
  signal?: AbortSignal,
) => Promise<string>

export interface ResolvedPluginSpec {
  name: string
  version: string
  exactSpec: string
}

export async function searchDeepseekPlugins(
  query: string,
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  runner: NpmRunner = runNpm,
  signal?: AbortSignal,
): Promise<readonly PluginSearchResult[]> {
  const term = query.trim()
  if (term.length === 0 || term.length > 120) {
    throw new DshcRuntimeError('Plugin search terms must contain 1–120 characters.', 'configuration')
  }
  const stdout = await runner(
    ['search', '--json', '--searchlimit=30', `${ALLOWED_SCOPE} ${term}`],
    workspace,
    env,
    undefined,
    signal,
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new DshcRuntimeError('The npm registry returned an unreadable plugin search response.', 'runtime', {
      cause: error instanceof Error ? error : undefined,
    })
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item): PluginSearchResult[] => {
    if (item === null || typeof item !== 'object') return []
    const value = item as Record<string, unknown>
    const name = value['name']
    const version = value['version']
    if (typeof name !== 'string' || !name.startsWith(ALLOWED_SCOPE) || typeof version !== 'string') return []
    return [{
      name,
      version,
      description: typeof value['description'] === 'string' ? value['description'] : '',
    }]
  }).slice(0, 12)
}

export async function resolveDeepseekPlugin(
  spec: string,
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  runner: NpmRunner = runNpm,
  signal?: AbortSignal,
): Promise<ResolvedPluginSpec> {
  const match = PLUGIN_SPEC.exec(spec)
  const name = match?.[1]
  const requestedVersion = match?.[2]
  if (name === undefined) {
    throw new DshcRuntimeError('Only @deepseek-ai/package names and exact npm versions are supported.', 'configuration')
  }
  const stdout = await runner(['view', spec, 'version', '--json'], workspace, env, undefined, signal)
  let version: unknown
  try {
    version = JSON.parse(stdout)
  } catch {
    version = stdout.trim().replace(/^"|"$/g, '')
  }
  if (Array.isArray(version)) version = version.at(-1)
  if (typeof version !== 'string' || !new RegExp(`^${EXACT_VERSION}$`).test(version)) {
    throw new DshcRuntimeError(`npm did not resolve an exact version for ${name}.`, 'runtime')
  }
  if (requestedVersion !== undefined && requestedVersion !== version) {
    throw new DshcRuntimeError(`Registry resolution changed: requested ${requestedVersion}, received ${version}.`, 'configuration')
  }
  return { name, version, exactSpec: `${name}@${version}` }
}

export interface PluginInstallTransactionOptions<T> {
  workspace: string
  patchPath: string
  exactSpec: string
  installAnchor: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  npmRunner?: NpmRunner
  healFallback?: (installAnchor: string, home: string) => void
  /** Trial the immutable candidate against its private patch, without reading the live workspace patch. */
  trial(moduleBasePath: string, candidatePatchPath: string, signal?: AbortSignal): Promise<T>
  /** Dispose a successful trial value if the later atomic publish cannot commit. */
  discardTrial(value: T): Promise<void>
  /** Test seam for the single authoritative publish operation. */
  publishPatch?: (path: string, content: string) => Promise<void>
}

export interface PluginInstallTransactionResult<T> extends ResolvedPluginSpec {
  patchPath: string
  profilePath: string
  value: T
}

/** Build and trial an immutable plugin generation, then atomically publish its patch. */
export async function installWorkspacePlugin<T>(
  options: PluginInstallTransactionOptions<T>,
): Promise<PluginInstallTransactionResult<T>> {
  const resolvedSpec = await resolveDeepseekPlugin(
    options.exactSpec,
    options.workspace,
    options.env,
    options.npmRunner,
    options.signal,
  )
  options.signal?.throwIfAborted()
  if (resolvedSpec.exactSpec !== options.exactSpec) {
    throw new DshcRuntimeError(
      `Confirmation must name the exact package and version: ${resolvedSpec.exactSpec}.`,
      'configuration',
    )
  }

  const home = join(resolve(options.workspace), '.dshc')
  const identity = pluginIdentity(resolvedSpec.name)
  // Keep the staging path short: scoped npm names plus nested node_modules can
  // otherwise exhaust the classic Windows path budget before npm unpacks them.
  const candidateName = `candidate-${identity.digest}-${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const profilePath = join(home, 'profiles', 'candidates', candidateName)
  const profilePackage = join(profilePath, 'package.json')
  const moduleAnchor = join(profilePath, 'runtime-anchor.mjs')
  const candidatePatchPath = join(profilePath, 'cordis.candidate.patch.yml')
  await mkdir(home, { recursive: true })
  try {
    await writeFile(join(home, '.gitignore'), 'profiles/\n', { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  // This shared fallback contains only installation-owned dependencies. Heal
  // it before creating the versioned candidate so a failed candidate can be
  // removed as one directory without touching any active plugin generation.
  (options.healFallback ?? healProfilesModuleFallback)(resolve(options.installAnchor), home)
  await mkdir(dirname(profilePath), { recursive: true })
  let stage: 'prepare' | 'trial' | 'commit' = 'prepare'
  let trialCompleted = false
  let trialValue!: T
  try {
    await mkdir(profilePath, { recursive: false })
    await writeFile(profilePackage, `${JSON.stringify({
      name: `dshc-workspace-plugin-${identity.digest}`,
      private: true,
    }, null, 2)}\n`, 'utf8')
    await writeFile(moduleAnchor, 'export {}\n', 'utf8')
    await (options.npmRunner ?? runNpm)(
      [
        'install',
        '--save-exact',
        '--ignore-scripts',
        '--legacy-peer-deps',
        '--no-audit',
        '--no-fund',
        resolvedSpec.exactSpec,
      ],
      profilePath,
      options.env ?? process.env,
      120_000,
      options.signal,
    )
    options.signal?.throwIfAborted()

    const entriesPath = join(profilePath, 'entries')
    const moduleShim = join(entriesPath, `${identity.id}.mjs`)
    await mkdir(entriesPath, { recursive: true })
    await writeFile(moduleShim, [
      `import * as plugin from ${JSON.stringify(resolvedSpec.name)}`,
      'export * from ' + JSON.stringify(resolvedSpec.name),
      'export default plugin.default ?? plugin',
      '',
    ].join('\n'), 'utf8')

    const releaseLock = await acquirePluginInstallLock(home, options.signal)
    try {
      const baselinePatch = await readPatchSnapshot(options.patchPath)
      const patches = loadOptionalPatches('dshc', options.patchPath) ?? []
      const nextPatches = upsertPluginPatch(patches, identity.id, moduleShim)
      const nextPatch = dump(nextPatches, {
        schema: entryListSchema,
        noRefs: true,
        lineWidth: 120,
      })
      await writeFile(candidatePatchPath, nextPatch, 'utf8')

      stage = 'trial'
      trialValue = await options.trial(moduleAnchor, candidatePatchPath, options.signal)
      trialCompleted = true
      options.signal?.throwIfAborted()
      stage = 'commit'
      const currentPatch = await readPatchSnapshot(options.patchPath)
      if (currentPatch !== baselinePatch) {
        throw new DshcRuntimeError(
          'The workspace plugin patch changed while the candidate was being tested; nothing was committed. Retry against the current patch.',
          'configuration',
        )
      }
      options.signal?.throwIfAborted()
      if (options.publishPatch === undefined) {
        await writeFileAtomic(options.patchPath, nextPatch, options.signal)
      } else {
        await options.publishPatch(options.patchPath, nextPatch)
      }
      return { ...resolvedSpec, patchPath: options.patchPath, profilePath, value: trialValue }
    } finally {
      await releaseLock()
    }
  } catch (error) {
    const cleanupFailures: unknown[] = []
    if (trialCompleted) {
      try {
        await options.discardTrial(trialValue)
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError)
      }
    }
    try {
      await rm(profilePath, { recursive: true, force: true })
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError)
    }

    const original = error instanceof Error ? error.message : String(error)
    const cleanup = cleanupFailures.length === 0
      ? ''
      : ` Cleanup also failed: ${cleanupFailures
          .map(failure => failure instanceof Error ? failure.message : String(failure))
          .join('; ')}`
    if (stage === 'prepare') {
      if (cleanupFailures.length === 0) throw error
      throw new DshcRuntimeError(`Plugin candidate preparation failed: ${original}.${cleanup}`, 'runtime', {
        cause: error instanceof Error ? error : undefined,
      })
    }
    throw new DshcRuntimeError(
      stage === 'trial'
        ? `Plugin trial boot failed; the immutable candidate was discarded and the active workspace composition was not changed: ${original}.${cleanup}`
        : `Plugin trial passed but its workspace patch could not be committed; the candidate was discarded and the active composition was not changed: ${original}.${cleanup}`,
      'runtime',
      { cause: error instanceof Error ? error : undefined },
    )
  }
}

function upsertPluginPatch(patches: PatchOptions[], id: string, moduleShim: string): PatchOptions[] {
  let replaced = false
  const next = patches.map((patch) => {
    if (patch.insert === undefined) return patch
    let changed = false
    const insert = patch.insert.map((entry) => {
      if (entry.id !== id) return entry
      replaced = true
      changed = true
      return { ...entry, name: moduleShim }
    })
    return changed ? { ...patch, insert } : patch
  })
  if (replaced) return next
  return [...next, {
    insert: [{ id, name: moduleShim }],
  }]
}

function pluginIdentity(packageName: string): { id: string; digest: string } {
  const suffix = packageName.slice(ALLOWED_SCOPE.length).replace(/[^a-z0-9_-]+/g, '-')
  const digest = createHash('sha256').update(packageName).digest('hex').slice(0, 8)
  return { id: `workspace-${suffix}-${digest}`, digest }
}

async function writeFileAtomic(path: string, content: string, signal?: AbortSignal): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID().replaceAll('-', '')}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    signal?.throwIfAborted()
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

const PLUGIN_LOCK_WAIT_MS = 50
const PLUGIN_LOCK_TIMEOUT_MS = 180_000
const INCOMPLETE_LOCK_STALE_MS = 5_000

interface PluginLockOwner {
  pid: number
  token: string
  createdAt: number
}

/** Serialize the read/trial/commit window across dshc processes in one workspace. */
async function acquirePluginInstallLock(
  home: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const path = join(home, 'plugin-install.lock')
  const owner: PluginLockOwner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() }
  const deadline = Date.now() + PLUGIN_LOCK_TIMEOUT_MS

  while (true) {
    signal?.throwIfAborted()
    let handle: FileHandle
    try {
      handle = await open(path, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await clearStalePluginLock(path)) continue
      if (Date.now() >= deadline) {
        throw new DshcRuntimeError(
          `Timed out waiting for another workspace plugin transaction to release ${path}.`,
          'configuration',
        )
      }
      await abortableDelay(PLUGIN_LOCK_WAIT_MS, signal)
      continue
    }

    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8')
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(path, { force: true }).catch(() => undefined)
      throw error
    }

    let released = false
    return async () => {
      if (released) return
      released = true
      await handle.close().catch(() => undefined)
      try {
        const current = JSON.parse(await readFile(path, 'utf8')) as Partial<PluginLockOwner>
        if (current.token === owner.token) await rm(path, { force: true })
      } catch {
        // A missing or externally replaced lock is not allowed to invalidate a
        // patch that has already committed successfully.
      }
    }
  }
}

async function clearStalePluginLock(path: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path, 'utf8')) as Partial<PluginLockOwner>
    if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      if (processIsAlive(owner.pid)) return false
      await rm(path, { force: true })
      return true
    }
  } catch {
    try {
      const facts = await stat(path)
      if (Date.now() - facts.mtimeMs < INCOMPLETE_LOCK_STALE_MS) return false
      await rm(path, { force: true })
      return true
    } catch {
      return true
    }
  }
  return false
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await new Promise(resolve => setTimeout(resolve, ms))
    return
  }
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function readPatchSnapshot(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function runNpm(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 30_000,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const command = process.platform === 'win32' ? process.execPath : 'npm'
    const commandArgs = process.platform === 'win32'
      ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args]
      : [...args]
    const result = await execFileAsync(command, commandArgs, {
      cwd,
      env,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      signal,
    })
    return result.stdout
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new DshcRuntimeError(`npm registry operation failed: ${message}`, 'runtime', {
      cause: error instanceof Error ? error : undefined,
    })
  }
}
