import { describe, expect, it } from 'vitest'
import { TranscriptLayoutCache, selectTranscriptPage, transcriptAnchor } from '../../src/terminal/transcript-viewport.js'
import { terminalCellWidth } from '../../src/terminal/text-metrics.js'
import type { TranscriptBlock } from '../../src/plugins/api.js'

describe('transcript row viewport', () => {
  it('can read every row of one oversized response, including its tail', () => {
    const text = Array.from({ length: 100 }, (_, index) => `answer-${index}`).join('\n')
    const layout = new TranscriptLayoutCache().prepare([{ id: 'long', kind: 'assistant', text }], 40, 'en')
    const tail = selectTranscriptPage(layout, 10)
    expect(tail.rows.flatMap(row => row.spans.map(span => span.text)).join('\n')).toContain('answer-99')
    const observed = new Set<string>()
    for (let top = 0; top <= tail.maximum; top += 1) {
      const page = selectTranscriptPage(layout, 10, transcriptAnchor(layout, top))
      expect(page.rows.length + (page.above > 0 || page.below > 0 ? 1 : 0)).toBeLessThanOrEqual(10)
      for (const row of page.rows) observed.add(row.spans.map(span => span.text).join(''))
    }
    for (let index = 0; index < 100; index++) expect(observed.has(`answer-${index}`)).toBe(true)
  })

  it('wraps Chinese, emoji, code and wide table cells without losing content', () => {
    const block: TranscriptBlock = { id: 'markdown', kind: 'assistant', text: [
      '# 检查结果', '中文😀'.repeat(20), '', '```txt', 'a'.repeat(73), '```', '',
      '| 文件 | 原因 |', '| --- | --- |', '| file.ts | ' + '这是完整原因'.repeat(10) + '末尾标记 |',
    ].join('\n') }
    const layout = new TranscriptLayoutCache().prepare([block], 24, 'zh-CN')
    const all = layout.entries.flatMap(entry => entry.rows)
    for (const row of all) expect(terminalCellWidth(row.spans.map(span => span.text).join(''))).toBeLessThanOrEqual(24)
    const content = all.flatMap(row => row.spans.map(span => span.text)).join('')
    expect(content).toContain('中文😀'.repeat(20))
    expect(content).toContain('a'.repeat(73))
    expect(content).toContain('这是完整原因'.repeat(10) + '末尾标记')
    expect(content).not.toContain('\uFFFD')
  })

  it('keeps a reading anchor during streaming and safely handles resize and eviction', () => {
    const cache = new TranscriptLayoutCache()
    const old: TranscriptBlock = { id: 'old', kind: 'assistant', text: Array.from({ length: 20 }, (_, i) => `old-${i}`).join('\n') }
    const layout = cache.prepare([old], 40, 'en')
    const anchor = transcriptAnchor(layout, 7)
    const growing = cache.prepare([old, { id: 'new', kind: 'assistant', state: 'running', text: 'next\n'.repeat(30) }], 40, 'en')
    expect(selectTranscriptPage(growing, 8, anchor).rows[0]).toEqual(selectTranscriptPage(layout, 8, anchor).rows[0])
    const resized = cache.prepare([old], 20, 'en')
    expect(selectTranscriptPage(resized, 8, anchor).rows).not.toHaveLength(0)
    const evicted = cache.prepare([{ id: 'new', kind: 'assistant', text: 'retained\n'.repeat(10) }], 20, 'en')
    expect(selectTranscriptPage(evicted, 8, anchor).start).toBe(0)
  })
})
