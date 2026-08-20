import { describe, expect, it } from 'vitest'
import { InteractiveSessionState } from '../../src/session/interactive-state.js'

describe('InteractiveSessionState', () => {
  it('keeps one session stable across completed turns', () => {
    const state = new InteractiveSessionState('session-fixed')
    state.recordCompletedTurn()
    state.recordCompletedTurn()
    expect(state.snapshot()).toEqual({
      sessionId: 'session-fixed',
      turnCount: 2,
      sessionGeneration: 1,
    })
  })

  it('creates a fresh session without reusing the old id', () => {
    const state = new InteractiveSessionState('session-old')
    state.recordCompletedTurn()
    const next = state.newSession()
    expect(next).not.toBe('session-old')
    expect(state.snapshot()).toEqual({
      sessionId: next,
      turnCount: 0,
      sessionGeneration: 2,
    })
  })
})
