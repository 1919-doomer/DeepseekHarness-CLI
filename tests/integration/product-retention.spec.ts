import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
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
  it('bounds trace retention, preserves topology beyond trace eviction, and resets topology on /new', async () => {
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
      expect(dropped).toBeGreaterThan(0)

      await submitLine(input, '/trace')
      await waitFor(
        () => readOutput().includes(`retention: ${dropped} older normalized events evicted locally; total observed ${events.length}`),
        5_000,
        'trace eviction disclosure',
      )
      // The first child event is older than the retained trace tail.
      expect(readOutput()).not.toContain('0000 agent.start')

      input.write('q')
      await delay(30)
      const beforeAgents = readOutput().length
      await submitLine(input, '/agents')
      await waitFor(
        () => readOutput().slice(beforeAgents).includes(childSessionId),
        5_000,
        'dedicated topology survives trace eviction',
      )

      input.write('q')
      await delay(30)
      await submitLine(input, '/new')
      await waitFor(() => readOutput().includes(`previous ${rootSessionId}`), 5_000, 'new session selection')

      const beforeResetAgents = readOutput().length
      await submitLine(input, '/agents')
      await waitFor(
        () => readOutput().slice(beforeResetAgents).includes('no descendant activity observed for this session'),
        5_000,
        'selected-session topology reset',
      )
      expect(readOutput().slice(beforeResetAgents)).not.toContain(childSessionId)

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
        sdkVersion: '0.1.0-rc.8',
        runtimePackageVersion: '0.1.0-rc.8',
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
