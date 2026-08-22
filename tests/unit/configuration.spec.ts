import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
import { CONFIRM_TOKEN } from '../../src/plugins/configuration.js'
import { readCompositionSummary } from '../../src/upstream/composition.js'
import { defaultRuntimeConfigPath } from '../../src/upstream/runtime-launcher.js'

const host = createDefaultTerminalHost()

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

function run(name: string, args: readonly string[]) {
  const command = host.resolveCommand(name)
  if (command === undefined) throw new Error(`no command ${name}`)
  const outcome = command.execute(context, args)
  if (outcome instanceof Promise) throw new Error('configuration commands are synchronous')
  return outcome
}

describe('configuration commands', () => {
  it('states the session loss before doing anything', () => {
    const outcome = run('model', ['deepseek-v4'])
    expect(outcome.kind).toBe('message')
    if (outcome.kind !== 'message') throw new Error('expected a message')
    expect(outcome.text).toContain('restarts the Harness runtime')
    expect(outcome.text).toContain('current session ends')
    expect(outcome.text).toContain(CONFIRM_TOKEN)
  })

  it('only restarts once confirmed', () => {
    expect(run('model', ['deepseek-v4', CONFIRM_TOKEN])).toEqual({
      kind: 'restart-runtime',
      selection: { model: 'deepseek-v4' },
      summary: 'model deepseek-v4',
    })
    expect(run('provider', ['other', CONFIRM_TOKEN])).toMatchObject({
      kind: 'restart-runtime',
      selection: { provider: 'other' },
    })
  })

  it('rejects a missing or ambiguous argument rather than guessing', () => {
    expect(run('model', [])).toMatchObject({ kind: 'message' })
    expect(run('model', ['a', 'b'])).toMatchObject({ kind: 'message' })
    expect(run('reload', ['a', 'b'])).toMatchObject({ kind: 'message' })
  })

  it('reloads the current composition when no path is given', () => {
    expect(run('reload', [CONFIRM_TOKEN])).toEqual({
      kind: 'restart-runtime',
      selection: {},
      summary: 'the current composition',
    })
  })

  it('carries a composition path through to the restart', () => {
    expect(run('reload', ['./my.cordis.yml', CONFIRM_TOKEN])).toMatchObject({
      kind: 'restart-runtime',
      selection: { runtimeConfig: './my.cordis.yml' },
    })
  })

  it('says dshc does not judge the file, and points at doctor', () => {
    const outcome = run('reload', ['./my.cordis.yml'])
    if (outcome.kind !== 'message') throw new Error('expected a message')
    expect(outcome.text).toContain('does not interpret this file')
    expect(outcome.text).toContain('doctor')
  })
})

describe('composition summary', () => {
  it('reports the settings the shipped composition launches with', async () => {
    const summary = await readCompositionSummary(defaultRuntimeConfigPath(), 'shipped-default')
    if (summary === undefined) throw new Error('shipped composition should be readable')

    const settings = summary.entries.flatMap(entry => entry.settings)
    // The numbers a user would want to change are exactly the ones that were
    // previously invisible: reasoning effort and the compaction thresholds.
    expect(settings.some(line => line.startsWith('reasoningEffort:'))).toBe(true)
    expect(settings.some(line => line.startsWith('thresholdRatio:'))).toBe(true)
    expect(summary.entries.some(entry => entry.id === 'approval')).toBe(true)
    expect(summary.source).toBe('shipped-default')
  })

  it('returns undefined for a file it cannot read, rather than inventing one', async () => {
    expect(await readCompositionSummary('/definitely/not/here.yml', 'override')).toBeUndefined()
  })

  it('ignores comments and keeps entries in file order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshc-composition-'))
    const path = join(dir, 'c.yml')
    await writeFile(path, [
      '# a comment',
      '- id: first',
      "  name: '@scope/first'",
      '  config:',
      '    alpha: 1',
      '# another comment',
      '- id: second',
      "  name: '@scope/second'",
    ].join('\n'), 'utf8')

    const summary = await readCompositionSummary(path, 'override')
    expect(summary?.entries.map(entry => entry.id)).toEqual(['first', 'second'])
    expect(summary?.entries[0]?.settings).toEqual(['alpha: 1'])
    expect(summary?.entries[1]?.settings).toEqual([])
  })
})
