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
const roots: string[] = []
const ALT_SCREEN_ON = '\u001b[?1049h'
const ALT_SCREEN_OFF = '\u001b[?1049l'
const OSC_STATUS = '\u001b]52;c;c3RhdHVzLW93bmVk\u0007'
const OSC_VIEW = '\u001b]52;c;dmlldy1vd25lZA==\u0007'
const OSC_RENDERER = '\u001b]0;renderer-owned\u0007'
const OSC_ERROR = '\u001b]52;c;ZXJyb3Itb3duZWQ=\u0007'
const C1 = '\u009b31mC1-OWNED'
const BIDI = '\u202eBIDI-OWNED'

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
  rows = 30
  getColorDepth(): number { return 8 }
  hasColors(): boolean { return true }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('M4 terminal injection boundary', () => {
  it('keeps hostile plugin/event text inert while preserving dshc-owned alternate-screen controls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-terminal-security-'))
    roots.push(root)
    const logPath = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, logPath)
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    const readOutput = capture(output)
    const host = createDefaultTerminalHost()

    host.register({
      id: 'hostile-security-fixture',
      version: '1',
      apiVersion: TERMINAL_PLUGIN_API_VERSION,
      commands: [
        { name: 'evilview', summary: 'open hostile view', execute: () => ({ kind: 'view', viewId: 'evil-view' }) },
        { name: 'evilerror', summary: 'throw hostile local error', execute: () => { throw new Error(`boom${OSC_ERROR}${BIDI}`) } },
      ],
      views: [{ id: 'evil-view', title: `view-title${C1}`, render: () => `view-body${OSC_VIEW}${BIDI}` }],
      statusSegments: [{ id: 'hostile-status', priority: 999, render: () => `status${OSC_STATUS}${C1}` }],
      eventRenderers: [{
        id: 'hostile-renderer',
        priority: 999,
        match: event => event.kind === 'tool-call',
        render: (event, context) => event.kind === 'tool-call' ? [{
          kind: 'append',
          block: {
            id: `hostile-${context.activityId}-${event.callId}`,
            kind: 'tool',
            title: `renderer-title${OSC_RENDERER}`,
            text: `renderer-text${C1}`,
            detail: `renderer-detail${BIDI}`,
            state: 'running',
            sessionId: event.sessionId,
            activityId: context.activityId,
          },
        }] : [],
      }],
    })

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: true,
      initialSessionId: 'terminal-security-session',
      host,
    })

    try {
      await waitFor(() => input.isRaw, 'raw mode')
      await waitFor(() => readOutput().includes('status\\x1b]52;c;c3RhdHVzLW93bmVk\\x07'), 'sanitized hostile status')

      await submitLine(input, 'trigger hostile renderer')
      await waitFor(async () => (await promptCount(logPath)) === 1, 'prompt receipt')
      await waitFor(() => readOutput().includes('renderer-title\\x1b]0;renderer-owned\\x07'), 'sanitized hostile renderer')
      await waitFor(() => readOutput().includes('turns:1'), 'completed turn')

      await submitLine(input, '/evilview')
      await waitFor(() => readOutput().includes('view-body\\x1b]52;c;dmlldy1vd25lZA==\\x07'), 'sanitized hostile view')
      input.write('q')
      await delay(40)

      await submitLine(input, '/evilerror')
      await waitFor(() => readOutput().includes('boom\\x1b]52;c;ZXJyb3Itb3duZWQ=\\x07'), 'sanitized hostile command error')

      await submitLine(input, '/exit')
      await expect(product).resolves.toMatchObject({ exitCode: 0, interrupted: false, totalTurns: 1 })

      const raw = readOutput()
      expect(raw).toContain(ALT_SCREEN_ON)
      expect(raw).toContain(ALT_SCREEN_OFF)
      for (const attackerSequence of [OSC_STATUS, OSC_VIEW, OSC_RENDERER, OSC_ERROR, C1, BIDI]) {
        expect(raw).not.toContain(attackerSequence)
      }
      expect(input.isRaw).toBe(false)
      expect(input.referenced).toBe(false)
    } finally {
      input.end()
      await runtime.close()
    }
  }, 20_000)
})

function runtimeFor(root: string, logPath: string): HarnessRuntime {
  const env = { ...process.env, DSHC_FAKE_MODE: 'success', DSHC_FAKE_LOG: logPath }
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

async function submitLine(input: TestInput, text: string): Promise<void> {
  input.write(text)
  await delay(30)
  input.write('\r')
}

async function promptCount(path: string): Promise<number> {
  try {
    const text = await readFile(path, 'utf8')
    return text.trim().length === 0 ? 0 : text.trim().split('\n').length
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
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
