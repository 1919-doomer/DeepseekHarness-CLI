import { readFile } from 'node:fs/promises'
import { cpus, platform, totalmem } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createDefaultTerminalHost } from '../src/plugins/builtins.js'
import { TerminalEventBatch, coalesceTranscriptDeltas } from '../src/terminal/event-batch.js'
import { initialTerminalTranscript, reduceTerminalEvent } from '../src/terminal/transcript.js'
import { initialTerminalEventHistory, appendTerminalEventBatch } from '../src/terminal/history.js'
import { replayFixture } from '../tests/fixtures/event-replay.js'

const metricPath = process.argv[2]
const metrics = metricPath ? JSON.parse(await readFile(metricPath, 'utf8')) as { peakEventsPerSecond: number } : undefined
const peak = metrics?.peakEventsPerSecond ?? 2000
if (!Number.isFinite(peak) || peak <= 0) throw new Error('Invalid measured peak')
const seconds = Number(process.env.DSHC_BENCH_SECONDS ?? 5)
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) throw new Error('DSHC_BENCH_SECONDS must be between 1 and 600')
const percentile = (values: number[], fraction: number) => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0
const fixture = replayFixture(400)
const host = createDefaultTerminalHost()
const results = []
for (const [label, rate] of [['normal', Math.min(200, peak)], ['peak', peak], ['burst-3x', peak * 3]] as const) {
  let transcript = initialTerminalTranscript(); let history = initialTerminalEventHistory()
  let count = 0; let bytes = 0; let firstReceipt: number | undefined
  const display: number[] = []; const input: number[] = []; const heap: number[] = []
  const batch = new TerminalEventBatch(events => {
    for (const event of coalesceTranscriptDeltas(events, event => host.matchingRenderer(event) !== undefined)) transcript = reduceTerminalEvent(transcript, event, host, 'replay', 'fixture-root')
    history = appendTerminalEventBatch(history, events)
    display.push(performance.now() - (firstReceipt ?? performance.now()))
    firstReceipt = undefined
  })
  let timerExpected = performance.now() + 20
  const timer = setInterval(() => { const now = performance.now(); input.push(Math.max(0, now - timerExpected)); timerExpected = now + 20; heap.push(process.memoryUsage().heapUsed) }, 20)
  const start = performance.now()
  for (let tick = 0; tick < Math.round(seconds * 50); tick++) {
    const target = Math.round((tick + 1) * rate / 50)
    while (count < target) {
      const original = fixture[count % fixture.length]!
      const event = { ...original, sequence: count }
      firstReceipt ??= performance.now(); batch.push(event); count++; bytes += Buffer.byteLength(JSON.stringify(event))
    }
    await delay(Math.max(0, start + (tick + 1) * 20 - performance.now()))
  }
  const closing = performance.now(); batch.close(); clearInterval(timer)
  results.push({ label, rate, events: count, bytes, elapsedMs: performance.now() - start,
    inputTimerDelayP95Ms: percentile(input, .95), displayProcessingDelayP95Ms: percentile(display, .95),
    maxHeapBytes: Math.max(...heap), heapEndBytes: process.memoryUsage().heapUsed, retainedEvents: history.items.length,
    heapLastQuarterMinBytes: Math.min(...heap.slice(Math.floor(heap.length * .75))),
    heapLastQuarterMaxBytes: Math.max(...heap.slice(Math.floor(heap.length * .75))),
    retainedBlocks: transcript.blocks.length, exitFlushMs: performance.now() - closing })
}
console.log(JSON.stringify({ environment: { node: process.version, platform: platform(), cpu: cpus()[0]?.model, memoryBytes: totalmem() },
  rateSource: metrics ? 'live 100ms peak normalized to events/second' : 'synthetic; pass live metrics JSON for measured peak',
  scope: 'event reduction and scheduler latency; excludes Ink/PTY/IME/display device latency', results }, null, 2))
