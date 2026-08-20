import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { TESTED_DSH_BASELINE } from '../../src/upstream/compatibility.js'
import type { NormalizedEvent } from '../../src/session/projection.js'
import { MAX_RETAINED_TERMINAL_EVENTS } from '../../src/retention.js'
import { runTerminalProduct } from '../../src/terminal/product.js'
import type { HarnessRuntime } from '../../src/upstream/runtime.js'

class TestInput extends PassThrough {
  isTTY = true
  isRaw = false
  referenced = false
  setRawMode(mode: boolean): this { this.isRaw = mode; return this }
  ref(): this { this.referenced = true; return this }
  unref(): this { this.referenced = false; return this }
}

class TestOutput extends PassThrough {
  isTTY = true
  columns = 100
  rows = 32
  getColorDepth(): number { return 8 }
  hasColors(): boolean { return true }
}

function capture(stream: PassThrough): () => string {
  let value = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => { value += String(chunk) })
  return () => value
}

describe('M4 bounded terminal process history', () => {
  it('queries bounded trace history, preserves topology beyond eviction, and resets topology on /new', async () => {
    const rootSessionId = 'retention-root'
    const childSessionId = 'early-child-retained-outside-trace'
    const events = noisyActivity(rootSessionId, childSessionId)
    const runtime = inMemoryRuntime(events)
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    const readOutput = capture(output)
    const readError = capture(error)

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: false,
      initialSessionId: rootSessionId,
    })

    try {
      await waitFor(() => input.isRaw, 5_000, 'raw-mode ownership')
      await submitLine(input, 'generate a noisy observable turn')
      await waitFor(() => readOutput().includes('turns:1'), 10_000, 'noisy turn completion')

      const dropped = events.length - MAX_RETAINED_TERMINAL_EVENTS
      expect(dropped).toBe(54)

      await submitLine(input, '/trace unknown --page 2')
      await waitFor(
        () => lastView(readOutput(), 'Session Trace').includes('query: unknown · page 2/103 · 2047 retained matches'),
        5_000,
        'filtered trace page',
      )
      const unknownPage = lastView(readOutput(), 'Session Trace')
      expect(unknownPage).toContain(`scope: retained 2048/${events.length} normalized events; ${dropped} older evicted locally`)
      expect(unknownPage).toContain('scope note: filters/search cannot inspect events already evicted from local retention')
      expect(unknownPage).toContain('2061 unknown retention-root future.notification.2061/retention-noise')
      expect(unknownPage).toContain('2080 unknown retention-root future.notification.2080/retention-noise')
      // The first child event is older than the retained trace tail.
      expect(unknownPage).not.toContain('0000 agent.start')

      input.write('q')
      await delay(30)
      await submitLine(input, '/trace find future.notification.100')
      await waitFor(
        () => lastView(readOutput(), 'Session Trace').includes('query: find "future.notification.100" · page 1/1 · 1 retained matches'),
        5_000,
        'trace search',
      )
      expect(lastView(readOutput(), 'Session Trace')).toContain('0100 unknown retention-root future.notification.100/retention-noise')

      input.write('q')
      await delay(30)
      await submitLine(input, '/agents')
      // Wait for the view itself, not merely for the id to appear somewhere in
      // the stream: a command runs asynchronously, so writing the close key
      // before the view opens leaves it open and swallows the next command.
      await waitFor(
        () => lastView(readOutput(), 'Agent Topology').includes(childSessionId),
        5_000,
        'dedicated topology survives trace eviction',
      )

      input.write('q')
      await delay(30)
      await submitLine(input, '/new')
      await waitFor(() => readOutput().includes(`previous ${rootSessionId}`), 5_000, 'new session selection')

      await submitLine(input, '/agents')
      await waitFor(
        () => lastView(readOutput(), 'Agent Topology').includes('no descendant activity observed for this session'),
        5_000,
        'selected-session topology reset',
      )
      expect(lastView(readOutput(), 'Agent Topology')).not.toContain(childSessionId)

      input.write('q')
      await delay(30)
      await submitLine(input, '/exit')
      await expect(product).resolves.toMatchObject({ exitCode: 0, interrupted: false, totalTurns: 1 })
      expect(readError()).toBe('')
    } finally {
      input.end()
      await runtime.close()
    }
  }, 25_000)
})

function lastView(output: string, title: string): string {
  const index = output.lastIndexOf(title)
  return index < 0 ? '' : output.slice(index)
}

function noisyActivity(rootSessionId: string, childSessionId: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = [{
    sequence: 0,
    kind: 'subagent-started',
    parentSessionId: rootSessionId,
    childSessionId,
    provider: 'spawn',
  }]

  for (let sequence = 1; sequence <= 2_100; sequence++) {
    events.push({
      sequence,
      kind: 'unknown',
      sessionId: rootSessionId,
      method: `future.notification.${sequence}`,
      type: 'retention-noise',
    })
  }

  events.push({
    sequence: 2_101,
    kind: 'assistant-message',
    sessionId: rootSessionId,
    text: 'noisy turn complete',
  })
  return events
}

function inMemoryRuntime(events: readonly NormalizedEvent[]): HarnessRuntime {
  let closed = false
  return {
    async start() {
      if (closed) throw new Error('runtime already closed')
      return {
        workspace: '/virtual/repository',
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        serverName: 'deepseek-harness-sdk-runtime',
        protocolVersion: '0.0.1',
        sdkVersion: TESTED_DSH_BASELINE.sdkVersion,
        runtimePackageVersion: TESTED_DSH_BASELINE.runtimePackageVersion,
      }
    },
    async run(_prompt: string, options: { sessionId?: string; onEvent?: (event: NormalizedEvent) => void }) {
      for (const event of events) options.onEvent?.(event)
      return {
        sessionId: options.sessionId ?? 'retention-root',
        messageId: 'retention-message',
        finalResponse: 'noisy turn complete',
        events: [],
        eventCount: events.length,
        droppedEventCount: events.length,
        notifications: [],
        notificationCount: 0,
        droppedNotificationCount: 0,
        projection: {
          activity: 'idle',
          lastAssistantMessage: 'noisy turn complete',
          streamedAssistantText: '',
          tools: new Map(),
          subagents: new Map(),
          unknownEventCount: 2_100,
        },
      }
    },
    async close() { closed = true },
  } as unknown as HarnessRuntime
}

async function submitLine(input: TestInput, text: string): Promise<void> {
  input.write(text)
  await delay(20)
  input.write('\r')
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await delay(20)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`)
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}
