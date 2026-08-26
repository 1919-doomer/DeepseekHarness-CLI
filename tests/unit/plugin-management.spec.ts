import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
import {
  installWorkspacePlugin,
  resolveDeepseekPlugin,
  searchDeepseekPlugins,
  type NpmRunner,
} from '../../src/upstream/plugin-management.js'

const context = {
  runtime: {
    workspace: '/workspace',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    serverName: 'deepseek-harness-sdk-runtime',
    protocolVersion: '0.0.1',
  },
  session: { sessionId: 'root', turnCount: 0, generation: 1 },
  phase: 'idle' as const,
  totalTurns: 0,
}

describe('plugin management command', () => {
  it('requires an explicit named confirmation for installs', () => {
    const command = createDefaultTerminalHost().resolveCommand('plugin')
    if (command === undefined) throw new Error('plugin command missing')
    expect(command.execute(context, ['install', '@deepseek-ai/example'])).toEqual({
      kind: 'plugin-install',
      spec: '@deepseek-ai/example',
      confirmed: false,
    })
    expect(command.execute(context, ['install', '@deepseek-ai/example@1.2.3', '--yes'])).toEqual({
      kind: 'plugin-install',
      spec: '@deepseek-ai/example@1.2.3',
      confirmed: true,
    })
  })
})

describe('plugin registry restrictions', () => {
  it('filters search results to the @deepseek-ai scope', async () => {
    const runner: NpmRunner = async () => JSON.stringify([
      { name: '@deepseek-ai/allowed', version: '1.2.3', description: 'ok' },
      { name: '@other/rejected', version: '9.9.9', description: 'no' },
    ])
    await expect(searchDeepseekPlugins('allowed', process.cwd(), {}, runner)).resolves.toEqual([
      { name: '@deepseek-ai/allowed', version: '1.2.3', description: 'ok' },
    ])
  })

  it('rejects packages outside the allowlisted scope before querying npm', async () => {
    const runner = vi.fn<NpmRunner>()
    await expect(resolveDeepseekPlugin('@other/nope@1.2.3', process.cwd(), {}, runner))
      .rejects.toThrow('Only @deepseek-ai/package names')
    expect(runner).not.toHaveBeenCalled()
  })
})

