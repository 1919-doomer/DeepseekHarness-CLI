import { describe, expect, it } from 'vitest'
import { TERMINAL_PLUGIN_API_VERSION } from '../../src/plugins/api.js'
import { TerminalPluginHost } from '../../src/plugins/host.js'

describe('TerminalPluginHost', () => {
  it('registers commands, aliases, views, renderers and status segments deterministically', () => {
    const host = new TerminalPluginHost()
    host.register({
      id: 'alpha', version: '1.0.0', apiVersion: TERMINAL_PLUGIN_API_VERSION,
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
    expect(host.resolveCommand('!')).toBeUndefined()
    expect(host.resolveView('sample')?.title).toBe('Sample')
    expect(host.listCommands()).toMatchObject([{ name: 'hello', aliases: ['hi'], pluginId: 'alpha' }])
    expect(host.listRenderers().map(item => item.id)).toEqual(['high', 'low'])
    expect(host.orderedStatusSegments().map(item => item.id)).toEqual(['early', 'late'])
  })

  it('rejects command and alias conflicts before mutating the host', () => {
    const host = new TerminalPluginHost()
    host.register({
      id: 'one', version: '1', apiVersion: TERMINAL_PLUGIN_API_VERSION,
      commands: [{ name: 'status', aliases: ['s'], summary: 'status', execute: () => ({ kind: 'message', text: 'one' }) }],
    })
    expect(() => host.register({
      id: 'two', version: '1', apiVersion: TERMINAL_PLUGIN_API_VERSION,
      commands: [{ name: 'other', aliases: ['status'], summary: 'other', execute: () => ({ kind: 'message', text: 'two' }) }],
    })).toThrow(/conflicts/i)
    expect(host.listPlugins()).toEqual([{ id: 'one', version: '1' }])
  })

  it('rejects conflicts inside one plugin transactionally', () => {
    const host = new TerminalPluginHost()
    expect(() => host.register({
      id: 'bad', version: '1', apiVersion: TERMINAL_PLUGIN_API_VERSION,
      commands: [
        { name: 'first', aliases: ['shared'], summary: 'first', execute: () => ({ kind: 'message', text: 'first' }) },
        { name: 'second', aliases: ['shared'], summary: 'second', execute: () => ({ kind: 'message', text: 'second' }) },
      ],
      views: [
        { id: 'duplicate-view', title: 'one', render: () => 'one' },
        { id: 'duplicate-view', title: 'two', render: () => 'two' },
      ],
    })).toThrow(/repeats/i)
    expect(host.listPlugins()).toEqual([])
    expect(host.resolveCommand('first')).toBeUndefined()
    expect(host.resolveView('duplicate-view')).toBeUndefined()
  })

  it('rejects renderer and status ids across plugins before mutation', () => {
    const host = new TerminalPluginHost()
    host.register({
      id: 'one', version: '1', apiVersion: TERMINAL_PLUGIN_API_VERSION,
      eventRenderers: [{ id: 'shared-renderer', match: () => true, render: () => [] }],
      statusSegments: [{ id: 'shared-status', render: () => 'one' }],
    })
    expect(() => host.register({
      id: 'two', version: '1', apiVersion: TERMINAL_PLUGIN_API_VERSION,
      eventRenderers: [{ id: 'shared-renderer', match: () => true, render: () => [] }],
    })).toThrow(/renderer.*conflicts/i)
    expect(() => host.register({
      id: 'three', version: '1', apiVersion: TERMINAL_PLUGIN_API_VERSION,
      statusSegments: [{ id: 'shared-status', render: () => 'three' }],
    })).toThrow(/status.*conflicts/i)
    expect(host.listPlugins()).toEqual([{ id: 'one', version: '1' }])
  })
})
