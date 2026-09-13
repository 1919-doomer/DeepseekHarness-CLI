import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProfileManager } from '../../src/upstream/profile-manager.js'
import { findDsh, inspectProfile, profilePath } from '../../src/upstream/dsh-profile.js'
import { HarnessRuntime } from '../../src/upstream/runtime.js'
import { bundleArchive, testBundle } from '../fixtures/bundle.js'

const executable = process.env.DSHC_TEST_DSH ?? resolve('node_modules/.dshc-profile-validation/node_modules/@deepseek-ai/dsh/lib/bin.js')
describe.skipIf(!existsSync(executable))('official CLI Bundle candidate transactions', () => {
  it('installs, disables, rolls back, rejects bad startup and detects concurrent configuration changes', async () => {
    const root = await mkdtemp(resolve('node_modules/dshc-profile-bundles-'))
    const env = { ...process.env, DSH_HOME: join(root, 'home'), DSHC_DSH_EXECUTABLE: executable }
    const runtimeFor = (name: string) => new HarnessRuntime({ workspace: root, env, preferences: { runtime: 'dsh-profile', dshProfile: name } })
    const trial = async (name: string) => {
      const runtime = runtimeFor(name)
      try { await runtime.start(); return runtime } catch (error) { await runtime.close(); throw error }
    }
    const discard = async (runtime: HarnessRuntime) => runtime.close()
    try {
      const dsh = await findDsh(env)
      await inspectProfile('sdk', root, env, dsh)
      const sharedManifest = await readFile(join(profilePath('sdk', env), 'package.json'), 'utf8')
      const archive = join(root, 'bundle.tgz')
      await writeFile(archive, testBundle())
      const manager = new ProfileManager(root, env)
      const install = await manager.preview('sdk', 'install', archive)
      const first = await manager.apply(install, trial, discard)
      await first.value.close()
      expect(await manager.pointer()).toMatchObject({ current: first.profile, source: 'sdk' })
      expect(await readFile(join(profilePath('sdk', env), 'package.json'), 'utf8')).toBe(sharedManifest)
      expect(await manager.inventory('managed')).toContainEqual(expect.objectContaining({ name: 'dshc-test-bundle', installed: true, configured: true, functionalVerified: false }))
      const disabled = await manager.apply(await manager.preview('managed', 'disable', 'dshc-test-bundle'), trial, discard)
      await disabled.value.close()
      expect(await manager.inventory('managed')).toContainEqual(expect.objectContaining({ name: 'dshc-test-bundle', installed: true, configured: false }))
      const rollback = await manager.apply(await manager.preview('managed', 'rollback', first.profile), trial, discard)
      await rollback.value.close()
      expect((await manager.pointer())?.current).toBe(first.profile)
      const rollbackPreview = await manager.preview('managed', 'rollback', disabled.profile)
      const rollbackPatch = join(profilePath(disabled.profile, env), 'cordis.patch.yml')
      await writeFile(rollbackPatch, '# modified saved version\n[]\n')
      await expect(manager.apply(rollbackPreview, trial, discard)).rejects.toThrow('Rollback Profile changed')
      expect((await manager.pointer())?.current).toBe(first.profile)
      await writeFile(archive, testBundle('2.0.0', '- insert:\n    - id: broken\n      name: ./index.mjs\n', 'export function apply() { throw new Error("fixture startup failure") }'))
      const failed = await manager.preview('managed', 'upgrade', archive)
      await expect(manager.apply(failed, trial, discard)).rejects.toThrow()
      expect((await manager.pointer())?.current).toBe(first.profile)
      await writeFile(archive, testBundle('3.0.0', '- insert:\n    - id: noisy\n      name: ./index.mjs\n', 'export function apply() { process.stdout.write("invalid-json-fixture\\n") }'))
      // The public SDK discards non-JSON log lines. They must not escape as
      // terminal/JSON output or prevent its actual initialize handshake.
      const noisy = await manager.apply(await manager.preview('managed', 'upgrade', archive), trial, discard)
      await noisy.value.close()
      const restored = await manager.apply(await manager.preview('managed', 'rollback', first.profile), trial, discard)
      await restored.value.close()
      expect((await manager.pointer())?.current).toBe(first.profile)
      await writeFile(archive, bundleArchive({
        'package.json': JSON.stringify({ name: 'dshc-test-bundle', version: '4.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: { 'fixture-missing': 'file:./missing.tgz' } }),
        'cordis.patch.yml': '[]\n',
      }))
      await expect(manager.apply(await manager.preview('managed', 'upgrade', archive), trial, discard)).rejects.toThrow()
      expect((await manager.pointer())?.current).toBe(first.profile)
      const conflict = await manager.preview('managed', 'uninstall', 'dshc-test-bundle')
      const patch = join(profilePath(first.profile, env), 'cordis.patch.yml')
      await writeFile(patch, '# external edit\n[]\n')
      await expect(manager.apply(conflict, trial, discard)).rejects.toThrow('changed after preview')
      expect(await manager.inventory('managed')).toContainEqual(expect.objectContaining({ name: 'dshc-test-bundle', startupVerified: false }))
      const concurrent = await manager.preview('managed', 'uninstall', 'dshc-test-bundle')
      await writeFile(join(root, '.dshc', 'profile.lock'), '')
      await expect(manager.apply(concurrent, trial, discard)).rejects.toThrow('Another Profile operation')
      await rm(join(root, '.dshc', 'profile.lock'))
      const removed = await manager.apply(await manager.preview('managed', 'uninstall', 'dshc-test-bundle'), trial, discard)
      await removed.value.close()
      expect((await manager.inventory('managed')).some(item => item.name === 'dshc-test-bundle')).toBe(false)
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
  }, 180_000)
})
