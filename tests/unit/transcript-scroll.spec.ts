import { describe, expect, it } from 'vitest'
import type { TranscriptBlock } from '../../src/plugins/api.js'
import { selectVisibleBlocks, takeVisibleBlocks } from '../../src/terminal/product.js'

function block(id: string, kind: TranscriptBlock['kind'] = 'assistant'): TranscriptBlock {
  return { id, kind, title: id, text: `body of ${id}` }
}

const blocks = Array.from({ length: 12 }, (_, index) => block(`b${index}`))

describe('selectVisibleBlocks', () => {
  it('shows the newest activity at rest', () => {
    const visible = selectVisibleBlocks(blocks, 40, 80)
    expect(visible.below).toBe(0)
    expect(visible.blocks.at(-1)?.id).toBe('b11')
  })

  it('ends the viewport earlier as the offset grows', () => {
    expect(selectVisibleBlocks(blocks, 40, 80, 3).blocks.at(-1)?.id).toBe('b8')
    expect(selectVisibleBlocks(blocks, 40, 80, 7).blocks.at(-1)?.id).toBe('b4')
  })

  it('reports what is out of sight in both directions', () => {
    const visible = selectVisibleBlocks(blocks, 12, 80, 4)
    expect(visible.below).toBe(4)
    expect(visible.above + visible.blocks.length + visible.below).toBe(blocks.length)
  })

  it('clamps an offset past the oldest block instead of emptying the view', () => {
    const visible = selectVisibleBlocks(blocks, 40, 80, 999)
    expect(visible.blocks.length).toBeGreaterThan(0)
    expect(visible.blocks.at(-1)?.id).toBe('b0')
  })

  it('always shows at least one block, even when it does not fit', () => {
    const huge = [block('small'), { ...block('huge'), text: 'x'.repeat(20_000) }]
    expect(selectVisibleBlocks(huge, 3, 40).blocks).toHaveLength(1)
  })

  it('budgets the border a framed tool block spends', () => {
    // A framed block costs two rows more than an unframed one, so fewer fit.
    const prose = Array.from({ length: 8 }, (_, index) => block(`p${index}`, 'assistant'))
    const tools = Array.from({ length: 8 }, (_, index) => block(`t${index}`, 'tool'))
    expect(selectVisibleBlocks(tools, 20, 80).blocks.length)
      .toBeLessThan(selectVisibleBlocks(prose, 20, 80).blocks.length)
  })

  it('keeps takeVisibleBlocks reporting the tail', () => {
    expect(takeVisibleBlocks(blocks, 40, 80).at(-1)?.id).toBe('b11')
  })
})