describe('plugin install transaction', () => {
  const runner: NpmRunner = async (args) => args[0] === 'view' ? '"1.2.3"' : ''

  it('appends one patch entry only after an exact version is confirmed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dshc-plugin-'))
    const patchPath = join(workspace, '.dshc', 'cordis.patch.yml')
    const result = await installWorkspacePlugin({
      workspace,
      patchPath,
      exactSpec: '@deepseek-ai/example@1.2.3',
      installAnchor: join(workspace, 'host-package.json'),
      npmRunner: runner,
      healFallback: () => undefined,
      trial: async profile => profile,
      discardTrial: async () => undefined,
    })
    expect(result.value).toBe(join(result.profilePath, 'runtime-anchor.mjs'))
    expect(result.profilePath).toContain(join('.dshc', 'profiles', 'candidates', 'candidate-'))
    const patch = await readFile(patchPath, 'utf8')
    expect(patch).toContain('workspace-example-')
    expect(patch).toContain('entries')
  })

  it('restores the exact previous patch when trial initialization fails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dshc-plugin-'))
    const patchPath = join(workspace, '.dshc', 'cordis.patch.yml')
    await mkdir(join(workspace, '.dshc'), { recursive: true })
    await writeFile(patchPath, '[]\n', { encoding: 'utf8', flag: 'wx' })
    await expect(installWorkspacePlugin({
      workspace,
      patchPath,
      exactSpec: '@deepseek-ai/example@1.2.3',
      installAnchor: join(workspace, 'host-package.json'),
      npmRunner: runner,
      healFallback: () => undefined,
      trial: async () => { throw new Error('plugin init exploded') },
      discardTrial: async () => undefined,
    })).rejects.toThrow('active workspace composition was not changed')
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
  })

  it('keeps the last good immutable generation active after a failed upgrade and cold resolution', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dshc-plugin-upgrade-'))
    const patchPath = join(workspace, '.dshc', 'cordis.patch.yml')
    const npmRunner = fakeInstallingRunner()

    const first = await installWorkspacePlugin({
      workspace,
      patchPath,
      exactSpec: '@deepseek-ai/example@1.0.0',
      installAnchor: join(workspace, 'host-package.json'),
      npmRunner,
      healFallback: () => undefined,
      trial: async (_moduleBasePath, candidatePatchPath) => {
        expect(await coldResolvedVersion(candidatePatchPath)).toBe('1.0.0')
        return 'first-runtime'
      },
      discardTrial: async () => undefined,
    })
    const committedPatch = await readFile(patchPath, 'utf8')
    expect(await coldResolvedVersion(patchPath)).toBe('1.0.0')

    await expect(installWorkspacePlugin({
      workspace,
      patchPath,
      exactSpec: '@deepseek-ai/example@2.0.0',
      installAnchor: join(workspace, 'host-package.json'),
      npmRunner,
      healFallback: () => undefined,
      trial: async (_moduleBasePath, candidatePatchPath) => {
        expect(await coldResolvedVersion(candidatePatchPath)).toBe('2.0.0')
        throw new Error('version 2 cannot initialize')
      },
      discardTrial: async () => undefined,
    })).rejects.toThrow('immutable candidate was discarded')

    expect(await readFile(patchPath, 'utf8')).toBe(committedPatch)
    expect(await coldResolvedVersion(patchPath)).toBe('1.0.0')
    expect(await readFile(join(first.profilePath, 'node_modules', '@deepseek-ai', 'example', 'package.json'), 'utf8'))
      .toContain('"version": "1.0.0"')
    await expect(readdir(join(workspace, '.dshc', 'profiles', 'candidates'))).resolves.toEqual([
      first.profilePath.split(/[\\/]/).at(-1),
    ])
  })

  it('atomically replaces an existing patch after a successful upgrade without mutating the old generation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dshc-plugin-promote-'))
    const patchPath = join(workspace, '.dshc', 'cordis.patch.yml')
    const npmRunner = fakeInstallingRunner()
    const install = (version: string) => installWorkspacePlugin({
      workspace,
      patchPath,
      exactSpec: `@deepseek-ai/example@${version}`,
      installAnchor: join(workspace, 'host-package.json'),
      npmRunner,
      healFallback: () => undefined,
      trial: async (_moduleBasePath: string, candidatePatchPath: string) => coldResolvedVersion(candidatePatchPath),
      discardTrial: async () => undefined,
    })

    const first = await install('1.0.0')
    const second = await install('2.0.0')
    expect(second.value).toBe('2.0.0')
    expect(await coldResolvedVersion(patchPath)).toBe('2.0.0')
    expect(await readFile(join(first.profilePath, 'node_modules', '@deepseek-ai', 'example', 'package.json'), 'utf8'))
      .toContain('"version": "1.0.0"')
    expect(second.profilePath).not.toBe(first.profilePath)
  })

  it('serializes concurrent workspace installs so both committed entries survive', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dshc-plugin-concurrent-'))
    const patchPath = join(workspace, '.dshc', 'cordis.patch.yml')
    let activeTrials = 0
    let maxActiveTrials = 0
    const install = (name: string) => installWorkspacePlugin({
      workspace,
      patchPath,
      exactSpec: `@deepseek-ai/${name}@1.2.3`,
      installAnchor: join(workspace, 'host-package.json'),
      npmRunner: runner,
      healFallback: () => undefined,
      trial: async () => {
        activeTrials += 1
        maxActiveTrials = Math.max(maxActiveTrials, activeTrials)
        await new Promise(resolve => setTimeout(resolve, 40))
        activeTrials -= 1
        return name
      },
      discardTrial: async () => undefined,
    })

    const results = await Promise.all([install('one'), install('two')])
    const patch = await readFile(patchPath, 'utf8')
    expect(results).toHaveLength(2)
    expect(maxActiveTrials).toBe(1)
    expect(patch).toContain('workspace-one-')
    expect(patch).toContain('workspace-two-')
  })

  it('discards an initialized candidate when shutdown aborts before commit', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dshc-plugin-abort-'))
    const patchPath = join(workspace, '.dshc', 'cordis.patch.yml')
    const controller = new AbortController()
    const discardTrial = vi.fn(async () => undefined)

    await expect(installWorkspacePlugin({
      workspace,
      patchPath,
      exactSpec: '@deepseek-ai/example@1.2.3',
      installAnchor: join(workspace, 'host-package.json'),
      signal: controller.signal,
      npmRunner: runner,
      healFallback: () => undefined,
      trial: async () => {
        controller.abort(new Error('terminal shutdown'))
        return 'candidate-runtime'
      },
      discardTrial,
    })).rejects.toThrow('immutable candidate was discarded')

    expect(discardTrial).toHaveBeenCalledWith('candidate-runtime')
    await expect(readFile(patchPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deletes a candidate when package preparation fails before trial', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dshc-plugin-prepare-'))
    const patchPath = join(workspace, '.dshc', 'cordis.patch.yml')
    const failingRunner: NpmRunner = async (args) => {
      if (args[0] === 'view') return '"1.2.3"'
      throw new Error('npm install failed')
    }
    await expect(installWorkspacePlugin({
      workspace,
      patchPath,
      exactSpec: '@deepseek-ai/example@1.2.3',
      installAnchor: join(workspace, 'host-package.json'),
      npmRunner: failingRunner,
      healFallback: () => undefined,
      trial: async () => { throw new Error('trial must not run') },
      discardTrial: async () => undefined,
    })).rejects.toThrow('npm install failed')
    await expect(readdir(join(workspace, '.dshc', 'profiles', 'candidates'))).resolves.toEqual([])
    await expect(readFile(patchPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('disposes a successful trial and removes its candidate when atomic publish fails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dshc-plugin-commit-'))
    const patchPath = join(workspace, '.dshc', 'cordis.patch.yml')
    await mkdir(dirname(patchPath), { recursive: true })
    await writeFile(patchPath, '[]\n', 'utf8')
    const trialValue = { runtime: 'candidate' }
    const discardTrial = vi.fn(async () => undefined)

    await expect(installWorkspacePlugin({
      workspace,
      patchPath,
      exactSpec: '@deepseek-ai/example@1.2.3',
      installAnchor: join(workspace, 'host-package.json'),
      npmRunner: runner,
      healFallback: () => undefined,
      trial: async () => trialValue,
      discardTrial,
      publishPatch: async () => { throw new Error('atomic rename denied') },
    })).rejects.toThrow('could not be committed')

    expect(discardTrial).toHaveBeenCalledWith(trialValue)
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
    await expect(readdir(join(workspace, '.dshc', 'profiles', 'candidates'))).resolves.toEqual([])
  })
})

