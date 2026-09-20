import { describe, it, expect } from 'vitest'
import { selectHistoryEvidence, buildHistoryContinuePrompt, MAX_COMPACT_HISTORY_CHARS, fingerprintHistoryAskSelection } from '../../src/history/ask.js'
import type { HistorySessionDetail, HistoryMessage } from '../../src/history/types.js'

function detail(messages: HistoryMessage[]): HistorySessionDetail {
  return { summary: { id: 'source', cwd: '/work', title: 'work', createdAt: 1, updatedAt: 10,
    messageCount: messages.length, toolCallCount: 0, compactionCount: 0, approvalCount: 0 },
  messages, approvals: [], droppedMessageCount: 3, eventCount: messages.length }
}
function message(seq: number, role: HistoryMessage['role'], text: string): HistoryMessage {
  return { sessionId: 'source', seq, time: seq + 1, role, text, truncatedChars: 0 }
}

describe('compact historical evidence', () => {
  it('keeps the original request and recent instructions despite large tool outputs, without changing stored history', () => {
    const messages = [message(0, 'user', 'Original task'),
      ...Array.from({ length: 30 }, (_, i) => message(i + 1, 'tool', 'output'.repeat(4000))),
      message(31, 'user', 'Latest correction'), message(32, 'assistant', 'Done: x. Pending: y.')]
    const before = JSON.stringify(messages)
    const selection = selectHistoryEvidence(detail(messages), undefined, 'Continue', 'continue', true)
    expect(selection.messages.map(m => m.seq)).toEqual(expect.arrayContaining([0, 31, 32]))
    expect(selection.messages.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(MAX_COMPACT_HISTORY_CHARS)
    expect(selection.omittedMessageCount).toBe(3 + messages.length - selection.messages.length)
    expect(JSON.stringify(messages)).toBe(before)
    const prompt = buildHistoryContinuePrompt(selection)
    expect(prompt).toContain('Pending: y.')
    expect(prompt).toContain('"omittedMessages":')
    expect(prompt).toContain('Re-inspect the current workspace')
  })

  it('preserves both ends of long messages and binds confirmation to the excerpts and compression choice', () => {
    const source = detail([message(1, 'user', 'START' + '😀'.repeat(10000) + 'END')])
    const compact = selectHistoryEvidence(source, [1], 'Continue', 'continue', true)
    expect(compact.messages[0]!.text).toMatch(/^START[\s\S]+END$/)
    expect(compact.messages[0]!.text).not.toMatch(/\uD83D(?!\uDE00)|(?<!\uD83D)\uDE00/)
    expect(compact.messages[0]!.truncatedChars).toBeGreaterThan(0)
    expect(compact.omittedMessageCount).toBe(0)
    expect(fingerprintHistoryAskSelection(compact, 'continue')).not.toBe(fingerprintHistoryAskSelection(
      selectHistoryEvidence(source, [1], 'Continue', 'continue'), 'continue'))
  })

  it('keeps the most recent user correction even after many assistant steps', () => {
    const source = detail([message(0, 'user', 'Start'), message(1, 'user', 'Do not deploy'),
      ...Array.from({ length: 25 }, (_, i) => message(i + 2, 'assistant', 'step ' + i))])
    const selection = selectHistoryEvidence(source, undefined, 'Continue', 'continue', true)
    expect(selection.messages.map(m => m.seq)).toEqual(expect.arrayContaining([0, 1, 26]))
    expect(selection.messages.length).toBeLessThanOrEqual(12)
  })

  it('does not expand explicit message selections and accurately counts full-mode budget omissions', () => {
    const source = detail([message(1, 'user', 'excluded'), message(2, 'assistant', 'chosen')])
    expect(selectHistoryEvidence(source, [2], 'Continue', 'continue', true).messages.map(m => m.seq)).toEqual([2])
    const huge = detail([message(1, 'user', 'x'.repeat(70000)), message(2, 'assistant', 'tail')])
    const selection = selectHistoryEvidence(huge, undefined, 'Continue', 'continue')
    expect(selection.omittedMessageCount).toBe(4)
    expect(selection.messages[0]!.truncatedChars).toBe(70000 - 64 * 1024)
  })
})
