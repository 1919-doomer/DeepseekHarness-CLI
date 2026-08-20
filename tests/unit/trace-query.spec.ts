import { describe, expect, it } from 'vitest'
import type { TerminalViewContext } from '../../src/plugins/api.js'
import {
  createDefaultTerminalHost,
  parseTraceQuery,
  renderTraceQuery,
} from '../../src/plugins/builtins.js'
import type { NormalizedEvent } from '../../src/session/projection.js'

const runtime = {
  workspace: '/workspace',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  serverName: 'deepseek-harness-sdk-runtime',
  protocolVersion: '0.0.1',
}

describe('M4.4 trace debugger query', () => {
  it('parses filters, search, session and positive page options', () => {
    expect(parseTraceQuery([])).toEqual({ mode: 'all', page: 1 })
    expect(parseTraceQuery(['errors'])).toEqual({ mode: 'errors', page: 1 })
    expect(parseTraceQuery(['tools', '--page', '3'])).toEqual({ mode: 'tools', page: 3 })
    expect(parseTraceQuery(['--page', '2', 'unknown'])).toEqual({ mode: 'unknown', page: 2 })
    expect(parseTraceQuery(['session', 'session-a', '--page', '4'])).toEqual({ mode: 'session', value: 'session-a', page: 4 })
    expect(parseTraceQuery(['find', 'Permission', 'DENIED', '--page', '2'])).toEqual({
      mode: 'find',
      value: 'Permission DENIED',
      page: 2,
    })
  })

  it.each([
    [['errors', 'extra'], '/trace errors does not accept extra arguments'],
    [['session'], '/trace session requires exactly one session id'],
    [['find'], '/trace find requires search text'],
    [['tools', '--page', '0'], '/trace --page requires a positive safe integer'],
    [['tools', '--page', 'abc'], '/trace --page requires a positive safe integer'],
    [['tools', '--page', '2', '--page', '3'], '/trace accepts only one --page option'],
    [['nonsense'], 'usage:'],
  ] as const)('rejects invalid query %o', (args, message) => {
    expect(() => parseTraceQuery(args)).toThrow(message)
  })

  it('preserves absolute numbering after eviction and drills into public failures', () => {
    const events: NormalizedEvent[] = [
      { sequence: 60, kind: 'tool-call', sessionId: 'root', callId: 'call-a', name: 'bash', arguments: '{}' },
      { sequence: 61, kind: 'tool-result', sessionId: 'root', callId: 'call-a', text: 'Permission denied outside workspace', isError: true },
      { sequence: 62, kind: 'unknown', sessionId: 'child', method: 'future.notice', type: 'alpha' },
      { sequence: 63, kind: 'turn-error', sessionId: 'root', message: 'provider turn failed visibly' },
    ]
    const context = viewContext(events, { totalEventCount: 10, droppedEventCount: 6 })

    const errors = renderTraceQuery(context, { mode: 'errors', page: 1 })
    expect(errors).toContain('query: errors · page 1/1 · 2 retained matches')
    expect(errors).toContain('scope: retained 4/10 normalized events; 6 older evicted locally')
    expect(errors).toContain('0007 tool.error root call-a Permission denied outside workspace')
    expect(errors).toContain('0009 turn.error root provider turn failed visibly')
    expect(errors).toContain('failure summary: 1 upstream turn-error · 1 tool-result error')
    expect(errors).toContain('local transport/protocol/configuration failures are not relabelled as trace events')

    const find = renderTraceQuery(context, { mode: 'find', page: 1, value: 'PERMISSION DENIED' })
    expect(find).toContain('1 retained matches')
    expect(find).toContain('0007 tool.error')
    expect(find).not.toContain('0009 turn.error')
  })

  it('filters by public session identity and summarizes unknown signatures without inventing meanings', () => {
    const events: NormalizedEvent[] = [
      { sequence: 1, kind: 'subagent-started', parentSessionId: 'root', childSessionId: 'child-a', provider: 'spawn' },
      { sequence: 2, kind: 'unknown', sessionId: 'child-a', method: 'future.notice', type: 'alpha' },
      { sequence: 3, kind: 'unknown', sessionId: 'child-a', method: 'future.notice', type: 'alpha' },
      { sequence: 4, kind: 'unknown', sessionId: 'root', method: 'future.other', type: 'beta' },
      { sequence: 5, kind: 'assistant-message', sessionId: 'root', text: 'done' },
    ]
    const context = viewContext(events, { totalEventCount: 5, droppedEventCount: 0 })

    const child = renderTraceQuery(context, { mode: 'session', page: 1, value: 'child-a' })
    expect(child).toContain('query: session child-a')
    expect(child).toContain('0000 agent.start child-a <- root')
    expect(child).toContain('future.notice/alpha')
    expect(child).not.toContain('future.other/beta')

    const unknown = renderTraceQuery(context, { mode: 'unknown', page: 1 })
    expect(unknown).toContain('unknown summary: future.notice/alpha ×2 · future.other/beta ×1')
    expect(unknown).toContain('meanings are not inferred')
  })

  it('pages from the newest retained matches in viewport-sized chunks while keeping process-absolute indices', () => {
    const events: NormalizedEvent[] = Array.from({ length: 170 }, (_, index): NormalizedEvent => ({
      sequence: 30 + index,
      kind: 'unknown',
      sessionId: 'root',
      method: `future.${30 + index}`,
    }))
    const context = viewContext(events, { totalEventCount: 200, droppedEventCount: 30 })

    const pageOne = renderTraceQuery(context, { mode: 'all', page: 1 })
    expect(pageOne).toContain('page 1/9 · 170 retained matches')
    expect(pageOne).toContain('0180 unknown root future.180')
    expect(pageOne).toContain('0199 unknown root future.199')
    expect(pageOne).not.toContain('0179 unknown root future.179')

    const pageTwo = renderTraceQuery(context, { mode: 'all', page: 2 })
    expect(pageTwo).toContain('page 2/9')
    expect(pageTwo).toContain('0160 unknown root future.160')
    expect(pageTwo).toContain('0179 unknown root future.179')
    expect(pageTwo).not.toContain('0180 unknown root future.180')

    const pageNine = renderTraceQuery(context, { mode: 'all', page: 9 })
    expect(pageNine).toContain('0030 unknown root future.30')
    expect(pageNine).toContain('0039 unknown root future.39')

    const missing = renderTraceQuery(context, { mode: 'all', page: 10 })
    expect(missing).toContain('No such retained page. Available pages: 1-9.')
  })
})

function viewContext(
  events: readonly NormalizedEvent[],
  retention: { totalEventCount: number; droppedEventCount: number },
): TerminalViewContext {
  const host = createDefaultTerminalHost()
  return {
    runtime,
    session: { sessionId: 'root', turnCount: 1, generation: 1 },
    phase: 'idle',
    totalTurns: 1,
    commands: host.listCommands(),
    renderers: host.listRenderers(),
    plugins: host.listPlugins(),
    events,
    retention: {
      ...retention,
      droppedTranscriptBlockCount: 0,
      droppedTopologyEntryCount: 0,
    },
  }
}
