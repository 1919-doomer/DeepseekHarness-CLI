import { describe, expect, it } from 'vitest'
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
    expect(parseTerminalCommand('//literal')).toBeUndefined()
    expect(parseTerminalCommand('normal prompt')).toBeUndefined()
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
    expect(capabilities).toContain('dshc.core@1.0.0')
  })
})
