import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { TESTED_DSH_BASELINE } from '../../src/upstream/compatibility.js'

const runtimeConfigUrl = new URL('../../runtime/cordis.yml', import.meta.url)
const packageJsonUrl = new URL('../../package.json', import.meta.url)

const UPSTREAM_JSONRPC_REFERENCE =
  'deepseek-ai/deepseek-harness@b150a551b8d465e31e418e1b2eaf5e79bbb7d28e:examples/jsonrpc-agent/cordis.yml'

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
  'fs-observation-policy',
  'tool-fs',
  'token-meter',
  'compaction-basic',
] as const

describe('M4 runtime composition', () => {
  it('keeps the upstream JSON-RPC spine plus the M4 sandboxed repository baseline', async () => {
    const config = await readFile(runtimeConfigUrl, 'utf8')
    const entries = parsePluginEntries(config)
    const ids = new Set(entries.map(entry => entry.id))

    for (const id of REFERENCE_PLUGIN_IDS) expect(ids.has(id), `missing ${id} from ${UPSTREAM_JSONRPC_REFERENCE}`).toBe(true)

    expect(entries).toEqual(expect.arrayContaining([
      { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local' },
      { id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy' },
      { id: 'approval', name: '@deepseek-ai/dsh-user-approval' },
      { id: 'bash', name: '@deepseek-ai/dsh-bash-sandbox' },
      { id: 'pwsh', name: '@deepseek-ai/dsh-pwsh-sandbox' },
      { id: 'fs-sandbox', name: '@deepseek-ai/dsh-fs-sandbox' },
      { id: 'shell-env', name: '@deepseek-ai/dsh-shell-env' },
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
      { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' },
      { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
    ]))

    expect(config).toContain('mode: workspace-write')
    // `never`, not `ask`: no answerer exists on this transport, so `ask` told
    // the model it might be prompted and then failed closed in silence.
    expect(config).toContain('policy: never')
    expect(config).not.toContain('policy: ask')
    expect(config).toContain("disabled: !!js process.platform === 'win32'")
    expect(config).toContain("disabled: !!js process.platform !== 'win32'")
    expect(config).toContain('workspaceContext:\n      maxBytes: 65536')
    expect(config).toContain('sampleOverCapGlobResults: false')
    expect(config).toContain('toolBash: false')
    expect(config).not.toContain("name: '@deepseek-ai/dsh-bash-local'")
    expect(config).not.toContain("name: '@deepseek-ai/dsh-pwsh-local'")
    expect(config).not.toContain("name: '@deepseek-ai/dsh-fs-local'")
    expect(config).not.toContain('mode: danger-full-access')
    expect(config).not.toContain("?? './.sessions'")
  })

  it('declares every external Cordis plugin as a direct dependency of the config-owning package', async () => {
    const config = await readFile(runtimeConfigUrl, 'utf8')
    const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dependencies = packageJson.dependencies ?? {}

    for (const { name } of parsePluginEntries(config)) {
      expect(dependencies[name], `${name} must be direct because dsh-jsonrpc-agent external configs own bare plugins`).toBe(TESTED_DSH_BASELINE.sdkVersion)
    }
  })

  it('pins the complete direct Harness closure to one tested release candidate', async () => {
    const packageJson = JSON.parse(await readFile(packageJsonUrl, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const dshDependencies = Object.entries(packageJson.dependencies ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

    expect(dshDependencies.length).toBeGreaterThan(0)
    for (const [name, version] of dshDependencies) {
      expect(version, `${name} must not create a mixed Harness runtime closure`).toBe(TESTED_DSH_BASELINE.sdkVersion)
    }
  })
})

function parsePluginEntries(config: string): Array<{ id: string; name: string }> {
  return [...config.matchAll(/^- id: ([^\n]+)\n  name: '([^']+)'/gm)].map(match => ({
    id: match[1] ?? '',
    name: match[2] ?? '',
  }))
}
