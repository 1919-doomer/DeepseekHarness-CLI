import { describe, expect, it } from 'vitest'
import type { TerminalViewContext } from '../../src/plugins/api.js'
import { createDefaultTerminalHost, renderTraceQuery } from '../../src/plugins/builtins.js'
import { renderWorkbench } from '../../src/plugins/workbench.js'
import { reduceTerminalEvent, initialTerminalTranscript } from '../../src/terminal/transcript.js'
import { DEV_MODE_WARNING } from '../../src/workbench/contract.js'
import { CORDIS_WORKBENCH_REPLAY } from '../fixtures/cordis-workbench-events.js'

const runtime = {
  workspace: '/workspace',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  serverName: 'deepseek-harness-sdk-runtime',
  protocolVersion: '0.0.1',
}

describe('M6 Cordis workbench replay', () => {
  it('exposes /workbench and its trusted-mode status only in dev mode', () => {
    const ordinary = createDefaultTerminalHost()
    const developer = createDefaultTerminalHost({ devMode: true })
    expect(ordinary.resolveCommand('workbench')).toBeUndefined()
    expect(developer.resolveCommand('workbench')).toBeDefined()
    expect(developer.listRenderers()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cordis-lifecycle', priority: 250 }),
    ]))
  })

  it('replays the observed timeline from structured fields without treating prose as inventory', () => {
    const text = renderWorkbench(viewContext(CORDIS_WORKBENCH_REPLAY))
    expect(text).toContain(DEV_MODE_WARNING)
    expect(text).toContain('not authoritative real-time inventory')
    expect(text).toContain('pluginId="wthr-1" · packageId="pkg-1"')
    expect(text).toContain('define · success · 7ms')
    expect(text).toContain('no Run/Stop controls')
  })

  it('uses the specialized safe renderer and existing transcript sanitization/retention boundary', () => {
    const host = createDefaultTerminalHost({ devMode: true })
    const call = CORDIS_WORKBENCH_REPLAY[0]!
    const result = {
      ...CORDIS_WORKBENCH_REPLAY[1]!,
      text: '\u001B[2Jspoof\u0007',
      metadata: { pluginId: 'wthr-1\u001B[31m', packageId: 'pkg-1' },
    }
    const callRenderer = host.matchingRenderer(call)
    const resultRenderer = host.matchingRenderer(result)
    expect(callRenderer?.id).toBe('cordis-lifecycle')
    expect(resultRenderer?.id).toBe('cordis-lifecycle')

    let transcript = reduceTerminalEvent(initialTerminalTranscript(), call, host, 'activity-1', 'replay-session')
    transcript = reduceTerminalEvent(transcript, result, host, 'activity-1', 'replay-session')
    const block = transcript.blocks.find(item => item.kind === 'tool')
    expect(block?.detail).not.toContain('\u001B')
    expect(block?.detail).toContain('pluginId=')
    expect(block?.detail).toContain('spoof')
  })

  it('labels missing metadata as observed activity without inventing an id', () => {
    const events = CORDIS_WORKBENCH_REPLAY.map(event => event.kind === 'tool-result'
      ? { ...event, metadata: undefined }
      : event)
    const text = renderWorkbench(viewContext(events))
    expect(text).toContain('define · success')
    expect(text).not.toContain('pluginId=')
  })

  it('filters trace by Cordis activity, structured plugin id and exact nested service labels', () => {
    const context = viewContext(CORDIS_WORKBENCH_REPLAY)
    expect(renderTraceQuery(context, { mode: 'cordis', page: 1 })).toContain('4 retained matches')
    expect(renderTraceQuery(context, { mode: 'plugin', page: 1, value: 'wthr-1' })).toContain('1 retained matches')
    expect(renderTraceQuery(context, { mode: 'service', page: 1, value: 'weather' })).toContain('2 retained matches')
    expect(renderTraceQuery(context, { mode: 'service', page: 1, value: 'Service' })).toContain('No retained normalized events match')
    expect(renderTraceQuery(context, { mode: 'service', page: 1, value: 'guessed' })).toContain('No retained normalized events match')
  })

  it('reports bounded retention loss explicitly', () => {
    const context = viewContext(CORDIS_WORKBENCH_REPLAY)
    context.retention = { ...context.retention!, totalEventCount: 9, droppedEventCount: 5 }
    expect(renderWorkbench(context)).toContain('5 older normalized events were evicted')
  })
})

function viewContext(events: TerminalViewContext['events']): TerminalViewContext {
  const host = createDefaultTerminalHost({ devMode: true })
  return {
    runtime,
    session: { sessionId: 'replay-session', turnCount: 1, generation: 1 },
    phase: 'idle',
    totalTurns: 1,
    commands: host.listCommands(),
    renderers: host.listRenderers(),
    plugins: host.listPlugins(),
    events,
    retention: {
      totalEventCount: events.length,
      droppedEventCount: 0,
      droppedTranscriptBlockCount: 0,
      droppedTopologyEntryCount: 0,
    },
  }
}
