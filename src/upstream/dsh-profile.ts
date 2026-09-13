import { access, readFile, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import type { HarnessClientOptions } from '@deepseek-ai/dsh-sdk-client'
import { captureProcess } from './process.js'
import { DshcRuntimeError } from './errors.js'
import type { Preferences } from '../preferences.js'

export const TESTED_PROFILE_VERSION = '0.1.5-rc.2'
export interface DshInstallation { command: string; args: string[]; version: string; packagePath?: string }
export interface ProfileFacts {
  backend: 'dsh-profile'; name: string; path: string; home: string; cliVersion: string
  sdkServerVersion?: string; bundles: string[]; configurationSources: string[]
  verifiedPackageVersions?: Record<string, string>
}
const inertSchema = DEFAULT_SCHEMA.extend([new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => ({ expression: value }) })])

export function dshHome(env: NodeJS.ProcessEnv = process.env): string { return resolve(env.DSH_HOME ?? join(homedir(), '.dsh')) }
export function profilePath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name)) throw new Error('Invalid DSH Profile name')
  return join(dshHome(env), 'profiles', name)
}

/** Resolve a Node CLI or packaged executable; never execute an arbitrary .cmd through a shell. */
export async function findDsh(env: NodeJS.ProcessEnv = process.env): Promise<DshInstallation> {
  const candidates = env.DSHC_DSH_EXECUTABLE ? [env.DSHC_DSH_EXECUTABLE] : (env.PATH ?? env.Path ?? '').split(delimiter)
    .flatMap(dir => process.platform === 'win32'
      ? [join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), join(dir, 'dsh.exe')]
      : [join(dir, 'dsh')])
  for (const candidate of candidates) {
    try { await access(candidate) } catch { continue }
    const path = await realpath(candidate)
    if (/\.(?:cmd|bat|ps1)$/i.test(path)) throw new Error('Set DSHC_DSH_EXECUTABLE to the official lib/bin.js or native executable, not a shell shim')
    const node = ['.js', '.mjs'].includes(extname(path))
    const command = node ? process.execPath : path
    const args = node ? [path] : []
    const version = (await captureProcess(command, [...args, '--version'], { cwd: process.cwd(), env })).trim().replace(/^dsh\s+v?|^v/, '')
    if (version !== TESTED_PROFILE_VERSION) throw new DshcRuntimeError(`DSH ${version} is not a verified Profile backend; expected ${TESTED_PROFILE_VERSION}. dshc does not upgrade your installation.`, 'compatibility')
    const packagePath = node ? resolve(dirname(path), '..', 'package.json') : undefined
    if (packagePath) {
      const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as { name?: string; version?: string }
      if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== version) throw new Error('DSH executable and package identity disagree')
    }
    return { command, args, version, ...(packagePath ? { packagePath } : {}) }
  }
  throw new DshcRuntimeError('Official dsh is not installed on PATH. Install the verified version yourself or set DSHC_DSH_EXECUTABLE to its lib/bin.js. The bundled backend remains available.', 'configuration')
}

export async function dshCommand(installation: DshInstallation, args: readonly string[], workspace: string,
  env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs = 30_000): Promise<string> {
  return captureProcess(installation.command, [...installation.args, ...args], { cwd: workspace, env, signal, timeoutMs, maxBytes: 2_097_152 })
}

