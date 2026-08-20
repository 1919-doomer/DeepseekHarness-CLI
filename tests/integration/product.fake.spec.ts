import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { TERMINAL_PLUGIN_API_VERSION } from '../../src/plugins/api.js'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
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
  setRawMode(mode: boolean): this { this.isRaw = mode; return this }
  ref(): this { this.referenced = true; return this }
  unref(): this { this.referenced = false; return this }
}

class TestOutput extends PassThrough {
  isTTY = true
  columns = 96
  rows = 28
  getColorDepth(): number { return 8 }
  hasColors(): boolean { return true }
}

interface PromptRecord {
  sessionId: string
  contentBlocks: Array<{ type: string; text?: string }>
}

function runtimeFor(root: string, logPath: string, mode = 'success'): HarnessRuntime {
  const env = { ...process.env, DSHC_FAKE_MODE: mode, DSHC_FAKE_LOG: logPath }
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
  it('drives same-session turns, session-scoped descendants, capability view, resize and clean exit', async () => {
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
      expect(readOutput()).toContain('working')
      expect(readOutput()).toContain('child')
      expect(readOutput()).toContain('child-read')
      expect(readOutput()).toContain('child result')
      expect(readOutput()).toContain('README content')

      await submitLine(input, 'second product turn')
      await waitFor(async () => (await promptRecords(logPath)).length === 2)
      await waitFor(() => readOutput().includes('turns:2'))
      const records = await promptRecords(logPath)
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
      expect(result).toEqual({ exitCode: 0, interrupted: false, totalTurns: 2, sessionId: 'm3-product-session' })
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

  it('preserves Unicode graphemes through editing, navigation, deletion and submission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m3-unicode-editor-'))
    tempRoots.push(root)
    const logPath = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, logPath)
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    const readOutput = capture(output)

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: false,
      initialSessionId: 'm3-unicode-session',
    })

    try {
      await waitFor(() => input.isRaw)

      // Astral emoji backspace must remove the whole grapheme, not one surrogate.
      input.write('😀')
      await delay(20)
      input.write('\u007f')
      await delay(20)
      await submitLine(input, 'after-delete')
      await waitFor(async () => (await promptRecords(logPath)).length === 1)
      expect(promptText((await promptRecords(logPath))[0]!)).toBe('after-delete')

      // Walk left across B and emoji, right across the emoji, then insert.
      input.write('A😀B')
      await delay(20)
      input.write('\u001B[D\u001B[D\u001B[C')
      await delay(20)
      await submitLine(input, 'X')
      await waitFor(async () => (await promptRecords(logPath)).length === 2)
      expect(promptText((await promptRecords(logPath))[1]!)).toBe('A😀XB')

      // A multi-code-point ZWJ family must delete as one editing unit.
      input.write('👨‍👩‍👧‍👦')
      await delay(20)
      input.write('\u007f')
      await delay(20)
      await submitLine(input, 'family-deleted')
      await waitFor(async () => (await promptRecords(logPath)).length === 3)
      expect(promptText((await promptRecords(logPath))[2]!)).toBe('family-deleted')

      // Combining grapheme is also one backspace unit.
      input.write('e\u0301')
      await delay(20)
      input.write('\u007f')
      await delay(20)
      await submitLine(input, 'combining-deleted')
      await waitFor(async () => (await promptRecords(logPath)).length === 4)
      expect(promptText((await promptRecords(logPath))[3]!)).toBe('combining-deleted')

      const mixed = '中文abc😀👍🏽'
      await submitLine(input, mixed)
      await waitFor(async () => (await promptRecords(logPath)).length === 5)
      expect(promptText((await promptRecords(logPath))[4]!)).toBe(mixed)
      expect((await promptRecords(logPath)).every(record => !hasLoneSurrogate(promptText(record)))).toBe(true)

      await waitFor(() => readOutput().includes('hello'))
      await submitLine(input, '/exit')
      await expect(product).resolves.toMatchObject({ exitCode: 0, interrupted: false, totalTurns: 5 })
    } finally {
      input.end()
      await runtime.close()
    }
  }, 20_000)

  it('crops a wide Unicode status segment in a narrow terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m3-wide-status-'))
    tempRoots.push(root)
    const runtime = runtimeFor(root, join(root, 'prompts.jsonl'))
    const input = new TestInput()
    const output = new TestOutput()
    output.columns = 24
    output.rows = 12
    const error = new TestOutput()
    const readOutput = capture(output)
    const host = createDefaultTerminalHost()
    const wideStatus = `${'中文'.repeat(10)}${'😀'.repeat(8)}`
    host.register({
      id: 'wide-status-test',
      version: '1',
      apiVersion: TERMINAL_PLUGIN_API_VERSION,
      statusSegments: [{ id: 'wide', priority: 999, render: () => wideStatus }],
    })

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: false,
      initialSessionId: 'm3-wide-status-session',
      host,
    })

    try {
      await waitFor(() => input.isRaw)
      await waitFor(() => readOutput().includes('…'))
      expect(readOutput()).not.toContain(wideStatus)
      await submitLine(input, '/exit')
      await expect(product).resolves.toMatchObject({ exitCode: 0, interrupted: false })
    } finally {
      input.end()
      await runtime.close()
    }
  }, 15_000)

  it('contains command, view and status callback failures inside presentation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m3-plugin-fault-'))
    tempRoots.push(root)
    const runtime = runtimeFor(root, join(root, 'prompts.jsonl'))
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    const readOutput = capture(output)
    const host = createDefaultTerminalHost()
    host.register({
      id: 'fault-test',
      version: '1',
      apiVersion: TERMINAL_PLUGIN_API_VERSION,
      commands: [
        { name: 'boom', summary: 'throw', execute: async () => { throw new Error('command exploded') } },
        { name: 'badview', summary: 'bad view', execute: () => ({ kind: 'view', viewId: 'exploding-view' }) },
      ],
      views: [{ id: 'exploding-view', title: 'Exploding View', render: () => { throw new Error('view exploded') } }],
      statusSegments: [{ id: 'exploding-status', priority: 200, render: () => { throw new Error('status exploded') } }],
    })

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: true,
      initialSessionId: 'm3-plugin-fault-session',
      host,
    })

    try {
      await waitFor(() => readOutput().includes('status:exploding-status:error'))
      await submitLine(input, '/boom')
      await waitFor(() => readOutput().includes('command exploded'))
      await submitLine(input, '/badview')
      await waitFor(() => readOutput().includes('view exploded'))
      input.write('q')
      await delay(30)
      await submitLine(input, '/exit')
      await expect(product).resolves.toMatchObject({ exitCode: 0, interrupted: false })
    } finally {
      input.end()
      await runtime.close()
    }
  }, 15_000)

  it('Ctrl+C during an active turn closes the whole runtime and restores terminal state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m3-product-signal-'))
    tempRoots.push(root)
    const logPath = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, logPath, 'hang-activity')
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    const readOutput = capture(output)

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: true,
      initialSessionId: 'm3-product-signal',
    })

    try {
      await waitFor(() => input.isRaw)
      await submitLine(input, 'wait for ctrl-c')
      await waitFor(async () => (await promptRecords(logPath)).length === 1)
      await waitFor(() => readOutput().includes('Harness is running'))
      input.write('\u0003')
      const result = await product
      expect(result).toEqual({ exitCode: 130, interrupted: true, totalTurns: 0, sessionId: 'm3-product-signal' })
      await waitFor(() => !input.isRaw)
      expect(input.referenced).toBe(false)
      expect(readOutput()).toContain('no prompt-level cancel')
      expect(readOutput()).not.toContain('cancelled')
      expect(readOutput()).toContain(ALT_SCREEN_OFF)
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

async function promptRecords(logPath: string): Promise<PromptRecord[]> {
  try {
    const text = await readFile(logPath, 'utf8')
    return text.trim().length === 0 ? [] : text.trim().split('\n').map(line => JSON.parse(line) as PromptRecord)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function promptText(record: PromptRecord): string {
  return record.contentBlocks
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('')
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index++
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
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
