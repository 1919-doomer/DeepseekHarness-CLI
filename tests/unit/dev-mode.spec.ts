import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCliArgs } from '../../src/cli/args.js'
import { validateModeOptions } from '../../src/cli/main.js'
import { resolveComposition, workspaceCompositionPath } from '../../src/upstream/composition.js'
import { defaultRuntimeConfigPath, defaultRuntimeDevPatchPath } from '../../src/upstream/runtime-launcher.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('M6 developer mode boundary', () => {
  it('parses --dev for interactive and doctor entrypoints', () => {
    expect(parseCliArgs(['--dev'])).toMatchObject({ command: 'auto', dev: true })
    expect(parseCliArgs(['doctor', '--dev', '--json'])).toMatchObject({ command: 'doctor', dev: true, json: true })
  })

  it('accepts interactive TTY and doctor diagnostics, but rejects one-shot, pipe and explicit config combinations', () => {
    expect(() => validateModeOptions(parseCliArgs(['--dev']), { stdin: true, stdout: true })).not.toThrow()
    expect(() => validateModeOptions(parseCliArgs(['doctor', '--dev']), { stdin: false, stdout: false })).not.toThrow()
    expect(() => validateModeOptions(parseCliArgs(['--dev', 'prompt']), { stdin: true, stdout: true })).toThrow('interactive TTY product')
    expect(() => validateModeOptions(parseCliArgs(['run', '--dev', 'prompt']), { stdin: true, stdout: true })).toThrow('interactive TTY product')
    expect(() => validateModeOptions(parseCliArgs(['--dev']), { stdin: false, stdout: true })).toThrow('requires interactive TTY')
    expect(() => validateModeOptions(parseCliArgs(['--dev', '--runtime-config', 'custom.yml']), { stdin: true, stdout: true })).toThrow('cannot be combined')
    expect(() => validateModeOptions(parseCliArgs(['doctor', '--dev', '--runtime-config', 'custom.yml']), { stdin: false, stdout: false })).toThrow('cannot be combined')
  })

  it('orders shipped base -> built-in dev patch -> workspace patch and isolates ordinary mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-dev-order-'))
    roots.push(root)
    const workspacePatch = workspaceCompositionPath(root)
    await mkdir(join(root, '.dshc'))
    await writeFile(workspacePatch, '[]\n', 'utf8')
    const devPatch = defaultRuntimeDevPatchPath()
    await expect(access(devPatch)).resolves.toBeUndefined()

    const developer = await resolveComposition(root, undefined, defaultRuntimeConfigPath(), {
      devMode: true,
      devPatchPath: devPatch,
    })
    expect(developer.patchPaths).toEqual([devPatch, workspacePatch])
    expect(developer.devPatchPath).toBe(devPatch)
    expect(developer.patchPath).toBe(workspacePatch)

    const ordinary = await resolveComposition(root, undefined, defaultRuntimeConfigPath())
    expect(ordinary.patchPaths).toEqual([workspacePatch])
    expect(ordinary.devPatchPath).toBeUndefined()
  })
})
