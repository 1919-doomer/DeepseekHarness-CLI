import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { dump } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'
import { defaultRuntimeConfigPath } from '../../src/upstream/runtime-launcher.js'

const live = process.env['DSHC_LIVE_MCP'] === '1'

describe.skipIf(!live)('official MCP live gate', () => {
  it('discovers and calls a tool through a real stdio MCP server', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dshc-mcp-live-'))
    const patchPath = join(workspace, '.dshc', 'cordis.patch.yml')
    const server = fileURLToPath(new URL(
      '../../node_modules/@modelcontextprotocol/server-everything/dist/index.js',
      import.meta.url,
    ))
    const patches: PatchOptions[] = [{
      id: 'mcp-workspace',
      disabled: false,
      config: {
        transport: 'stdio',
        serverName: 'everything',
        command: process.execPath,
        args: [server],
        env: {},
        cwd: workspace,
        toolCallTimeoutMs: 30_000,
        failOnStartupError: true,
      },
    }]
    await mkdir(dirname(patchPath), { recursive: true })
    await writeFile(patchPath, dump(patches, { schema: entryListSchema, noRefs: true }), 'utf8')

    const runtime = new HarnessRuntime({
      workspace,
      configPath: defaultRuntimeConfigPath(),
      patchPaths: [patchPath],
      activityTimeoutMs: 180_000,
    })
    try {
      const result = await runtime.run(
        'Call mcp__everything__echo exactly once with message MCP_BATCH2_OK, then reply with the echoed value only.',
      )
      expect(result.events.some(event => event.kind === 'tool-call' && event.name === 'mcp__everything__echo')).toBe(true)
      expect(result.finalResponse).toContain('MCP_BATCH2_OK')
    } finally {
      await runtime.close()
      await rm(workspace, { recursive: true, force: true })
    }
  }, 240_000)
})
