import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'
import { checkerPng } from '../fixtures/png.js'

// Explicitly opt in: this suite spends provider tokens, never prints credentials
// or model/tool payloads, and operates only on disposable fixtures.
describe.skipIf(process.env.DSHC_LIVE_V41 !== '1')('live V4.1 compatibility', () => {
  it('reads text and an image, observes a failed tool, and accounts for a long response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-v41-'))
    await writeFile(join(root, 'marker.txt'), 'V41-FIXTURE-2718\n')
    await writeFile(join(root, 'pixel.png'), checkerPng())
    const runtime = new HarnessRuntime({
      workspace: root, model: 'deepseek-flash', maxTokens: 8192,
      activityTimeoutMs: 180_000,
      env: { ...process.env, DSHC_VISION_MODEL: 'deepseek-flash',
        DSH_HOME: join(root, 'home'), DSH_SESSION_ROOT: join(root, 'sessions') },
    })
    const started = performance.now()
    let firstEvent: number | undefined
    let bytes = 0
    const calls = new Set<string>()
    const callNames = new Map<string, string>()
    let failures = 0
    let imageResults = 0
    try {
      const result = await runtime.run(
        'Compatibility test in this disposable directory. Use read on marker.txt, then use read on absent.txt exactly once (failure is expected). Use vision to inspect pixel.png, a colored quadrant fixture; ask the vision agent to actually call read_image. Do not write files or run shell. Finally report the marker, the expected missing-file error, what the image tool observed, and 40 numbered short lines describing generic terminal testing. Do not delegate other tasks.',
        { onEvent: event => {
          firstEvent ??= performance.now(); bytes += Buffer.byteLength(JSON.stringify(event))
          if (event.kind === 'tool-call') { calls.add(event.name); callNames.set(event.callId, event.name) }
          if (event.kind === 'tool-result' && event.isError) failures++
          if (event.kind === 'tool-result' && callNames.get(event.callId) === 'read_image') {
            if (!event.isError) imageResults++
            else console.log(JSON.stringify({ imageFixtureError: event.text.slice(0, 400) }))
          }
        } },
      )
      expect(result.projection.lastTurnError).toBeUndefined()
      expect(result.finalResponse).toContain('V41-FIXTURE-2718')
      expect(result.finalResponse.length).toBeGreaterThan(600)
      console.log(JSON.stringify({ calls: [...calls], failures, imageResults }))
      expect(failures).toBeGreaterThan(0)
      expect(calls.has('read_image')).toBe(true)
      expect(imageResults).toBeGreaterThan(0)
      expect(result.events.some(e => e.kind === 'assistant-message' && (e.usage?.outputTokens ?? 0) > 0)).toBe(true)
      console.log(JSON.stringify({ model: 'deepseek-flash', runtime: runtime.metadata,
        elapsedMs: performance.now() - started, firstEventMs: (firstEvent ?? started) - started,
        events: result.eventCount, bytes, metrics: result.metrics,
        usage: result.events.flatMap(e => e.kind === 'assistant-message' && e.usage ? [e.usage] : []) }))
      if (process.env.DSHC_LIVE_METRICS_PATH) await writeFile(process.env.DSHC_LIVE_METRICS_PATH, JSON.stringify(result.metrics, null, 2))
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
  }, 210_000)
})
