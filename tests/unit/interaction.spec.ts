import { describe, expect, it } from 'vitest'
import { InteractionBridge, validateInteraction } from '../../src/upstream/interaction.js'
import { SessionClock } from '../../src/session/session-clock.js'
describe('interaction ownership', () => {
  it('rejects foreign sessions and replayed answers and cancels pending requests on close', async () => {
    const bridge = new InteractionBridge(), env = await bridge.start()
    const content = { kind: 'questions', questions: [{ id: 'q', title: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] }
    const send = (sessionId: string, callId: string) => fetch(`${env.DSHC_INTERACTION_URL}/request`, { method: 'POST', headers: { authorization: `Bearer ${env.DSHC_INTERACTION_TOKEN}` }, body: JSON.stringify({ runtimeId: bridge.id, sessionId, callId, content }) })
    try {
      bridge.begin('root')
      bridge.expectCall('root', 'c1', 'request_user_input')
      expect((await send('child', 'foreign')).status).toBe(409)
      const received = new Promise<void>(resolve => { const off = bridge.subscribe(() => { if (bridge.current) { off(); resolve() } }) })
      const response = send('root', 'c1')
      await received
      const id = bridge.current!.id
      expect(() => bridge.answer(id, { action: 'submit', answers: [{ id: 'q', option: 99, text: '' }] })).toThrow()
      expect(bridge.answer(id, { action: 'submit', answers: [{ id: 'q', option: 1, text: '补充' }] })).toBe(true)
      expect((await response).status).toBe(200)
      expect(bridge.answer(id, { action: 'skip' })).toBe(false)
      expect((await send('root', 'c1')).status).toBe(409)
      bridge.end('root')
      expect((await send('root', 'c2')).status).toBe(409)
    } finally { await bridge.close() }
  })
  it('bounds and validates question content', () => {
    expect(() => validateInteraction({ kind: 'questions', questions: [] })).toThrow()
    expect(() => validateInteraction({ kind: 'plan', title: 'x', text: 'a'.repeat(64_001) })).toThrow()
  })
  it('correlates the independent channels and rejects a late answer after cancellation', async () => {
    const bridge = new InteractionBridge(), env = await bridge.start()
    bridge.begin('root')
    const ready = new Promise<void>(resolve => { const off = bridge.subscribe(() => { if (bridge.current) { off(); resolve() } }) })
    const pending = fetch(`${env.DSHC_INTERACTION_URL}/request`, { method: 'POST', headers: { authorization: `Bearer ${env.DSHC_INTERACTION_TOKEN}` },
      body: JSON.stringify({ runtimeId: bridge.id, sessionId: 'root', callId: 'call', content: { kind: 'plan', title: 'p', text: 'Read only' } }) }).then(() => 'response', () => 'cancelled')
    try {
      bridge.expectCall('root', 'call', 'present_plan')
      await ready
      const id = bridge.current!.id
      bridge.end('root')
      expect(bridge.answer(id, { action: 'implement' })).toBe(false)
      expect(await pending).toBe('cancelled')
    } finally { await bridge.close() }
  })
})
describe('session time and compaction', () => {
  it('separates wall, running and human wait time and resets for a new session', () => {
    let now = 0; const clock = new SessionClock(() => now); clock.reset('a')
    now = 100; clock.start(); now = 300; clock.wait(true); now = 900; clock.wait(false); now = 1000; clock.stop(); now = 1500
    expect(clock.snapshot()).toEqual({ elapsedMs: 1500, runningMs: 300, waitingMs: 600, turnMs: 900 })
    clock.observe({ sequence: 1, kind: 'internal', sessionId: 'a', type: 'compaction/start' }); now = 1700
    clock.observe({ sequence: 2, kind: 'internal', sessionId: 'a', type: 'compaction/end' })
    expect(clock.compaction.state).toBe('failed')
    clock.reset('b'); expect(clock.snapshot().elapsedMs).toBe(0); expect(clock.compaction.count).toBe(0)
  })
})
