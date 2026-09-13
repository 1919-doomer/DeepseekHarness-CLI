import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { dshCommand, findDsh, inspectProfile, profilePath, type DshInstallation } from './dsh-profile.js'
import { resolveBundleSource, type BundleSource } from './bundle-source.js'

export type BundleAction = 'install' | 'upgrade' | 'disable' | 'uninstall' | 'rollback'
export interface ProfilePointer { current: string; history: string[]; source: string; revisions?: Record<string, string> }
export interface BundlePreview {
  action: BundleAction; sourceProfile: string; targetProfile: string; subject: string; fingerprint: string
  bundle?: BundleSource; targetFingerprint?: string; summary: string
}
export interface BundleInventoryItem {
  name: string; version?: string; installed: boolean; configured: boolean; startupVerified: boolean
  functionalVerified: false; browserReason?: string
}
interface Manifest { name: string; private: boolean; dependencies?: Record<string, string>; dsh: { profile: { bundles: string[]; patchReload?: string } } }

export class ProfileManager {
  constructor(readonly workspace: string, readonly env: NodeJS.ProcessEnv = process.env, private readonly installation?: DshInstallation) {}
  private get directory() { return join(this.workspace, '.dshc') }
  private get pointerPath() { return join(this.directory, 'profile.json') }
  async pointer(): Promise<ProfilePointer | undefined> {
    try {
      const result = JSON.parse(await readFile(this.pointerPath, 'utf8')) as ProfilePointer
      for (const name of [result.current, ...result.history]) if (!this.isManaged(name)) throw new Error('Invalid managed Profile pointer')
      return result
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async active(selected: string): Promise<string> { return selected === 'managed' ? (await this.pointer())?.current ?? (() => { throw new Error('No managed Profile exists yet') })() : selected }
  private prefix(): string { return `dshc-${createHash('sha256').update(this.workspace).digest('hex').slice(0, 12)}-` }
  private isManaged(name: string): boolean { return name.startsWith(this.prefix()) && /^[A-Za-z0-9_-]+$/.test(name) }
  private async fingerprint(profile: string, includePointer = true): Promise<string> {
    const hash = createHash('sha256')
    for (const path of [...(includePointer ? [this.pointerPath] : []), join(profilePath(profile, this.env), 'package.json'), join(profilePath(profile, this.env), 'cordis.patch.yml'), join(profilePath(profile, this.env), 'pnpm-lock.yaml'), join(profilePath(profile, this.env), '..', '..', 'cordis.patch.yml')]) {
      try { hash.update(path).update(await readFile(path)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; hash.update('absent') }
    }
    return hash.digest('hex')
  }
  async inventory(profile: string): Promise<BundleInventoryItem[]> {
    const selected = await this.active(profile)
    const directory = profilePath(selected, this.env)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Manifest
    const pointer = await this.pointer()
    const startupVerified = pointer?.revisions?.[selected] === await this.fingerprint(selected, false)
    const names = [...new Set([...manifest.dsh.profile.bundles, ...Object.keys(manifest.dependencies ?? {})])]
    return Promise.all(names.map(async name => {
      let installed = false; let version: string | undefined; let browserReason: string | undefined
      try {
        const value = JSON.parse(await readFile(join(directory, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as { version: string; dependencies?: Record<string, string> }
        version = value.version; installed = true
        if (Object.keys(value.dependencies ?? {}).some(name => /client-ui|frontend/.test(name))) browserReason = 'Browser Client dependencies require a Web UI; their terminal functionality is not verified'
      } catch { /* In-box Bundles resolve from the official installation instead. */ }
      if (!installed && name.startsWith('@deepseek-ai/dsh-')) {
        const dsh = this.installation ?? await findDsh(this.env)
        if (dsh.packagePath && ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'].includes(name)) { installed = true; version = dsh.version }
      }
      return { name, version, installed, configured: manifest.dsh.profile.bundles.includes(name), startupVerified, functionalVerified: false as const, browserReason }
    }))
  }
  async preview(selected: string, action: BundleAction, subject: string, signal?: AbortSignal): Promise<BundlePreview> {
    const dsh = this.installation ?? await findDsh(this.env)
    const sourceProfile = await this.active(selected)
    await inspectProfile(sourceProfile, this.workspace, this.env, dsh, signal)
    const bundle = action === 'install' || action === 'upgrade' ? await resolveBundleSource(subject, this.workspace, signal) : undefined
    const pointer = await this.pointer()
    const targetProfile = action === 'rollback' ? subject || pointer?.history.at(-1) || '' : `${this.prefix()}${randomUUID().slice(0, 8)}`
    if (action === 'rollback' && (!this.isManaged(targetProfile) || !pointer?.history.includes(targetProfile))) throw new Error('Rollback target must be a previously successful managed Profile')
    if (action === 'rollback' && pointer?.revisions?.[targetProfile] !== await this.fingerprint(targetProfile, false)) throw new Error('Rollback Profile was modified after its successful validation; it cannot be treated as the saved version')
    if (action === 'upgrade' && !(await this.inventory(sourceProfile)).some(item => item.name === bundle?.name)) throw new Error('Upgrade requires a Bundle already installed in this Profile')
    if (action === 'disable' || action === 'uninstall') {
      const items = await this.inventory(sourceProfile)
      if (!items.some(item => item.name === subject)) throw new Error('Bundle is not installed in this Profile')
      if (['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'].includes(subject)) throw new Error('Cannot remove the SDK baseline Bundles')
    }
    return { action, sourceProfile, targetProfile, subject, bundle, fingerprint: await this.fingerprint(sourceProfile),
      ...(action === 'rollback' ? { targetFingerprint: await this.fingerprint(targetProfile, false) } : {}),
      summary: [`Profile: ${sourceProfile} → ${targetProfile}`, `Operation: ${action}`, `Source: ${bundle?.requested ?? subject}`,
        ...(bundle ? [`Exact package: ${bundle.name}@${bundle.version}`, `SHA256: ${bundle.sha256}`, `Configuration: add/replace Bundle layer ${bundle.patch}`, bundle.patchText,
          `Dependencies: ${JSON.stringify(bundle.dependencies)}`, ...(bundle.clientDependencies.length ? [`Browser Client dependencies: ${bundle.clientDependencies.join(', ')}; terminal UI support is unavailable`] : [])] : [`Configuration: ${action} ${subject}`]),
        'A successful trial proves startup only. Individual tool paths remain unverified. The current session ends after activation.'].join('\n') }
  }
  async apply<T>(preview: BundlePreview, trial: (profile: string, signal?: AbortSignal) => Promise<T>,
    discard: (value: T) => Promise<void>, signal?: AbortSignal): Promise<{ value: T; profile: string }> {
    await mkdir(this.directory, { recursive: true })
    const lockPath = join(this.directory, 'profile.lock')
    const lock = await open(lockPath, 'wx').catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; throw new Error('Another Profile operation owns .dshc/profile.lock; wait for it to finish') })
    let value: T | undefined; let committed = false
    try {
      const dsh = this.installation ?? await findDsh(this.env)
      signal?.throwIfAborted()
      if (await this.fingerprint(preview.sourceProfile) !== preview.fingerprint) throw new Error('Profile changed after preview; inspect and confirm again')
      if (preview.action === 'rollback' && preview.targetFingerprint !== await this.fingerprint(preview.targetProfile, false)) throw new Error('Rollback Profile changed after preview')
      const destination = profilePath(preview.targetProfile, this.env)
      if (!this.isManaged(preview.targetProfile)) throw new Error('Refusing to mutate an unmanaged Profile')
      if (preview.action !== 'rollback') {
        await mkdir(destination) // exclusive claim, never overwrite another candidate
        await cp(profilePath(preview.sourceProfile, this.env), destination, { recursive: true, dereference: true,
          filter: path => !['node_modules', '.git'].includes(basename(path)), force: false, errorOnExist: true })
        const manifestPath = join(destination, 'package.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
        manifest.name = `dsh-profile-${preview.targetProfile}`
        manifest.private = true
        manifest.dsh.profile.patchReload = 'startup'
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
        const args = ['plugin', '--profile', preview.targetProfile]
        const env = { ...this.env, npm_config_ignore_scripts: 'true', npm_config_strict_peer_dependencies: 'true' }
        if (preview.bundle) {
          const hash = createHash('sha256').update(await readFile(preview.bundle.archive)).digest('hex')
          if (hash !== preview.bundle.sha256) throw new Error('Bundle archive changed after preview')
          await dshCommand(dsh, [...args, 'add', '--ignore-scripts', '--save-exact', preview.bundle.archive], this.workspace, env, signal, 120_000)
          const installed = JSON.parse(await readFile(join(destination, 'node_modules', ...preview.bundle.name.split('/'), 'package.json'), 'utf8')) as { name: string; version: string }
          if (installed.name !== preview.bundle.name || installed.version !== preview.bundle.version) throw new Error('Installed Bundle identity does not match the preview')
        } else if (preview.action === 'uninstall') {
          await dshCommand(dsh, [...args, 'remove', preview.subject], this.workspace, env, signal, 120_000)
        } else {
          await dshCommand(dsh, [...args, 'install', '--ignore-scripts'], this.workspace, env, signal, 120_000)
        }
        if (preview.action === 'disable') {
          const next = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
          next.dsh.profile.bundles = next.dsh.profile.bundles.filter(name => name !== preview.subject)
          await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
        }
        // Official reconciliation can reactivate previously disabled dependencies.
        // Preserve that user choice while allowing the explicitly requested bundle.
        const reconciled = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
        const disabled = Object.keys(manifest.dependencies ?? {}).filter(name => !manifest.dsh.profile.bundles.includes(name) && name !== preview.bundle?.name)
        reconciled.dsh.profile.bundles = reconciled.dsh.profile.bundles.filter(name => !disabled.includes(name))
        await writeFile(manifestPath, `${JSON.stringify(reconciled, null, 2)}\n`)
      }
      await inspectProfile(preview.targetProfile, this.workspace, this.env, dsh, signal)
      const testedFingerprint = await this.fingerprint(preview.targetProfile, false)
      value = await trial(preview.targetProfile, signal)
      signal?.throwIfAborted()
      if (await this.fingerprint(preview.sourceProfile) !== preview.fingerprint) throw new Error('Profile changed during installation; candidate was not activated')
      if (await this.fingerprint(preview.targetProfile, false) !== testedFingerprint) throw new Error('Candidate Profile changed during startup; candidate was not activated')
      const previous = await this.pointer()
      const history = [...new Set([...(previous?.history ?? []), ...(previous ? [previous.current] : [])])].filter(name => name !== preview.targetProfile)
      const pointer: ProfilePointer = { current: preview.targetProfile, history, source: previous?.source ?? preview.sourceProfile,
        revisions: { ...previous?.revisions, [preview.targetProfile]: await this.fingerprint(preview.targetProfile, false) } }
      const temporary = `${this.pointerPath}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(pointer, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, this.pointerPath)
      committed = true
      return { value, profile: preview.targetProfile }
    } finally {
      try { if (!committed && value !== undefined) await discard(value) }
      finally { await lock.close(); await rm(lockPath, { force: true }) }
      // Failed candidates remain inert for inspection; no shared Profile is deleted.
    }
  }
}