export async function inspectProfile(name: string, workspace: string, env: NodeJS.ProcessEnv = process.env,
  installation?: DshInstallation, signal?: AbortSignal): Promise<ProfileFacts> {
  const dsh = installation ?? await findDsh(env)
  const path = profilePath(name, env)
  // The official SDK profile may initialize from its shipped template. Other
  // profiles must already exist, avoiding accidental creation of base-only trees.
  if (name !== 'sdk') await stat(join(path, 'package.json'))
  const dump = await dshCommand(dsh, ['--profile', name, '--dump-config'], workspace, env, signal)
  const tree = load(dump, { schema: inertSchema })
  if (!hasActivePlugin(tree, '@deepseek-ai/dsh-sdk-jsonrpc-server')) throw new Error(`Profile ${name} does not contain an active SDK JSON-RPC server`)
  if (hasActivePlugin(tree, '@deepseek-ai/dsh-host-webserver')) throw new Error(`Profile ${name} includes a browser server; select an SDK Profile`)
  const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.some(name => typeof name !== 'string')) throw new Error('Invalid dsh.profile.bundles manifest')
  if (bundles.includes('@deepseek-ai/dsh-sdk-minimal')) throw new Error('sdk-minimal lacks the coding and policy baseline required by dshc')
  let sdkServerVersion: string | undefined
  const verifiedPackageVersions: Record<string, string> = {}
  if (dsh.packagePath) {
    const require = createRequire(dsh.packagePath)
    const server = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-server/package.json'), 'utf8')) as { version: string }
    sdkServerVersion = server.version
    if (sdkServerVersion !== TESTED_PROFILE_VERSION) throw new Error(`Unverified SDK server dependency ${sdkServerVersion}`)
    // Profiles can shadow the CLI's packages. Verify policy/adapter identities
    // from each configured Bundle's resolution context as well as the CLI.
    const anchors = [dsh.packagePath, join(path, 'package.json')]
    for (const bundle of bundles) {
      try { anchors.push(createRequire(join(path, 'package.json')).resolve(`${bundle}/package.json`)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error }
    }
    for (const anchor of anchors) for (const name of ['dsh-sdk-jsonrpc-server', 'dsh-agent', 'dsh-tools', 'dsh-system-prompt', 'dsh-llm-deepseek']) {
      const id = `@deepseek-ai/${name}`
      let packageFile: string
      try { packageFile = createRequire(anchor).resolve(`${id}/package.json`) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') continue; throw error }
      // A Profile inside a repository can resolve its parent's node_modules.
      // Those packages are not Profile overrides: official in-box bundles use
      // the CLI's resolver, already checked above. Only inspect local shadows.
      const localPath = relative(join(path, 'node_modules'), packageFile)
      if (anchor !== dsh.packagePath && (isAbsolute(localPath) || localPath === '..' || localPath.startsWith(`..${sep}`))) continue
      const installed = JSON.parse(await readFile(packageFile, 'utf8')) as { version: string }
      if (installed.version !== TESTED_PROFILE_VERSION) throw new Error(`Profile resolves unverified ${id}@${installed.version} from ${anchor}`)
      verifiedPackageVersions[id] = installed.version
    }
  }
  return { backend: 'dsh-profile', name, path, home: dshHome(env), cliVersion: dsh.version, sdkServerVersion,
    bundles, verifiedPackageVersions, configurationSources: [...bundles.map(name => `bundle:${name}`), join(path, 'cordis.patch.yml'), join(dshHome(env), 'cordis.patch.yml')] }
}

function hasActivePlugin(value: unknown, name: string): boolean {
  if (Array.isArray(value)) return value.some(item => hasActivePlugin(item, name))
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (row['disabled'] === true) return false
  return row['name'] === name || (Array.isArray(row['config']) && hasActivePlugin(row['config'], name))
}

export function profileLaunch(dsh: DshInstallation, facts: ProfileFacts, workspace: string,
  env: NodeJS.ProcessEnv, preferences: Partial<Preferences>): HarnessClientOptions {
  const overlay = fileURLToPath(new URL('../../runtime/profile-policy.patch.yml', import.meta.url))
  return { command: dsh.command, args: [...dsh.args, '--profile', facts.name, '--patch', overlay], cwd: workspace,
    env: { ...env, DSH_CWD: workspace, DSHC_WORK_MODE: preferences.mode ?? 'code',
      DSHC_REPLY_LANGUAGE: preferences.replyLanguage ?? 'auto', DSHC_OUTPUT_STYLE: preferences.style ?? 'default' },
    requestTimeoutMs: 30_000, shutdownTimeoutMs: 1_000, disposeEofGraceMs: 6_000, disposeGraceMs: 3_000 }
}
