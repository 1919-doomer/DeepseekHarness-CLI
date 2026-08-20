import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runTerminalProduct } from '../../src/terminal/product.js'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

const fakeRuntimePath = fileURLToPath(new URL('../fixtures/fake-runtime.mjs', import.meta.url))
const tempRoots: string[] = []
const ALT_SCREEN_ON = '\u001B[?1049h'
const ALT_SCREEN_OFF = '\u001B[?1049l'

class TestInput extends PassThrough {
  isTTY = true
  isRaw = false
  referenced = false

  setRawMode(mode: boolean): this {
    this.isRaw = mode
    return this
  }

  ref(): this {
    this.referenced = true
    return this
  }

  unref(): this {
    this.referenced = false
    return this
  }
}

class TestOutput extends PassThrough {
  isTTY = true
  columns = 96
  rows = 28

  getColorDepth(): number {
    return 8
  }

  hasColors(): boolean {
    return true
  }
}

function runtimeFor(root: string, logPath: string): HarnessRuntime {
  const env = {
    ...process.env,
    DSHC_FAKE_MODE: 'success',
    DSHC_FAKE_LOG: logPath,
  }
  return new HarnessRuntime({
    workspace: root,
    env,
    skipInstalledVersionCheck: true,
    activityTimeoutMs: 1_000,
    launchOverride: {
      command: process.execPath,
      args: [fakeRuntimePath],
      cwd: root,
      env,
      requestTimeoutMs: 500,
      shutdownTimeoutMs: 100,
      disposeEofGraceMs: 250,
      disposeGraceMs: 250,
    },
  })
}

function capture(stream: PassThrough): () => string {
  let value = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => { value += String(chunk) })
  return () => value
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('M3 Ink terminal product with injected TTY streams', () => {
  it('drives two same-session turns, capability view, resize and clean exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m3-product-'))
    tempRoots.push(root)
    const logPath = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, logPath)
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
      useAlternateScreen: true,
      initialSessionId: 'm3-product-session',
    })

    try {
      await waitFor(() => readOutput().includes('DeepSeek Harness Console'))
      await waitFor(() => input.isRaw)
      expect(input.referenced).toBe(true)
      expect(readOutput()).toContain(ALT_SCREEN_ON)

      await submitLine(input, 'first product turn')
      await waitFor(async () => (await promptRecords(logPath)).length === 1)
      await waitFor(() => readOutput().includes('hello'))

      await submitLine(input, 'second product turn')
      await waitFor(async () => (await promptRecords(logPath)).length === 2)
      await waitFor(() => readOutput().includes('turns:2'))

      const records = await promptRecords(logPath)
      expect(records).toHaveLength(2)
      expect(records.map(record => record.sessionId)).toEqual(['m3-product-session', 'm3-product-session'])

      await submitLine(input, '/plugins')
      await waitFor(() => readOutput().includes('Capability Explorer'))
      expect(readOutput()).toContain('partial/unavailable on SDK protocol 0.0.1')
      expect(readOutput()).toContain('prompt cancel: unavailable')
      expect(readOutput()).toContain('dshc.core@1.0.0')

      input.write('q')
      await delay(50)
      output.columns = 40
      output.rows = 12
      output.emit('resize')
      await delay(50)

      await submitLine(input, '/exit')
      const result = await product
      expect(result).toEqual({
        exitCode: 0,
        interrupted: false,
        totalTurns: 2,
        sessionId: 'm3-product-session',
      })
      await waitFor(() => !input.isRaw)
      expect(input.referenced).toBe(false)
      expect(readOutput()).toContain(ALT_SCREEN_OFF)
      expect(readOutput()).not.toContain('private-reasoning-must-not-render')
      expect(readError()).toBe('')
    } finally {
      input.end()
      await runtime.close()
    }
  }, 15_000)
})

async function submitLine(input: TestInput, text: string): Promise<void> {
  input.write(text)
  await delay(30)
  input.write('\r')
}

async function promptRecords(logPath: string): Promise<Array<{ sessionId: string }>> {
  try {
    const text = await readFile(logPath, 'utf8')
    return text.trim().length === 0
      ? []
      : text.trim().split('\n').map(line => JSON.parse(line) as { sessionId: string })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await delay(20)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for terminal product state.`)
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}