function fakeInstallingRunner(): NpmRunner {
  return async (args, cwd) => {
    const exactSpec = args.find(argument => argument.startsWith('@deepseek-ai/example@'))
    if (args[0] === 'view') {
      if (exactSpec === undefined) throw new Error('missing exact view spec')
      return JSON.stringify(exactSpec.slice(exactSpec.lastIndexOf('@') + 1))
    }
    if (args[0] !== 'install' || exactSpec === undefined) throw new Error(`unexpected npm operation: ${args.join(' ')}`)
    const version = exactSpec.slice(exactSpec.lastIndexOf('@') + 1)
    const packagePath = join(cwd, 'node_modules', '@deepseek-ai', 'example')
    await mkdir(packagePath, { recursive: true })
    await writeFile(join(packagePath, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/example',
      version,
      type: 'module',
      exports: './index.mjs',
    }, null, 2)}\n`, 'utf8')
    await writeFile(join(packagePath, 'index.mjs'), `export const version = ${JSON.stringify(version)}\n`, 'utf8')
    await writeFile(join(cwd, 'package-lock.json'), `${JSON.stringify({ lockfileVersion: 3, version })}\n`, 'utf8')
    return ''
  }
}

async function coldResolvedVersion(patchPath: string): Promise<string> {
  const patches = loadOptionalPatches('dshc-test', patchPath) ?? []
  const shim = patches.flatMap(patch => patch.insert ?? [])
    .find(entry => typeof entry.id === 'string' && entry.id.startsWith('workspace-example-'))?.name
  if (typeof shim !== 'string') throw new Error(`plugin shim missing from ${patchPath}`)
  const profilePath = dirname(dirname(shim))
  const manifest = JSON.parse(await readFile(join(profilePath, 'node_modules', '@deepseek-ai', 'example', 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string') throw new Error('fake plugin version missing')
  return manifest.version
}
