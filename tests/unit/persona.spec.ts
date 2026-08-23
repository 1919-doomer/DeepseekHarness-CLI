import { describe, expect, it } from 'vitest'
import { readCompositionSummary } from '../../src/upstream/composition.js'
import { buildPersona, PERSONA_ENV_VAR, resolvePersona } from '../../src/upstream/persona.js'
import { defaultRuntimeConfigPath, effectiveRuntimeEnvironment } from '../../src/upstream/runtime-launcher.js'

const facts = {
  platform: 'win32' as NodeJS.Platform,
  workspace: String.raw`C:\work\repo`,
  network: { proxies: [] },
}

describe('deployment persona', () => {
  it('carries no {{variable}} reference, which upstream renders strictly', () => {
    // `dsh-system-prompt` throws on an unknown or undefined reference, so a
    // stray `{{` here would fail every assembly rather than degrade.
    for (const platform of ['win32', 'linux', 'darwin', 'aix'] as NodeJS.Platform[]) {
      expect(buildPersona({ ...facts, platform })).not.toContain('{{')
    }
  })

  it('names the host and the workspace dshc actually launched with', () => {
    expect(buildPersona(facts)).toContain(String.raw`C:\work\repo`)
    expect(buildPersona(facts)).toContain('Windows')
    expect(buildPersona({ ...facts, platform: 'linux' })).toContain('Linux')
    expect(buildPersona({ ...facts, platform: 'darwin' })).toContain('macOS')
  })

  it('states the two facts upstream cannot know: no approver, no per-request cancel', () => {
    const persona = buildPersona(facts)
    expect(persona).toContain('fails')
    expect(persona).toContain('escalation')
    expect(persona).toContain('no per-request cancel')
  })

  it('does not restate a setting the composition owns', () => {
    // Naming reasoningEffort or a compaction ratio here would duplicate an
    // upstream schema and go stale on their next release.
    const persona = buildPersona(facts)
    for (const owned of ['reasoningEffort', 'thresholdRatio', 'workspace-write', 'maxTokens']) {
      expect(persona).not.toContain(owned)
    }
  })

  it('yields to an operator-set persona rather than merging with it', () => {
    expect(resolvePersona({ [PERSONA_ENV_VAR]: 'mine' }, facts)).toBeUndefined()
    expect(resolvePersona({ [PERSONA_ENV_VAR]: '   ' }, facts)).toBeDefined()
    expect(resolvePersona({}, facts)).toBeDefined()
  })

  it('reaches the child through the launch environment', () => {
    const env = effectiveRuntimeEnvironment({ workspace: '/tmp/ws' })
    expect(env[PERSONA_ENV_VAR]).toContain('/tmp/ws')
    expect(env.DSH_CWD).toBe('/tmp/ws')

    const overridden = effectiveRuntimeEnvironment({
      workspace: '/tmp/ws',
      env: { [PERSONA_ENV_VAR]: 'operator wrote this' },
    })
    expect(overridden[PERSONA_ENV_VAR]).toBe('operator wrote this')
  })
})

describe('shipped role subagents', () => {
  it('mounts a read-only role library on the upstream delegation seam', async () => {
    const summary = await readCompositionSummary(defaultRuntimeConfigPath(), 'shipped-default')
    if (summary === undefined) throw new Error('shipped composition should be readable')
    const ids = summary.entries.map(entry => entry.id)
    for (const role of ['scout', 'planner', 'reviewer', 'oracle']) {
      expect(ids).toContain(`tool-subagent-${role}`)
    }
  })

  it('summarises a persona by size instead of pasting the prompt into /config', async () => {
    const summary = await readCompositionSummary(defaultRuntimeConfigPath(), 'shipped-default')
    const scout = summary?.entries.find(entry => entry.id === 'tool-subagent-scout')
    expect(scout?.settings).toContain('toolName: scout')
    expect(scout?.settings.some(line => /^persona: \d+ lines$/.test(line))).toBe(true)
    // The prompt body must not leak in as individual settings.
    expect(scout?.settings.some(line => line.includes('reconnaissance'))).toBe(false)
  })
})
