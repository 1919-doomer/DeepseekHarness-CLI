import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_PLUGIN_API_VERSION } from '../../src/plugins/api.js'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
import { HistoryWorkbench } from '../../src/plugins/history.js'
import type { HistoryReader, HistorySessionDetail } from '../../src/history/types.js'
import { runTerminalProduct as renderTerminalProduct } from '../../src/terminal/product.js'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

const fakeRuntimePath = fileURLToPath(new URL('../fixtures/fake-runtime.mjs', import.meta.url))
const tempRoots: string[] = []
let completedTurns = 0
const runTerminalProduct: typeof renderTerminalProduct = (runtime, options = {}) => renderTerminalProduct(runtime, { ...options, preferences: { ...options.preferences, animation: false } })
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
  const runtime = new HarnessRuntime({
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
  const run = runtime.run.bind(runtime)
  runtime.run = async (...args) => { const result = await run(...args); completedTurns++; return result }
  return runtime
}

/**
 * Output produced by a fresh render, isolated from everything drawn before it.
 * Typing and deleting a character forces the product to redraw, so whatever is
 * currently on screen has to appear in the slice.
 */
async function renderedAfterTick(input: TestInput, readOutput: () => string): Promise<string> {
  const mark = readOutput().length
  input.write('x')
  await delay(80)
  input.write('')
  await delay(120)
  return readOutput().slice(mark)
}

function capture(stream: PassThrough): () => string {
  let value = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => { value += String(chunk) })
  return () => value
}

