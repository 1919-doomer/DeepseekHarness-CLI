import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveComposition,
  workspaceCompositionPath,
} from '../../src/upstream/composition.js'
import { defaultRuntimeConfigPath } from '../../src/upstream/runtime-launcher.js'

const shipped = defaultRuntimeConfigPath()

async function workspaceWithComposition(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dshc-discovery-'))
  const path = workspaceCompositionPath(dir)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '- id: nothing\n', 'utf8')
  return dir
}

describe('composition discovery', () => {
  it('uses the shipped composition when the workspace carries none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshc-discovery-'))
    expect(await resolveComposition(dir, undefined, shipped)).toEqual({
      path: shipped,
      source: 'shipped-default',
      patchPaths: [],
    })
  })

  it('keeps the shipped base and finds the workspace patch layer', async () => {
    const dir = await workspaceWithComposition()
    expect(await resolveComposition(dir, undefined, shipped)).toEqual({
      path: shipped,
      source: 'shipped-default',
      patchPath: workspaceCompositionPath(dir),
      patchPaths: [workspaceCompositionPath(dir)],
    })
  })

  it('lets an explicit flag win over the workspace', async () => {
    const dir = await workspaceWithComposition()
    const resolved = await resolveComposition(dir, './elsewhere.yml', shipped)
    expect(resolved.source).toBe('override')
    expect(resolved.path).not.toBe(workspaceCompositionPath(dir))
    expect(resolved.patchPath).toBeUndefined()
  })

  it('does not fall back when an explicit path is missing', async () => {
    // Silently launching a different composition than the one that was named is
    // worse than failing: the launch must fail naming that path.
    const dir = await workspaceWithComposition()
    const resolved = await resolveComposition(dir, '/definitely/not/here.yml', shipped)
    expect(resolved.source).toBe('override')
    expect(resolved.path).not.toBe(shipped)
  })
})
