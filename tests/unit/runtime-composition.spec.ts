import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const runtimeConfigUrl = new URL('../../runtime/cordis.yml', import.meta.url)
const packageJsonUrl = new URL('../../package.json', import.meta.url)

const UPSTREAM_JSONRPC_REFERENCE =
  'deepseek-ai/deepseek-harness@141eb6fef83422698aef7a981029e843e8161534:examples/jsonrpc-agent/cordis.yml'

const REFERENCE_PLUGIN_IDS = [
  'sdk-jsonrpc-server',
  'llm-deepseek',
  'subprocess',
  'agent-spine',
  'sessions',
  'session-checkpoints',
  'subagent',
  'subagent-spawn-in-process',
  'tool-subagent',
  'tool-todo',
  'fs-local',
  'fs-observation-policy',
  'tool-fs',
  'token-meter',
  'compaction-basic',
] as const

describe('M4 runtime composition', () => {
  it('keeps the upstream JSON-RPC spine plus M4 repository and platform-shell additions', async () => {
    const config = await readFile(runtimeConfigUrl, 'utf8')
    const entries = parsePluginEntries(config)
    const ids = new Set(entries.map(entry => entry.id))

    for (const id of REFERENCE_PLUGIN_IDS) expect(ids.has(id), `missing ${id} from ${UPSTREAM_JSONRPC_REFERENCE}`).toBe(true)

    expect(entries).toEqual(expect.arrayContaining([
      { id: 'bash', name: '@deepseek-ai/dsh-bash-local' },
      { id: 'pwsh', name: '@deepseek-ai/dsh-pwsh-local' },
      { id: 'shell-env', name: '@deepseek-ai/dsh-shell-env' },
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
      { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' },
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
    ]))

    expect(config).toContain("disabled: !!js process.platform === 'win32'")
    expect(config).toContain("disabled: !!js process.platform !== 'win32'")
    expect(config).toContain('workspaceContext:\n      maxBytes: 65536')
    expect(config).toContain('sampleOverCapGlobResults: false')
    expect(config).toContain('toolBash: false')
    expect(config).not.toContain("?? './.sessions'")
  })

  it('declares every external Cordis plugin as a direct dependency of the config-owning package', async () => {
    const config = await readFile(runtimeConfigUrl, 'utf8')
    const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dependencies = packageJson.dependencies ?? {}

    for (const { name } of parsePluginEntries(config)) {
      expect(dependencies[name], `${name} must be direct because dsh-jsonrpc-agent external configs own bare plugins`).toBe('0.1.0-rc.8')
    }
  })
})

function parsePluginEntries(config: string): Array<{ id: string; name: string }> {
  return [...config.matchAll(/^- id: ([^\n]+)\n  name: '([^']+)'/gm)].map(match => ({
    id: match[1] ?? '',
    name: match[2] ?? '',
  }))
}