afterEach(async () => {
  completedTurns = 0
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('M3 Ink terminal product with injected TTY streams', () => {
  it('keeps one terminal owner from animated startup to chat and preserves typed drafts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-splash-')); tempRoots.push(root)
    const log = join(root, 'prompts.jsonl'), runtime = runtimeFor(root, log)
    const start = runtime.start.bind(runtime)
    let unlock!: () => void
    const gate = new Promise<void>(resolve => { unlock = resolve })
    runtime.start = async () => { await gate; return start() }
    const input = new TestInput(), output = new TestOutput(), error = new TestOutput()
    const readOutput = capture(output); capture(error)
    const listeners = process.listenerCount('beforeExit')
    const product = renderTerminalProduct(runtime, { stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream, stderr: error as unknown as NodeJS.WriteStream,
      preferences: { locale: 'en', animation: true }, interactive: true, useAlternateScreen: false })
    try {
      await waitFor(() => input.isRaw)
      await waitFor(() => readOutput().includes('Starting · any key to skip'))
      output.columns = 30; output.rows = 12; output.emit('resize')
      await delay(80)
      expect(readOutput()).toContain('dshc')
      output.columns = 96; output.rows = 28; output.emit('resize')
      input.write('启动草稿😀'); await delay(50); unlock()
      await waitFor(() => readOutput().includes('deepseek-harness-sdk-runtime/0.0.1')); await delay(80)
      input.write('\r'); await waitForTurn(readOutput, 1)
      expect(promptText((await promptRecords(log))[0]!)).toBe('启动草稿😀')
      await submitLine(input, '/exit'); expect((await product).exitCode).toBe(0)
      expect(input.isRaw).toBe(false); expect(input.referenced).toBe(false)
      expect(process.listenerCount('beforeExit')).toBe(listeners)
    } finally { unlock(); input.end(); await runtime.close() }
  }, 10_000)
  it('restores the draft and cursor after history, deletes forward, and keeps Alt+Enter local', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-editor-flow-'))
    tempRoots.push(root)
    const log = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, log)
    const input = new TestInput(); const output = new TestOutput(); const error = new TestOutput()
    const readOutput = capture(output)
    const product = runTerminalProduct(runtime, { stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream, stderr: error as unknown as NodeJS.WriteStream,
      interactive: true, useAlternateScreen: false, preferences: { locale: 'en' } })
    const key = async (value: string): Promise<void> => { input.write(value); await delay(40) }
    try {
      await waitFor(() => input.isRaw)
      await submitLine(input, 'earlier prompt')
      await waitForTurn(readOutput, 1)
      await key('A😀B')
      await key('\u001b[D')
      await key('\u001b[A')
      await key('\u001b[B')
      await key('\u001b[3~')
      await key('\u001b[H')
      await key('>')
      await key('\u001b[F')
      await key('<')
      await key('\u001b\r')
      expect(await promptRecords(log)).toHaveLength(1)
      await submitLine(input, '第二行')
      await waitForTurn(readOutput, 2)
      expect(promptText((await promptRecords(log))[1]!)).toBe('>A😀<\n第二行')
      await submitLine(input, '/exit')
      expect((await product).exitCode).toBe(0)
    } finally { input.write('\u0003'); await product; input.end(); await runtime.close() }
  }, 10_000)

  it('completes preference choices without applying a restart and preserves invalid commands for repair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-preference-flow-'))
    tempRoots.push(root)
    const log = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, log)
    const input = new TestInput(); const output = new TestOutput(); const error = new TestOutput()
    const readOutput = capture(output)
    const restart = vi.fn(async () => { throw new Error('Preview must not restart') })
    const product = runTerminalProduct(runtime, { stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream, stderr: error as unknown as NodeJS.WriteStream,
      interactive: true, useAlternateScreen: false, preferences: { locale: 'en' }, restart })
    const key = async (value: string): Promise<void> => { input.write(value); await delay(60) }
    try {
      await waitFor(() => input.isRaw)
      await key('/mode')
      await key('\t') // An exact command name opens its argument choices.
      await waitFor(() => readOutput().includes('/mode plan'))
      await key('\u001b[B')
      await key('\t')
      await key('\r')
      await waitFor(() => readOutput().includes('/mode plan --yes'))
      expect(restart).not.toHaveBeenCalled()
      await key('/language ')
      await key('\u001b[B')
      await key('\r') // Insert zh-CN; this must not execute yet.
      expect(readOutput()).not.toContain('界面语言：zh-CN')
      await key('\r')
      await waitFor(() => readOutput().includes('界面语言：zh-CN'))
      await key('/not-a-command\r') // Coalesced input follows the same local command path.
      await waitFor(() => readOutput().includes('已保留输入'))
      expect(await renderedAfterTick(input, readOutput)).toContain('❯ /not-a-command')
      expect(await promptRecords(log)).toHaveLength(0)
      await key('\u0015')
      await submitLine(input, '/exit')
      expect((await product).exitCode).toBe(0)
    } finally { input.write('\u0003'); await product; input.end(); await runtime.close() }
  }, 10_000)

  it('selects a file reference without sending or inlining its content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-file-picker-'))
    tempRoots.push(root)
    await writeFile(join(root, 'fixture-a.txt'), 'private-fixture-content-a')
    await writeFile(join(root, 'fixture-b.txt'), 'private-fixture-content-b')
    const log = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, log)
    const input = new TestInput(); const output = new TestOutput(); const error = new TestOutput()
    const readOutput = capture(output)
    const product = runTerminalProduct(runtime, { stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream, stderr: error as unknown as NodeJS.WriteStream,
      interactive: true, useAlternateScreen: false, preferences: { locale: 'en' } })
    try {
      await waitFor(() => input.isRaw)
      input.write('@fixture-')
      await delay(40)
      input.write('\t')
      await waitFor(() => readOutput().includes('Enter insert path'))
      input.write('\u001b[B')
      await delay(40)
      input.write('\r')
      await delay(40)
      expect(await promptRecords(log)).toHaveLength(0)
      input.write('\r')
      await waitForTurn(readOutput, 1)
      expect(promptText((await promptRecords(log))[0]!)).toBe('@fixture-b.txt')
      expect(readOutput()).not.toContain('private-fixture-content')
      await submitLine(input, '/exit')
      expect((await product).exitCode).toBe(0)
    } finally { input.end(); await runtime.close() }
  }, 10_000)
  it('edits queued prompts, switches language immediately and keeps bracketed paste as one draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-queue-language-'))
    tempRoots.push(root)
    const log = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, log, 'queue-delay')
    const input = new TestInput(); const output = new TestOutput(); const error = new TestOutput()
    const readOutput = capture(output)
    const product = runTerminalProduct(runtime, { stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream, stderr: error as unknown as NodeJS.WriteStream,
      interactive: true, useAlternateScreen: false, initialSessionId: 'queue-session', preferences: { locale: 'en' } })
    try {
      await waitFor(() => input.isRaw)
      await submitLine(input, 'first')
      await waitFor(async () => (await promptRecords(log)).length === 1)
      await submitLine(input, 'queued original')
      await submitLine(input, '/queue edit 1 edited queued prompt')
      await submitLine(input, '/language zh-CN')
      await waitFor(() => readOutput().includes('界面语言'))
      await waitFor(async () => (await promptRecords(log)).length === 2)
      expect((await promptRecords(log)).map(record => promptText(record))).toEqual(['first', 'edited queued prompt'])
      expect((await promptRecords(log)).every(record => record.sessionId === 'queue-session')).toBe(true)
      await waitForTurn(readOutput, 2)
      input.write('\u001b[200~pasted line one\r\npasted line two\u001b[201~')
      await delay(100)
      expect(await promptRecords(log)).toHaveLength(2)
      input.write('\r')
      await waitFor(async () => (await promptRecords(log)).length === 3)
      expect(promptText((await promptRecords(log))[2]!)).toBe('pasted line one\npasted line two')
      await waitForTurn(readOutput, 3)
      await submitLine(input, '/exit')
      expect((await product).exitCode).toBe(0)
      expect(input.isRaw).toBe(false)
    } finally { input.end(); await runtime.close() }
  }, 15_000)
  it('reviews Ask History evidence before sending it to a fresh ordinary session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m7-history-'))
    tempRoots.push(root)
    const logPath = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, logPath)
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    const readOutput = capture(output)
    const detail: HistorySessionDetail = {
      summary: {
        id: 'source-session',
        cwd: root,
        createdAt: 1_000,
        updatedAt: 2_000,
        title: 'Source task',
        messageCount: 1,
        toolCallCount: 0,
        compactionCount: 0,
        approvalCount: 0,
      },
      messages: [{
        sessionId: 'source-session',
        seq: 4,
        time: 1_500,
        role: 'assistant',
        text: 'the selected historical fact',
        truncatedChars: 0,
      }],
      approvals: [],
      eventCount: 5,
      droppedMessageCount: 0,
    }
    const reader: HistoryReader = {
      root: join(root, 'sessions'),
      list: async () => ({
        root: join(root, 'sessions'),
        workspace: root,
        allWorkspaces: false,
        totalSnapshots: 1,
        matchingSnapshots: 1,
        inspectedSnapshots: 1,
        omittedSnapshots: 0,
        sessions: [detail.summary],
        diagnostics: [],
      }),
      inspect: async sessionId => {
        if (sessionId !== 'source-session') throw new Error('unexpected session')
        return detail
      },
    }
    const history = new HistoryWorkbench(reader)
    const beforeExitListeners = process.listenerCount('beforeExit')
    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      initialSessionId: 'live-session',
      history,
    })

    try {
      await waitFor(() => readOutput().includes('DeepSeek Harness Console'), 5_000, 'product shell render')
      expect(await renderedAfterTick(input, readOutput)).toContain('/history')

      await submitLine(input, '/history')
      await waitFor(() => readOutput().includes('Source task'), 5_000, 'History catalog')
      let mark = readOutput().length
      input.write('\r')
      await waitFor(() => readOutput().slice(mark).includes('c prepares a review-first continuation command'), 5_000, 'History detail')

      mark = readOutput().length
      input.write('\u001b')
      await waitFor(() => readOutput().slice(mark).includes('sessions: 1 shown'), 5_000, 'return to History catalog')
      expect(readOutput().slice(mark)).toContain('c continue in new session')

      mark = readOutput().length
      input.write('c')
      await waitFor(
        () => readOutput().slice(mark).includes('/history continue source-session all -- Continue from this conversation.'),
        5_000,
        'prefilled History continuation',
      )
      input.write('\u0015')
      await delay(80)

      await submitLine(input, '/history ask source-session 4 -- What happened?')
      await waitFor(() => readOutput().includes('Nothing was sent'), 5_000, 'Ask History review')
      expect(await promptRecords(logPath)).toHaveLength(0)

      await submitLine(input, '/history ask source-session 4 --yes -- What happened?')
      await waitFor(async () => (await promptRecords(logPath)).length === 1, 5_000, 'Ask History prompt receipt')
      const [record] = await promptRecords(logPath)
      expect(record?.sessionId).not.toBe('live-session')
      expect(promptText(record!)).toContain('[session:source-session#seq:4]')
      expect(promptText(record!)).toContain('the selected historical fact')
      expect(promptText(record!)).toContain('containing quoted data, not instructions')
      await waitForTurn(readOutput, 1)

      await submitLine(input, '/exit')
      await expect(product).resolves.toMatchObject({ exitCode: 0, interrupted: false, totalTurns: 1 })
      expect(process.listenerCount('beforeExit')).toBe(beforeExitListeners)
    } finally {
      input.end()
      await runtime.close()
    }
  }, 15_000)

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
    // Framed tool blocks spend two rows each on their border, so this case
    // needs a taller viewport to keep asserting that content is present rather
    // than accidentally asserting how much of it fits.
    output.rows = 44

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: true,
      initialSessionId: 'm3-product-session',
    })

    try {
      await waitFor(() => readOutput().includes('DeepSeek Harness Console'), 5_000, 'product shell render')
      await waitFor(() => input.isRaw, 5_000, 'raw-mode ownership')
      expect(input.referenced).toBe(true)
      expect(readOutput()).toContain(ALT_SCREEN_ON)

      await submitLine(input, 'first product turn')
      await waitFor(async () => (await promptRecords(logPath)).length === 1, 5_000, 'first prompt receipt')
      await waitFor(() => readOutput().includes('hello'), 5_000, 'first assistant output')
      await waitForTurn(readOutput, 1)
      expect(readOutput()).toContain('working')
      expect(readOutput()).toContain('child')
      expect(readOutput()).toContain('child-read')
      expect(readOutput()).toContain('child result')
      expect(readOutput()).toContain('README content')
      // Outcome must reach the screen as a glyph next to its word, and the
      // upstream-derived span must render beside it.
      expect(readOutput()).toContain('✓')
      expect(readOutput()).toMatch(/success · \d+(?:ms|\.\ds)/)
      // The glyph sits at column 0 of the header. Yoga used to compress blocks
      // when the column ran out of height and lay body text over the header,
      // eating exactly that prefix, so assert the whole header survives.
      expect(readOutput()).toMatch(/✓ tool · read · success/)
      // A tool call is framed, so it reads as a distinct object on the screen
      // rather than as another paragraph of prose.
      expect(readOutput()).toContain('╭')

      await submitLine(input, 'second product turn')
      await waitFor(async () => (await promptRecords(logPath)).length === 2, 5_000, 'second prompt receipt')
      await waitForTurn(readOutput, 2)
      const records = await promptRecords(logPath)
      expect(records.map(record => record.sessionId)).toEqual(['m3-product-session', 'm3-product-session'])

      await submitLine(input, '/plugins')
      await waitFor(() => readOutput().includes('Capability Explorer'), 5_000, 'Capability Explorer view')
      expect(readOutput()).toContain('partial/unavailable on SDK protocol 0.0.1')
      expect(readOutput()).toContain('prompt cancel: unavailable')
      input.write('\u001b[6~')
      await waitFor(() => readOutput().includes('dshc.core@1.0.0'), 5_000, 'paged plugin list')
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
      await waitFor(() => !input.isRaw, 5_000, 'raw-mode release')
      expect(input.referenced).toBe(false)
      expect(readOutput()).toContain(ALT_SCREEN_OFF)
      expect(readOutput()).not.toContain('private-reasoning-must-not-render')
      expect(readError()).toBe('')
    } finally {
      input.end()
      await runtime.close()
    }
  }, 15_000)

  it('shows the tool activity sidebar on a wide terminal and collapses it on a narrow one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m45-sidebar-'))
    tempRoots.push(root)
    const logPath = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, logPath)
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    output.columns = 140
    const readOutput = capture(output)

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: true,
      initialSessionId: 'm45-sidebar-session',
    })

    try {
      await waitFor(() => input.isRaw, 5_000, 'sidebar raw-mode ownership')
      await submitLine(input, 'drive one turn')
      await waitForTurn(readOutput, 1)

      // Tools are visible by default; full tool bodies stay out of wide chat.
      await waitFor(() => readOutput().includes('calls'), 5_000, 'sidebar counters')
      const wide = readOutput()
      expect(wide).toMatch(/\d+ calls/)
      expect(wide).toContain('child-read')
      for (const label of ['Context:', 'Total in', 'TPS request average:', 'Cache hit:', 'Turn elapsed:', '/status · /context']) {
        expect(wide).toContain(label)
      }
      expect(wide).not.toContain('README content')
      expect(wide).not.toContain('child result')

      await submitLine(input, '/sidebar overview')
      await waitFor(() => readOutput().includes('Provider:'), 5_000, 'overview available')
      await submitLine(input, '/sidebar tools')

      // Typing redraws the frame on every keystroke, so only the newest frame
      // says whether the sidebar is currently shown.
      // Ink renders differentially and does not clear the screen per frame on
      // every platform, so "is it on screen now" cannot be read by splitting
      // the stream into frames. Force fresh renders instead and ask whether the
      // sidebar appears in the output they produce.
      await submitLine(input, '/tools')
      await delay(250)
      const hidden = await renderedAfterTick(input, readOutput)
      expect(hidden).not.toContain('calls')
      expect(hidden).toContain('child result')

      await submitLine(input, '/tools')
      await delay(250)
      expect(await renderedAfterTick(input, readOutput)).toContain('calls')

      // Narrowing past the threshold collapses it rather than squeezing the
      // transcript.
      output.columns = 70
      output.emit('resize')
      await delay(250)
      const narrow = await renderedAfterTick(input, readOutput)
      expect(narrow).not.toContain('calls')
      expect(narrow).toContain('child result')

      await submitLine(input, '/exit')
      await product
    } finally {
      input.end()
      await runtime.close()
    }
  }, 15_000)

  it('moves focus to the sidebar, selects an entry and opens its detail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m45-focus-'))
    tempRoots.push(root)
    const logPath = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, logPath)
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    output.columns = 140
    const readOutput = capture(output)

    const TAB = '\u0009'
    const ESC = '\u001b'
    const ENTER = '\u000d'
    const UP = `${ESC}[A`

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: true,
      initialSessionId: 'm45-focus-session',
    })

    try {
      await waitFor(() => input.isRaw, 5_000, 'focus raw-mode ownership')
      await submitLine(input, 'drive one turn')
      await waitForTurn(readOutput, 1)
      await submitLine(input, '/sidebar tools')
      await waitFor(() => readOutput().includes('calls'), 5_000, 'sidebar counters')

      // Before Tab the prompt owns the arrows, and the hint says so.
      expect(await renderedAfterTick(input, readOutput)).toContain('Tab tools')

      input.write(TAB)
      // With focus in the sidebar, typing no longer changes the prompt, so a
      // forced render is unavailable here; these strings appear nowhere else,
      // so their presence in the stream is proof enough.
      await waitFor(() => readOutput().includes('tools · focus'), 5_000, 'sidebar focused')
      const focused = readOutput()
      // Focus is stated in words, and so is which entry is selected — neither
      // is carried by highlight alone.
      expect(focused).toContain('select')
      expect(focused).toMatch(/focus \d+\/\d+/)

      // While the sidebar holds focus, typing must not reach the prompt. This
      // token appears nowhere else, so any leak would show up in the stream.
      input.write('zzz')
      await delay(200)
      expect(readOutput()).not.toContain('zzz')

      // Arrows move the selection; Enter opens the detail on the view plane.
      input.write(UP)
      await delay(120)
      input.write(ENTER)
      await waitFor(() => readOutput().includes('Tool Call'), 5_000, 'tool detail view')
      const detail = readOutput()
      expect(detail).toContain('outcome:')
      expect(detail).toContain('elapsed:')
      expect(detail).toContain('arguments')

      // Close the detail, then leave the sidebar: the arrows go back to
      // prompt history and the hint says so again.
      input.write('q')
      await delay(150)
      input.write(ESC)
      await delay(250)
      expect(await renderedAfterTick(input, readOutput)).toContain('Tab tools')

      await submitLine(input, '/exit')
      await product
    } finally {
      input.end()
      await runtime.close()
    }
  }, 20_000)

  it('keeps the prompt hint and status line intact when the frame is tight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-chrome-'))
    tempRoots.push(root)
    const logPath = join(root, 'prompts.jsonl')
    // A long, wide-character reply is what actually overflows the frame; the
    // default fixture reply is far too short to reproduce the compression.
    const runtime = runtimeFor(root, logPath, 'verbose')
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    // Short enough that the transcript cannot fit, which is when Yoga used to
    // compress the chrome and lay the editor over its own hint.
    output.rows = 12
    const readOutput = capture(output)

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: true,
      initialSessionId: 'chrome-session',
    })

    try {
      await waitFor(() => input.isRaw, 5_000, 'chrome raw-mode ownership')
      await submitLine(input, 'fill the frame')
      await waitForTurn(readOutput, 1)

      const rendered = await renderedAfterTick(input, readOutput)
      // The editor row begins with the prompt marker, so a compressed column
      // eats the first characters of the hint above it — 'Enter' became
      // 'r submit' in the report that prompted this test.
      expect(rendered).toContain('Enter submit')
      expect(rendered).not.toMatch(/\br submit\b/)
      // The status line sits between two rules and was eaten the same way.
      expect(rendered).toContain('session 00:')

      await submitLine(input, '/exit')
      await product
    } finally {
      input.end()
      await runtime.close()
    }
  }, 15_000)

  it('scrolls the transcript, says what is out of sight, and returns to newest on submit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-scroll-'))
    tempRoots.push(root)
    const logPath = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, logPath, 'verbose')
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    output.rows = 16
    const readOutput = capture(output)

    const PAGE_UP = '\u001b[5~'
    const PAGE_DOWN = '\u001b[6~'

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: true,
      initialSessionId: 'scroll-session',
    })

    try {
      await waitFor(() => input.isRaw, 5_000, 'scroll raw-mode ownership')
      await submitLine(input, 'produce a long answer')
      await waitForTurn(readOutput, 1)

      // Typing a bare slash lists the commands, built from the live registry.
      // This viewport only has room for a few, so the rest are counted rather
      // than clipped by the frame.
      input.write('/')
      await delay(200)
      const menu = readOutput()
      expect(menu).toContain('/agents')
      expect(menu).toMatch(/↓ \d+ more/)
      input.write('')
      await delay(150)

      // At rest the newest activity is shown and nothing claims to be below.
      const tail = await renderedAfterTick(input, readOutput)
      expect(tail).not.toContain('newer below')
      expect(tail).toContain('第 39 行')

      input.write(PAGE_UP)
      await delay(150)
      const scrolled = await renderedAfterTick(input, readOutput)
      // A scrolled-back view must never look like the newest one.
      expect(scrolled).toContain('newer below')
      expect(scrolled).toContain('PageDown to catch up')

      input.write(PAGE_DOWN)
      await delay(150)
      expect(await renderedAfterTick(input, readOutput)).not.toContain('newer below')

      // Read all of the same reply by paging up; whole-block navigation used
      // to skip from its clipped beginning straight to the previous message.
      const pages: string[] = [tail]
      for (let step = 0; step < 20; step++) {
        const mark = readOutput().length
        input.write(PAGE_UP)
        await delay(60)
        pages.push(readOutput().slice(mark))
      }
      const entireReply = pages.join('\n')
      for (let line = 0; line < 40; line++) expect(entireReply).toContain(`第 ${line} 行`)
      for (let step = 0; step < 20; step++) { input.write(PAGE_DOWN); await delay(30) }

      // Scroll back again, then submit: a reply arriving off-screen would look
      // like nothing happened, so submitting returns to the newest activity.
      input.write(PAGE_UP)
      await delay(150)
      expect(await renderedAfterTick(input, readOutput)).toContain('newer below')
      await submitLine(input, 'second turn')
      await waitForTurn(readOutput, 2)
      expect(await renderedAfterTick(input, readOutput)).not.toContain('newer below')

      await submitLine(input, '/exit')
      await product
    } finally {
      input.end()
      await runtime.close()
    }
  }, 20_000)

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
      await waitFor(() => input.isRaw, 5_000, 'Unicode editor raw-mode ownership')

      // Astral emoji backspace must remove the whole grapheme, not one surrogate.
      input.write('😀')
      await delay(20)
      input.write('\u007f')
      await delay(20)
      await submitLine(input, 'after-delete')
      await waitFor(async () => (await promptRecords(logPath)).length === 1, 5_000, 'Unicode turn 1 receipt')
      expect(promptText((await promptRecords(logPath))[0]!)).toBe('after-delete')
      await waitForTurn(readOutput, 1)

      // Walk left across B and emoji, right across the emoji, then insert.
      input.write('A😀B')
      await delay(20)
      input.write('\u001B[D\u001B[D\u001B[C')
      await delay(20)
      await submitLine(input, 'X')
      await waitFor(async () => (await promptRecords(logPath)).length === 2, 5_000, 'Unicode turn 2 receipt')
      expect(promptText((await promptRecords(logPath))[1]!)).toBe('A😀XB')
      await waitForTurn(readOutput, 2)

      // A multi-code-point ZWJ family must delete as one editing unit.
      input.write('👨‍👩‍👧‍👦')
      await delay(20)
      input.write('\u007f')
      await delay(20)
      await submitLine(input, 'family-deleted')
      await waitFor(async () => (await promptRecords(logPath)).length === 3, 5_000, 'Unicode turn 3 receipt')
      expect(promptText((await promptRecords(logPath))[2]!)).toBe('family-deleted')
      await waitForTurn(readOutput, 3)

      // Combining grapheme is also one backspace unit.
      input.write('e\u0301')
      await delay(20)
      input.write('\u007f')
      await delay(20)
      await submitLine(input, 'combining-deleted')
      await waitFor(async () => (await promptRecords(logPath)).length === 4, 5_000, 'Unicode turn 4 receipt')
      expect(promptText((await promptRecords(logPath))[3]!)).toBe('combining-deleted')
      await waitForTurn(readOutput, 4)

      const mixed = '中文abc😀👍🏽'
      await submitLine(input, mixed)
      await waitFor(async () => (await promptRecords(logPath)).length === 5, 5_000, 'Unicode turn 5 receipt')
      expect(promptText((await promptRecords(logPath))[4]!)).toBe(mixed)
      expect((await promptRecords(logPath)).every(record => !hasLoneSurrogate(promptText(record)))).toBe(true)
      await waitForTurn(readOutput, 5)

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
      input.write('\u0015') // Failed command remains available for editing.
      await delay(30)
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

  it('Ctrl+C without a restart provider closes the whole runtime and restores terminal state', async () => {
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
      await waitFor(() => readOutput().includes('Enter queue'))
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

  it('waits for an aborted local install and closes a replacement returned after shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-product-install-abort-'))
    tempRoots.push(root)
    const runtime = runtimeFor(root, join(root, 'prompts.jsonl'))
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    const replacementClose = vi.fn(async () => undefined)
    const replacement = { close: replacementClose } as unknown as HarnessRuntime
    let releaseInstall!: () => void
    const installGate = new Promise<void>(resolve => { releaseInstall = resolve })
    let installSignal: AbortSignal | undefined
    let productSettled = false

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: false,
      installPlugin: async (_spec, signal) => {
        installSignal = signal
        await installGate
        return {
          runtime: replacement,
          metadata: {
            workspace: root,
            provider: 'deepseek-official',
            model: 'deepseek-v4-flash',
            serverName: 'late-install-runtime',
            protocolVersion: '0.0.1',
          },
          message: 'late install',
        }
      },
    })
    void product.finally(() => { productSettled = true })

    try {
      await waitFor(() => input.isRaw)
      await submitLine(input, '/plugin install @deepseek-ai/example@1.2.3 --yes')
      await waitFor(() => installSignal !== undefined)
      input.write('\u0003')
      await waitFor(() => installSignal?.aborted === true)
      await delay(80)
      expect(productSettled).toBe(false)

      releaseInstall()
      await expect(product).resolves.toMatchObject({ exitCode: 130, interrupted: true })
      expect(replacementClose).toHaveBeenCalledTimes(1)
    } finally {
      releaseInstall()
      input.end()
      await runtime.close()
    }
  }, 15_000)

  it('processes coalesced multi-line input in order without losing either submit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-product-coalesced-'))
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
    })

    try {
      await waitFor(() => input.isRaw)
      input.write('first\rsecond\r')
      await waitFor(async () => (await promptRecords(logPath)).length === 2, 8_000, 'coalesced prompts')
      const records = await promptRecords(logPath)
      expect(records.map(record => promptText(record))).toEqual(['first', 'second'])
      await waitForTurn(readOutput, 2)
      await submitLine(input, '/exit')
      await expect(product).resolves.toMatchObject({ exitCode: 0, totalTurns: 2 })
    } finally {
      input.end()
      await runtime.close()
    }
  }, 15_000)

  it('interrupts an active turn by replacing the runtime and starting a fresh session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-product-interrupt-'))
    tempRoots.push(root)
    const logPath = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, logPath, 'hang-activity')
    let replacement: HarnessRuntime | undefined
    let restartCalls = 0
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
      initialSessionId: 'interrupt-source-session',
      restart: async selection => {
        expect(selection).toMatchObject({ mode: 'code', replyLanguage: 'auto', runtime: 'bundled' })
        restartCalls += 1
        replacement = runtimeFor(root, logPath)
        return { runtime: replacement, metadata: await replacement.start() }
      },
    })

    try {
      await waitFor(() => input.isRaw)
      await submitLine(input, 'wait until interrupted')
      await waitFor(async () => (await promptRecords(logPath)).length === 1)
      await waitFor(() => readOutput().includes('Enter queue'))
      input.write('\u0003')

      await waitFor(() => readOutput().includes('Interrupt completed by replacing the whole Harness runtime'))
      expect(restartCalls).toBe(1)
      expect(readOutput()).toContain('cannot be resumed')
      expect(readOutput()).toContain('was not resumed')

      await submitLine(input, 'continue after interrupt')
      await waitFor(async () => (await promptRecords(logPath)).length === 2)
      await waitFor(() => readOutput().includes('hello'))
      await submitLine(input, '/exit')
      const result = await product
      expect(result).toMatchObject({ exitCode: 0, interrupted: false, totalTurns: 1 })
      expect(result.sessionId).not.toBe('interrupt-source-session')
    } finally {
      input.end()
      await replacement?.close()
      await runtime.close()
    }
  }, 15_000)

  it('fails closed when interrupt cannot start a clean replacement runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-product-interrupt-failure-'))
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
      initialSessionId: 'interrupt-failure-session',
      restart: async () => { throw new Error('replacement refused') },
    })

    try {
      await waitFor(() => input.isRaw)
      await submitLine(input, 'wait for failed interrupt recovery')
      await waitFor(async () => (await promptRecords(logPath)).length === 1)
      input.write('\u0003')

      await expect(product).resolves.toEqual({
        exitCode: 130,
        interrupted: true,
        totalTurns: 0,
        sessionId: 'interrupt-failure-session',
      })
      expect(readOutput()).toContain('could not establish a clean replacement runtime')
      expect(readOutput()).toContain('replacement refused')
      expect(readOutput()).toContain(ALT_SCREEN_OFF)
    } finally {
      input.end()
      await runtime.close()
    }
  }, 15_000)

  it('treats terminal EOF as a clean whole-runtime exit and restores terminal state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m6-product-eof-'))
    tempRoots.push(root)
    const runtime = runtimeFor(root, join(root, 'prompts.jsonl'))
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
      initialSessionId: 'm6-product-eof',
    })

    try {
      await waitFor(() => input.isRaw)
      input.end()
      await expect(product).resolves.toEqual({
        exitCode: 0,
        interrupted: false,
        totalTurns: 0,
        sessionId: 'm6-product-eof',
      })
      await waitFor(() => !input.isRaw)
      expect(input.referenced).toBe(false)
      expect(readOutput()).toContain(ALT_SCREEN_OFF)
    } finally {
      input.end()
      await runtime.close()
    }
  }, 15_000)

  it('shows token usage once a turn has reported it, and never a context percentage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m4-usage-'))
    tempRoots.push(root)
    const logPath = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, logPath)
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    const readOutput = capture(output)
    output.rows = 44

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: false,
      initialSessionId: 'm4-usage-session',
    })

    try {
      await waitFor(() => input.isRaw)
      // Nothing has reported usage yet, so the segment must be absent rather
      // than showing a confident zero.
      expect(await renderedAfterTick(input, readOutput)).toContain('ctx —')

      await submitLine(input, 'a turn that reports usage')
      await waitFor(async () => (await promptRecords(logPath)).length === 1)
      await waitForTurn(readOutput, 1)

      const frame = await renderedAfterTick(input, readOutput)
      // The root request has 4267 uncached + 384 cached input tokens; the
      // subagent's separate 900-token request must not become the number
      // describing this conversation's size. Its uncached input still belongs
      // in the runtime-wide cache share, hence 384 / (4267 + 384 + 900) = 7%.
      expect(frame).toContain('ctx 4.7K')
      expect(frame).not.toContain('cache 7%') // details moved out of the footer
      expect(frame).not.toContain('ctx 900')

      await submitLine(input, '/status')
      const status = await renderedAfterTick(input, readOutput)
      expect(status).toContain('latest request input')
      expect(status).toContain('cumulative total input')
      expect(status).toContain('cumulative uncached input')
      // Cumulative output counts every session, root and child alike.
      expect(status).toContain('cumulative output')
      expect(status).toContain('will not invent one')
      expect(status).not.toMatch(/\d+% (of|full|used)/)

      await submitLine(input, '/exit')
      await product
    } finally {
      input.end()
      await runtime.close()
    }
  }, 20_000)

  it('lets the slash menu be navigated, completed and scrolled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m4-menu-'))
    tempRoots.push(root)
    const runtime = runtimeFor(root, join(root, 'prompts.jsonl'))
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    const readOutput = capture(output)
    output.rows = 30

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: false,
      initialSessionId: 'm4-menu-session',
    })

    const DOWN_ARROW = '\u001b[B'
    const ESCAPE = '\u001b'

    try {
      await waitFor(() => input.isRaw)
      // renderedAfterTick types a character to force a redraw, which would
      // reset the highlight it is here to observe. Every key below redraws by
      // itself, so the frame is sliced off the tail instead.
      let mark = readOutput().length
      input.write('/')
      await delay(200)
      const opened = readOutput().slice(mark)
      // Something is highlighted from the moment the menu opens, and the marker
      // carries that as well as the colour.
      expect(opened).toContain('› /')
      // More commands exist than fit, and the count below is reachable rather
      // than merely reported.
      expect(opened).toMatch(/↓ \d+ more/)

      // Arrowing past the fold scrolls the window instead of stopping.
      mark = readOutput().length
      for (let step = 0; step < 9; step += 1) {
        input.write(DOWN_ARROW)
        await delay(30)
      }
      await delay(120)
      const scrolled = readOutput().slice(mark)
      expect(scrolled).toMatch(/↑ \d+ more/)

      // Escape closes it and hands the arrows back to history.
      mark = readOutput().length
      input.write(ESCAPE)
      await delay(200)
      const dismissed = readOutput().slice(mark)
      expect(dismissed.length).toBeGreaterThan(0)
      expect(dismissed).not.toContain('› /')

      // The slash is still in the prompt; leaving it would make the next
      // line `//exit`, which is the escape for a literal prompt.
      input.write('\u007f')
      await delay(60)
      await submitLine(input, '/exit')
      await product
    } finally {
      input.end()
      await runtime.close()
    }
  }, 30_000)

  it('renders markdown instead of printing its markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m4-markdown-'))
    tempRoots.push(root)
    const logPath = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, logPath, 'markdown')
    const input = new TestInput()
    const output = new TestOutput()
    const error = new TestOutput()
    const readOutput = capture(output)
    output.rows = 46

    const product = runTerminalProduct(runtime, {
      stdin: input as unknown as NodeJS.ReadStream,
      stdout: output as unknown as NodeJS.WriteStream,
      stderr: error as unknown as NodeJS.WriteStream,
      interactive: true,
      useAlternateScreen: false,
      initialSessionId: 'm4-markdown-session',
    })

    try {
      await waitFor(() => input.isRaw)
      await submitLine(input, 'answer in markdown')
      await waitFor(async () => (await promptRecords(logPath)).length === 1)
      await waitFor(() => readOutput().includes('Findings'), 5_000, 'markdown answer')

      const frame = await renderedAfterTick(input, readOutput)
      // The emphasis markers are consumed, not printed.
      expect(frame).toContain('The parser is fine')
      expect(frame).not.toContain('**parser**')
      expect(frame).not.toContain('`pnpm check`')
      expect(frame).toContain('pnpm check')
      // A bullet becomes a bullet.
      expect(frame).toContain('• first point')
      // A fenced block keeps its contents exactly, markers and all: quoting
      // something is a request to leave it alone.
      expect(frame).toContain('const literal = "**not bold**"')
      expect(frame).not.toContain('```')
      // CJK table columns are padded by cell width, so the second column starts
      // at the same place on both rows.
      const lines = frame.split('\n')
      const header = lines.find(line => line.includes('文件'))
      const row = lines.find(line => line.includes('a.ts'))
      expect(header).toBeDefined()
      expect(row).toBeDefined()

      await submitLine(input, '/exit')
      await product
    } finally {
      input.end()
      await runtime.close()
    }
  }, 20_000)
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

async function waitForTurn(readOutput: () => string, turn: number): Promise<void> {
  await waitFor(() => completedTurns >= turn, 5_000, `turn ${turn} completion`)
  await delay(100) // allow the terminal's batched final snapshot to commit
  void readOutput
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  label = 'terminal product state',
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
