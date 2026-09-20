import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, it, expect } from 'vitest'
import { terminalCellWidth } from '../../src/terminal/text-metrics.js'
import { visibleTranscriptBlocks } from '../../src/terminal/transcript.js'
import { formatRiskTags } from '../../src/review/risk.js'
import { translate } from '../../src/i18n.js'
import type { TranscriptBlock } from '../../src/plugins/api.js'

describe('terminal chrome', () => {
  it('uses markers with the same cell width as Ink, including bilingual risk labels', async () => {
    const requireInk = createRequire(import.meta.resolve('ink'))
    const { default: inkWidth } = await import(pathToFileURL(requireInk.resolve('string-width')).href)
    for (const value of ['✓', '✗', '▸', '◆', '◇', '›', '❯', '·', '•', '✻', '[', ']',
      formatRiskTags(['delete', 'outside'], 'zh-CN'), formatRiskTags(['history', 'outward'], 'en')]) {
      expect(terminalCellWidth(value), value).toBe(inkWidth(value))
    }
  })
  it('hides empty assistant headings without dropping errors, interrupted text or truncation notices', () => {
    const blocks: TranscriptBlock[] = [
      { id: 'empty', kind: 'assistant', text: '  ', state: 'success' },
      { id: 'stream', kind: 'assistant', text: '', state: 'running' },
      { id: 'done', kind: 'tool', text: 'ok', state: 'success' },
      { id: 'fail', kind: 'tool', text: 'error', state: 'error' },
      { id: 'run', kind: 'tool', text: '', state: 'running' },
      { id: 'error', kind: 'assistant', text: '', state: 'error' },
      { id: 'truncated', kind: 'assistant', text: '', textDroppedChars: 10 },
      { id: 'text', kind: 'assistant', text: 'partial output', state: 'finished' },
    ]
    expect(visibleTranscriptBlocks(blocks, true).map(b => b.id)).toEqual(['fail', 'run', 'error', 'truncated', 'text'])
    expect(visibleTranscriptBlocks(blocks, false)).toBe(blocks)
    expect(translate('zh-CN', 'steerHint')).toContain('下一步')
    expect(translate('en', 'busyHint')).toContain('queue')
  })
})
