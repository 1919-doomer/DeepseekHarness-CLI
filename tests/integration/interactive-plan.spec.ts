import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'
import { runTerminalProduct } from '../../src/terminal/product.js'
class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(raw: boolean): this { this.isRaw = raw; return this }; ref(): this { return this }; unref(): this { return this } }
class Output extends PassThrough { isTTY = true; columns = 120; rows = 32; getColorDepth(): number { return 8 }; hasColors(): boolean { return true } }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean | Promise<boolean>): Promise<void> { for (let i = 0; i < 200; i++) { if (await check()) return; await delay(25) }; throw new Error('UI condition timed out') }

it.each(['implement', 'restart-fails', 'superseded'] as const)('%s: preserves drafts, binds confirmation to the current plan and handles handoff', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'dshc-plan-ui-'))
  const file = join(root, 'result.txt'); await writeFile(file, 'original')
  const requests: Record<string, unknown>[] = []
  const steps = [
    { name: 'request_user_input', args: { questions: [{ id: 'q', title: '选择语言', options: [{ label: '中文', recommended: true }, { label: 'English' }] }] } },
    { name: 'present_plan', args: { title: 'Confirmed fixture plan', text: 'Write result.txt with the exact text implemented, then verify the file.' } },
    ...(scenario === 'superseded' ? [{ name: 'present_plan', args: { title: 'Updated plan', text: 'A changed plan requires a new confirmation.' } }] : []),
    undefined,
    { name: 'read', args: { file_path: 'result.txt' } },
    { name: 'write', args: { file_path: 'result.txt', content: 'implemented' } },
    undefined,
  ]
  const server = createServer((req, res) => { let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
    requests.push(JSON.parse(body)); const step = steps.shift()
    const delta = step ? { tool_calls: [{ index: 0, id: `c-${requests.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] } : { content: 'completed' }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
  }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  const env = { DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, DSH_HOME: join(root, 'home'), DSH_SESSION_ROOT: join(root, 'sessions') }
  const runtime = new HarnessRuntime({ workspace: root, preferences: { mode: 'plan' }, env })
  const runtimes = [runtime]
  const input = new Input(), output = new Output(), error = new Output(); let frames = ''
  output.on('data', chunk => { frames += String(chunk) }); error.resume()
  const restart = vi.fn(async () => { if (scenario === 'restart-fails') throw new Error('fixture startup failed'); const next = new HarnessRuntime({ workspace: root, preferences: { mode: 'code' }, env }); next.enableInteraction(); runtimes.push(next); return { runtime: next, metadata: await next.start() } })
  const product = runTerminalProduct(runtime, { stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream, stderr: error as unknown as NodeJS.WriteStream,
    preferences: { animation: false, locale: 'zh-CN', mode: 'plan' }, initialSessionId: 'plan-ui-source', restart })
  const key = async (text: string) => { input.write(text); await delay(65) }
  try {
    await until(() => input.isRaw); await key('Plan this change'); await key('\r')
    await until(() => runtime.interaction?.current?.kind === 'questions'); await delay(100)
    await key('\t'); await key('保留中文'); await key('\u001b')
    output.columns = 70; output.rows = 18; output.emit('resize'); await delay(100)
    await key('\r'); await key('\r'); await key('\r')
    await until(() => runtime.interaction?.current?.kind === 'plan'); await delay(100)
    expect(restart).not.toHaveBeenCalled(); expect(await readFile(file, 'utf8')).toBe('original')
    expect(JSON.stringify(requests)).toContain('保留中文')
    await key('\r'); await key('\r'); await key('\r')
    if (scenario !== 'implement') {
      if (scenario === 'superseded') {
        await until(() => runtime.interaction?.current?.kind === 'plan'); await delay(100)
        await key('\u001b[B'); await key('\u001b[B'); await key('\r'); await key('\r'); await key('\r')
        await until(() => requests.length === 4); await delay(150)
        expect(restart).not.toHaveBeenCalled()
      } else { await until(() => frames.includes('原计划和会话已保留')); expect(restart).toHaveBeenCalledTimes(1) }
      expect(await readFile(file, 'utf8')).toBe('original')
      await key('/exit'); await key('\r'); expect((await product).exitCode).toBe(0)
      return
    }
    try { await until(async () => await readFile(file, 'utf8') === 'implemented') }
    catch { throw new Error(`Handoff stalled: restarts=${restart.mock.calls.length}, requests=${requests.length}\n${frames.slice(-1200)}`) }
    await until(() => requests.length === 6); await delay(150)
    expect(restart).toHaveBeenCalledTimes(1)
    const codeRequest = JSON.stringify(requests[3])
    expect(codeRequest).toContain('plan-ui-source')
    expect(codeRequest).toContain('保留中文')
    expect(codeRequest).toContain('Confirmed fixture plan')
    expect(frames).toContain('主·Agent')
    await key('/exit'); await key('\r'); expect((await product).exitCode).toBe(0)
    expect(input.isRaw).toBe(false)
  } finally {
    input.end(); await Promise.all(runtimes.map(r => r.close())); await product.catch(() => undefined)
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true })
  }
}, 20_000)
