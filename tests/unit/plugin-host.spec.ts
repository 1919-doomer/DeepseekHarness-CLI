import { describe, expect, it } from 'vitest'
import { TERMINAL_PLUGIN_API_VERSION } from '../../src/plugins/api.js'
import { TerminalPluginHost } from '../../src/plugins/host.js'

describe('TerminalPluginHost', () => {
  it('registers commands, aliases, views, renderers and status segments deterministically', () => {
    const host = new TerminalPluginHost()
    host.register({
      id: 'alpha',
      version: '1.0.0',
      apiVersion: TERMINAL_PLUGIN_API_VERSION,
      commands: [{ name: 'hello', aliases: ['hi'], summary: 'hello', execute: () => ({ kind: 'message', text: 'ok' }) }],
      eventRenderers: [
        { id: 'low', priority: 1, match: () => true, render: () => [] },
        { id: 'high', priority: 10, match: () => true, render: () => [] },
      ],
      views: [{ id: 'sample', title: 'Sample', render: () => 'sample' }],
      statusSegments: [
        { id: 'late', priority: 1, render: () => 'late' },
        { id: 'early', priority: 10, render: () => 'early' },
      ],
    })

    expect(host.resolveCommand('hello')).toBeDefined()
    expect(host.resolveCommand('/HI')).toBeDefined()
    expect(host.resolveView('sample')?.title).toBe('Sample')
    expect(host.listCommands()).toMatchObject([{ name: 'hello', aliases: ['hi'], pluginId: 'alpha' }])
    expect(host.listRenderers().map(item => item.id)).toEqual(['high', 'low'])
    expect(host.orderedStatusSegments().map(item => item.id)).toEqual(['early', 'late'])
  })

  it('rejects command and alias conflicts before mutating the host', () => {
    const host = new TerminalPluginHost()
    host.register({
      id: 'one',
      version: '1',
      apiVersion: TERMINAL_PLUGIN_API_VERSION,
      commands: [{ name: 'status', aliases: ['s'], summary: 'status', execute: () => ({ kind: 'message', text: 'one' }) }],
    })

    expect(() => host.register({
      id: 'two',
      version: '1',
      apiVersion: TERMINAL_PLUGIN_API_VERSION,
      commands: [{ name: 'other', aliases: ['status'], summary: 'other', execute: () => ({ kind: 'message', text: 'two' }) }],
    })).toThrow(/conflicts/i)
    expect(host.listPlugins()).toEqual([{ id: 'one', version: '1' }])
  })
})
