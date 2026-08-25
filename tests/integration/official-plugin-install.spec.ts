import { access, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readCompositionSummary, resolveComposition, workspaceCompositionPath } from '../../src/upstream/composition.js'
import { installWorkspacePlugin } from '../../src/upstream/plugin-management.js'
import { HarnessRuntime } from '../../src/upstream/runtime.js'
import { defaultRuntimeConfigPath, defaultRuntimeInstallAnchor } from '../../src/upstream/runtime-launcher.js'

const live = process.env['DSHC_LIVE_PLUGIN_INSTALL'] === '1'

describe.skipIf(!live)('official plugin install live gate', () => {
  it('installs an exact official plugin, patches, and trial-initializes before success', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dshc-plugin-live-'))
    let replacement: HarnessRuntime | undefined
    try {
      const installed = await installWorkspacePlugin({
        workspace,
        patchPath: workspaceCompositionPath(workspace),
        exactSpec: '@deepseek-ai/dsh-repeat-tool-reminder@0.1.1-rc.2',
        installAnchor: defaultRuntimeInstallAnchor(),
        trial: async (moduleBasePath, candidatePatchPath) => {
          await access(join(dirname(moduleBasePath), 'node_modules', '@deepseek-ai', 'dsh-repeat-tool-reminder', 'package.json'))
          expect(createRequire(moduleBasePath).resolve('@deepseek-ai/dsh-repeat-tool-reminder')).toContain('dsh-repeat-tool-reminder')
          const composition = await resolveComposition(workspace, undefined, defaultRuntimeConfigPath())
          const trialPatchPaths = composition.patchPath === undefined
            ? [...composition.patchPaths, candidatePatchPath]
            : composition.patchPaths.map(path => path === composition.patchPath ? candidatePatchPath : path)
          const runtime = new HarnessRuntime({
            workspace,
            configPath: composition.path,
            patchPaths: trialPatchPaths,
            moduleBasePath,
          })
          await runtime.start()
          replacement = runtime
          return composition
        },
        discardTrial: async () => replacement?.close(),
      })
      const summary = await readCompositionSummary(
        installed.value.path,
        installed.value.source,
        installed.patchPath,
      )
      expect(summary?.effective.entries.some(entry => entry.id.startsWith('workspace-dsh-repeat-tool-reminder-'))).toBe(true)
      expect(installed.exactSpec).toBe('@deepseek-ai/dsh-repeat-tool-reminder@0.1.1-rc.2')
    } finally {
      await replacement?.close()
      await rm(workspace, { recursive: true, force: true })
    }
  }, 240_000)
})
