import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../../src/session/projection.js'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
import { parseTerminalCommand } from '../../src/terminal/product.js'

const runtime = {
  workspace: '/workspace',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  serverName: 'deepseek-harness-sdk-runtime',
  protocolVersion: '0.0.1',
}

describe('M3 terminal commands', () => {
  it('parses slash commands with arguments while preserving // prompts', () => {
    expect(parseTerminalCommand('/plugins')).toEqual({ name: 'plugins', args: [] })
    expect(parseTerminalCommand('/trace last 20')).toEqual({ name: 'trace', args: ['last', '20'] })
    expect(parseTerminalCommand('/reload "C:\\Program Files\\dsh\\cordis.yml" --yes')).toEqual({
      name: 'reload',
      args: ['C:\\Program Files\\dsh\\cordis.yml', '--yes'],
    })
    expect(parseTerminalCommand('//literal')).toBeUndefined()
    expect(parseTerminalCommand('normal prompt')).toBeUndefined()
  })

  it('keeps malformed slash input local instead of throwing from command lookup', () => {
    const host = createDefaultTerminalHost()
    expect(parseTerminalCommand('/')).toEqual({ name: '', args: [] })
    expect(parseTerminalCommand('/!')).toEqual({ name: '!', args: [] })
    expect(() => host.resolveCommand('')).not.toThrow()
    expect(() => host.resolveCommand('!')).not.toThrow()
    expect(host.resolveCommand('')).toBeUndefined()
    expect(host.resolveCommand('!')).toBeUndefined()
  })

  it('exposes capability-aware help and partial Harness metadata honestly', () => {
    const host = createDefaultTerminalHost()
    const base = {
      runtime,
      session: { sessionId: 'session-test', turnCount: 2, generation: 1 },
      phase: 'idle' as const,
      totalTurns: 2,
      commands: host.listCommands(),
      renderers: host.listRenderers(),
      plugins: host.listPlugins(),
      events: [],
    }
    const help = host.resolveView('help')?.render(base) ?? ''
    const capabilities = host.resolveView('capabilities')?.render(base) ?? ''
    expect(help).toContain('/plugins')
    expect(help).toContain('/trace')
    expect(capabilities).toContain('partial/unavailable')
    expect(capabilities).toContain('prompt cancel: unavailable')
    expect(capabilities).toContain('hard interrupt')
    expect(capabilities).toContain('fresh session')
    expect(capabilities).toContain('dshc.core@1.0.0')
  })

  it('/agents shows only the current root reachable tree and preserves nesting', () => {
    const host = createDefaultTerminalHost()
    const events: NormalizedEvent[] = [
      { sequence: 0, kind: 'subagent-started', parentSessionId: 'old-root', childSessionId: 'old-child' },
      { sequence: 1, kind: 'subagent-finished', parentSessionId: 'old-root', childSessionId: 'old-child' },
      { sequence: 2, kind: 'subagent-started', parentSessionId: 'current-root', childSessionId: 'child-a', provider: 'spawn' },
      { sequence: 3, kind: 'subagent-started', parentSessionId: 'child-a', childSessionId: 'grandchild', provider: 'spawn' },
      { sequence: 4, kind: 'subagent-finished', parentSessionId: 'child-a', childSessionId: 'grandchild' },
    ]
    const context = {
      runtime,
      session: { sessionId: 'current-root', turnCount: 0, generation: 2 },
      phase: 'idle' as const,
      totalTurns: 1,
      commands: host.listCommands(),
      renderers: host.listRenderers(),
      plugins: host.listPlugins(),
      events,
    }
    const agents = host.resolveView('agents')?.render(context) ?? ''
    expect(agents).toContain('root current-root')
    expect(agents).toContain('child-a')
    expect(agents).toContain('grandchild')
    expect(agents).not.toContain('old-child')
    expect(agents.indexOf('grandchild')).toBeGreaterThan(agents.indexOf('child-a'))
  })
})
