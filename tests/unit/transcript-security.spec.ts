import { describe, expect, it } from 'vitest'
import type { TranscriptBlock } from '../../src/plugins/api.js'
import { applyMutations, initialTerminalTranscript } from '../../src/terminal/transcript.js'

const OSC52 = '\u001b]52;c;ZGFuZ2Vy\u0007'
const CSI = '\u009b31m'
const BIDI = '\u202e'

describe('transcript storage security boundary', () => {
  it('sanitizes plugin append blocks before storing them', () => {
    const block: TranscriptBlock = {
      id: 'hostile',
      kind: 'tool',
      title: `title${OSC52}`,
      text: `text${CSI}`,
      detail: `detail${BIDI}`,
    }
    const state = applyMutations(initialTerminalTranscript(), [{ kind: 'append', block }])
    const stored = state.blocks[0]!

    expect(stored.title).toBe('title\\x1b]52;c;ZGFuZ2Vy\\x07')
    expect(stored.text).toBe('text\\u009b31m')
    expect(stored.detail).toBe('detail\\u202e')
    expect(JSON.stringify(stored)).not.toContain(OSC52)
    expect(JSON.stringify(stored)).not.toContain(CSI)
    expect(JSON.stringify(stored)).not.toContain(BIDI)
  })

  it('sanitizes fallback and patch content from renderers that forgot to do so', () => {
    let state = applyMutations(initialTerminalTranscript(), [{
      kind: 'append-text',
      id: 'stream',
      text: `delta${OSC52}`,
      fallback: {
        id: 'stream',
        kind: 'assistant',
        title: `assistant${CSI}`,
        text: '',
        detail: `fallback${BIDI}`,
      },
    }])

    expect(state.blocks[0]).toMatchObject({
      title: 'assistant\\u009b31m',
      text: 'delta\\x1b]52;c;ZGFuZ2Vy\\x07',
      detail: 'fallback\\u202e',
    })

    state = applyMutations(state, [{
      kind: 'patch',
      id: 'stream',
      patch: {
        title: `patched${OSC52}`,
        text: `body${CSI}`,
        detail: `detail${BIDI}`,
      },
    }])

    expect(state.blocks[0]).toMatchObject({
      title: 'patched\\x1b]52;c;ZGFuZ2Vy\\x07',
      text: 'body\\u009b31m',
      detail: 'detail\\u202e',
    })
  })
})
