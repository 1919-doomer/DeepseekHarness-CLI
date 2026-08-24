import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    })
    expect(result.value).toBe(join(workspace, '.dshc', 'profiles', 'default', 'runtime-anchor.mjs'))
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
    })).rejects.toThrow('patch was rolled back')
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('[]\n')
  })
})
