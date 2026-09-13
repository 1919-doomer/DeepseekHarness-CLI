import { describe, expect, it } from 'vitest'
import { ModelTelemetryMeter, telemetryDetails } from '../../src/session/model-telemetry.js'

describe('observed model telemetry', () => {
  it('measures the root request including waiting, ignoring child timing and UI batching', () => {
    let time = 100
    const meter = new ModelTelemetryMeter(() => time)
    meter.begin('root')
    meter.observe({ kind: 'internal', type: 'step/start', sequence: 0, sessionId: 'root' })
    meter.observe({ kind: 'request-context', sequence: 1, sessionId: 'root', provider: 'test', model: 'test-model', contextWindow: 10000 })
    time = 200
    meter.observe({ kind: 'request-context', sequence: 2, sessionId: 'child', provider: 'test', model: 'other' })
    time = 2100
    meter.observe({ kind: 'assistant-message', sequence: 3, sessionId: 'root', text: 'answer', usage: { inputTokens: 400, outputTokens: 100, cacheReadTokens: 600 } })
    expect(meter.snapshot()).toMatchObject({ requestTps: 50, requestMs: 2000, contextWindow: 10000 })
    time = 9999
    expect(meter.snapshot().requestTps).toBe(50)
    expect(telemetryDetails(meter.snapshot(), true).join('\n')).toContain('非缓存 400 / 缓存读取 600')
    meter.observe({ kind: 'internal', type: 'step/start', sequence: 4, sessionId: 'root' })
    time = 10999
    meter.observe({ kind: 'assistant-message', sequence: 5, sessionId: 'root', text: 'second request', usage: { inputTokens: 20, outputTokens: 80 } })
    expect(meter.snapshot().requestTps).toBe(80) // No second route event is required.
    meter.begin('new-session')
    expect(meter.snapshot().latestUsage).toBeUndefined()
    expect(meter.snapshot().requestTps).toBeUndefined()
  })
  it('leaves unavailable TPS unknown and resets spans at failure and compaction', () => {
    let time = 0
    const meter = new ModelTelemetryMeter(() => time)
    meter.begin('root')
    meter.observe({ kind: 'assistant-message', sequence: 1, sessionId: 'root', text: 'hello', usage: { inputTokens: 10, outputTokens: 5 } })
    expect(meter.snapshot().requestTps).toBeUndefined()
    meter.observe({ kind: 'request-context', sequence: 2, sessionId: 'root', provider: 'test', model: 'test' })
    time = 500
    meter.observe({ kind: 'context-compacted', sequence: 3, sessionId: 'root', shadowedEvents: 1, summary: 'summary' })
    expect(meter.snapshot().latestUsage).toBeUndefined()
    meter.observe({ kind: 'assistant-message', sequence: 4, sessionId: 'root', text: 'hello', usage: { inputTokens: 1, outputTokens: 5 } })
    expect(meter.snapshot().requestTps).toBeUndefined()
  })
})
