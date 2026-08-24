import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { effectiveRuntimeEnvironment, resolveRuntimeLaunch } from '../../src/upstream/runtime-launcher.js'

const originals = new Map<string, string | undefined>()

function setEnv(name: string, value: string): void {
  if (!originals.has(name)) originals.set(name, process.env[name])
  process.env[name] = value
}

afterEach(() => {
  for (const [name, value] of originals) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  originals.clear()
})

describe('effectiveRuntimeEnvironment', () => {
  it('treats HarnessRuntimeOptions.env as a patch over the parent environment', () => {
    setEnv('DSHC_PARENT_ONLY_TEST', 'parent-value')
    const env = effectiveRuntimeEnvironment({
      workspace: '/workspace',
      env: {
        DSHC_PATCH_ONLY_TEST: 'patch-value',
        DSH_CWD: 'caller-must-not-win',
      },
    })

    expect(env.DSHC_PARENT_ONLY_TEST).toBe('parent-value')
    expect(env.DSHC_PATCH_ONLY_TEST).toBe('patch-value')
    expect(env.DSH_CWD).toBe('/workspace')
  })

  it('serializes patch layers and a file URL module anchor for the runtime wrapper', () => {
    const env = effectiveRuntimeEnvironment({
      workspace: process.cwd(),
      patchPaths: ['one.patch.yml', 'two.patch.yml'],
      moduleBasePath: new URL('../../package.json', import.meta.url).pathname,
    })
    expect(JSON.parse(env.DSHC_CORDIS_PATCHES ?? 'null')).toEqual(['one.patch.yml', 'two.patch.yml'])
    expect(env.DSHC_MODULE_BASE_URL).toMatch(/^file:/)
  })

  it('treats launchOverride.env as the authoritative child environment', () => {
    setEnv('DSHC_PARENT_ONLY_TEST', 'parent-value')
    const overrideEnv = { DSHC_OVERRIDE_ONLY_TEST: 'override-value' }
    const env = effectiveRuntimeEnvironment({
      workspace: '/workspace',
      env: { DSHC_PATCH_ONLY_TEST: 'patch-value' },
      override: {
        command: process.execPath,
        env: overrideEnv,
      },
    })

    expect(env).toBe(overrideEnv)
    expect(env.DSHC_OVERRIDE_ONLY_TEST).toBe('override-value')
    expect(env.DSHC_PARENT_ONLY_TEST).toBeUndefined()
    expect(env.DSHC_PATCH_ONLY_TEST).toBeUndefined()
  })

  it('matches Node inheritance when launchOverride omits env', () => {
    setEnv('DSHC_PARENT_ONLY_TEST', 'parent-value')
    const env = effectiveRuntimeEnvironment({
      workspace: '/workspace',
      override: { command: process.execPath },
    })

    expect(env).toBe(process.env)
    expect(env.DSHC_PARENT_ONLY_TEST).toBe('parent-value')
  })

  it('fails closed instead of silently dropping a selected patch layer', async () => {
    const missing = join(process.cwd(), '.dshc', 'missing-dev.patch.yml')
    await expect(resolveRuntimeLaunch({
      workspace: process.cwd(),
      patchPaths: [missing],
    })).rejects.toMatchObject({ code: 'configuration' })
    await expect(resolveRuntimeLaunch({
      workspace: process.cwd(),
      patchPaths: [missing],
    })).rejects.toThrow(`Harness runtime patch does not exist: ${missing}`)
  })
})
