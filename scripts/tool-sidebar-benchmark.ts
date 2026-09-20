import assert from 'node:assert/strict'
import { cpus } from 'node:os'
import { projectToolActivity, ToolActivityCache } from '../src/terminal/tool-activity.js'
import type { NormalizedEvent } from '../src/session/projection.js'
import { MAX_RETAINED_TERMINAL_EVENTS } from '../src/retention.js'

// Isolate repeated sidebar projection during text/reasoning output. This is not
// a whole-terminal FPS benchmark; unchanged call data is the measured case.
const events: NormalizedEvent[] = []
for (let index = 0; index < 100; index++) {
  events.push({ kind: 'tool-call', sessionId: 'root', callId: String(index), name: 'pwsh',
    arguments: JSON.stringify({ command: 'git status --short', description: 'Inspect repository status' }), upstreamTime: index * 10 })
  events.push({ kind: 'tool-result', sessionId: 'root', callId: String(index), text: 'clean', isError: false, upstreamTime: index * 10 + 5 })
}
while (events.length < MAX_RETAINED_TERMINAL_EVENTS) events.push({ kind: 'assistant-delta', sessionId: 'root', text: 'delta' })
const risk = { workspace: 'E:\\work' }, cache = new ToolActivityCache(), iterations = 300
assert.deepEqual(cache.prepare(events, 'root', risk), projectToolActivity(events, 'root', risk))
for (let index = 0; index < 10; index++) { projectToolActivity(events, 'root', risk); cache.prepare(events, 'root', risk) }
const measure = (project: () => unknown) => {
  const start = performance.now()
  for (let index = 0; index < iterations; index++) project()
  return performance.now() - start
}
const uncachedMs = measure(() => projectToolActivity(events, 'root', risk))
const cachedMs = measure(() => cache.prepare(events, 'root', risk))
console.log(JSON.stringify({ node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
  retainedEvents: events.length, toolCalls: 100, iterations, uncachedMs, cachedMs,
  speedup: uncachedMs / cachedMs, scope: 'unchanged tool activity amid text/reasoning; excludes Ink and PTY' }, null, 2))
