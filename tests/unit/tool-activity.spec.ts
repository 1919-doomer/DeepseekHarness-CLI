import { describe, expect, it } from 'vitest'
import { normalizeNotification, type NormalizedEvent } from '../../src/session/projection.js'
import {
  formatActivityCounts,
  formatActivityRow,
  projectToolActivity,
  MAX_ACTIVITY_DEPTH,
} from '../../src/terminal/tool-activity.js'
import { terminalCellWidth } from '../../src/terminal/text-metrics.js'

let seq = 0

function event(type: string, data: Record<string, unknown>, sessionId: string, time?: number): NormalizedEvent {
  const envelope: Record<string, unknown> = { type, data, seq: seq++ }
  if (time !== undefined) envelope.time = time
  return normalizeNotification({ method: 'session.event', params: { sessionId, event: envelope } })
}

function call(sessionId: string, callId: string, name: string, args: string, time?: number): NormalizedEvent {
  return event('tool/call', { callId, name, arguments: args }, sessionId, time)
}

function result(sessionId: string, callId: string, isError = false, time?: number): NormalizedEvent {
  return event('tool/result', {
    message: {
      source: { kind: 'tool', callId },
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'x' }], isError }],
    },
  }, sessionId, time)
}

function spawned(parentSessionId: string, childSessionId: string): NormalizedEvent {
  return normalizeNotification({
    method: 'subagent.started',
    params: { parentSessionId, childSessionId },
  })
}

describe('projectToolActivity', () => {
  it('reuses the description the transcript shows, and falls back to the tool name', () => {
    const { rows } = projectToolActivity([
      call('root', 'c1', 'read', '{"file_path":"src/stats.js"}'),
      call('root', 'c2', 'some-future-tool', '{"unmodelled":true}'),
    ], 'root')

    expect(rows[0]?.label).toBe('read · src/stats.js')
    // An unknown tool degrades to its name; it never disappears.
    expect(rows[1]?.label).toBe('some-future-tool')
  })

  it('tracks outcome and the upstream span', () => {
    const { rows, counts } = projectToolActivity([
      call('root', 'c1', 'read', '{"file_path":"a"}', 1000),
      result('root', 'c1', false, 1312),
      call('root', 'c2', 'read', '{"file_path":"b"}', 2000),
      result('root', 'c2', true, 2100),
      call('root', 'c3', 'read', '{"file_path":"c"}', 3000),
    ], 'root')

    expect(rows.map(row => row.state)).toEqual(['success', 'error', 'running'])
    expect(rows[0]?.elapsedMs).toBe(312)
    expect(rows[1]?.elapsedMs).toBe(100)
    expect(rows[2]?.elapsedMs).toBeUndefined()
    expect(counts).toEqual({ total: 3, running: 1, success: 1, error: 1 })
  })

  it('indents a descendant under its parent', () => {
    const { rows } = projectToolActivity([
      call('root', 'c1', 'read', '{"file_path":"a"}'),
      spawned('root', 'child'),
      call('child', 'c2', 'read', '{"file_path":"b"}'),
      spawned('child', 'grandchild'),
      call('grandchild', 'c3', 'read', '{"file_path":"c"}'),
    ], 'root')

    expect(rows.map(row => row.depth)).toEqual([0, 1, 2])
    expect(rows.every(row => !row.orphaned)).toBe(true)
  })

  it('marks a descendant orphaned rather than reattaching it', () => {
    // The subagent.started that would link this session to the root was
    // evicted, so the relationship is unobservable.
    const { rows } = projectToolActivity([
      call('unlinked-child', 'c1', 'read', '{"file_path":"a"}'),
    ], 'root')

    expect(rows[0]).toMatchObject({ orphaned: true, depth: 1 })
  })

  it('does not loop on a cyclic parent relationship', () => {
    const { rows } = projectToolActivity([
      spawned('b', 'a'),
      spawned('a', 'b'),
      call('a', 'c1', 'read', '{"file_path":"a"}'),
    ], 'root')

    expect(rows).toHaveLength(1)
    expect(rows[0]?.orphaned).toBe(true)
  })

  it('keeps a result whose call was evicted instead of dropping observed activity', () => {
    const { rows, counts } = projectToolActivity([result('root', 'gone', true)], 'root')
    expect(rows[0]).toMatchObject({ state: 'error', label: 'call evicted from local retention' })
    expect(counts.error).toBe(1)
  })

  it('keeps one row per call rather than one per event', () => {
    const { rows } = projectToolActivity([
      call('root', 'c1', 'read', '{"file_path":"a"}'),
      result('root', 'c1'),
    ], 'root')
    expect(rows).toHaveLength(1)
  })
})

describe('formatActivityRow', () => {
  const base = { key: 'k', sessionId: 'root', callId: 'c1', orphaned: false }

  it('never exceeds the given width', () => {
    const row = { ...base, state: 'success' as const, label: 'read · ' + 'x'.repeat(200), depth: 0 }
    for (const width of [8, 20, 30, 120]) {
      expect(terminalCellWidth(formatActivityRow(row, width))).toBeLessThanOrEqual(width)
    }
  })

  it('crops wide characters without exceeding the width', () => {
    const row = { ...base, state: 'running' as const, label: '读取文件'.repeat(20), depth: 0 }
    for (const width of [9, 11, 25]) {
      expect(terminalCellWidth(formatActivityRow(row, width))).toBeLessThanOrEqual(width)
    }
  })

  it('indents by depth and reports depth numerically past the bound', () => {
    const deep = { ...base, state: 'success' as const, label: 'read', depth: MAX_ACTIVITY_DEPTH + 2 }
    expect(formatActivityRow(deep, 40)).toContain(`+${MAX_ACTIVITY_DEPTH + 2}`)
    expect(formatActivityRow({ ...base, state: 'success' as const, label: 'read', depth: 1 }, 40))
      .toBe('  ✓ read')
  })

  it('marks an orphan distinctly from an outcome', () => {
    const row = { ...base, orphaned: true, state: 'success' as const, label: 'read', depth: 1 }
    expect(formatActivityRow(row, 40)).toContain('?')
  })
})

describe('formatActivityCounts', () => {
  it('states each count in words, not by colour alone', () => {
    expect(formatActivityCounts({ total: 5, running: 0, success: 4, error: 1 }))
      .toBe('5 calls · 4 ok · 1 failed')
  })

  it('names running calls so the parts reconcile with the total', () => {
    expect(formatActivityCounts({ total: 6, running: 1, success: 4, error: 1 }))
      .toBe('6 calls · 4 ok · 1 failed · 1 running')
  })
})
