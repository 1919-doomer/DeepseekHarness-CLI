import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'
import { runTerminalProduct } from '../../src/terminal/product.js'
class Input extends PassThrough { isTTY = true; isRaw = false; setRawMode(raw: boolean): this { this.isRaw = raw; return this }; ref(): this { return this }; unref(): this { return this } }
class Output extends PassThrough { isTTY = true; columns = 120; rows = 32; getColorDepth(): number { return 8 }; hasColors(): boolean { return true } }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => boolean | Promise<boolean>): Promise<void> { for (let i = 0; i < 240; i++) { if (await check()) return; await delay(25) }; throw new Error('UI condition timed out') }

/**
 * The whole path: a turn that writes a file ends, dshc starts a read-only
 * review session in the same runtime, and the review lands in the transcript.
 * A turn that only reads starts none.
 */
it.each(['changes', 'looks'] as const)('a turn that %s is reviewed only if it changed something', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'dshc-review-ui-'))
  const bodies: { review: boolean; body: string; tools: string[] }[] = []
  const main = scenario === 'changes'
    ? [
        { name: 'outline_plan', args: { steps: ['Write the note', 'Report back'] } },
        { name: 'write', args: { file_path: 'note.txt', content: 'hello' } },
      ]
    : [{ name: 'read', args: { file_path: 'missing.txt' } }]
  const server = createServer((req, res) => { let raw = ''; req.on('data', chunk => { raw += chunk }); req.on('end', () => {
    const parsed = JSON.parse(raw) as { messages?: { role: string }[]; tools?: { function?: { name?: string } }[] }
    const review = raw.includes('operation reviewer')
    bodies.push({ review, body: raw, tools: (parsed.tools ?? []).map(tool => tool.function?.name ?? '?') })
    const messages = parsed.messages ?? []
    const done = messages.filter(message => message.role === 'tool').length
    const step = review ? undefined : main[done]
    const delta = step
      ? { tool_calls: [{ index: 0, id: `c-${bodies.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] }
      : { content: review ? 'VERDICT: concerns\nSUMMARY: 核对了写入。\n- [claim] #1 说已验证，但没有读回文件。' : 'Wrote note.txt and verified it.' }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
  }) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  const env = { DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, DSH_HOME: join(root, 'home'), DSH_SESSION_ROOT: join(root, 'sessions') }
  const runtime = new HarnessRuntime({ workspace: root, preferences: { mode: 'code' }, env })
  const input = new Input(), output = new Output(), error = new Output(); let frames = ''
  output.on('data', chunk => { frames += String(chunk) }); error.resume()
  const product = runTerminalProduct(runtime, { stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream, stderr: error as unknown as NodeJS.WriteStream,
    interactive: true, preferences: { animation: false, locale: 'zh-CN', mode: 'code' }, initialSessionId: 'review-ui-main' })
  const key = async (text: string) => { input.write(text); await delay(65) }
  try {
    await until(() => input.isRaw); await key('Write a note'); await key('\r')
    if (scenario === 'changes') {
      await until(async () => await readFile(join(root, 'note.txt'), 'utf8').catch(() => '') === 'hello')
      await until(() => frames.includes('操作审查 · 1 条提醒'))
      expect(frames).toContain('[说法不符] #1 说已验证，但没有读回文件。')
      const reviews = bodies.filter(entry => entry.review)
      expect(reviews).toHaveLength(1)
      // The reviewer sees the evidence, and it cannot write.
      expect(reviews[0]!.body).toContain('Write the note')
      expect(reviews[0]!.body).toContain('write · note.txt')
      expect(reviews[0]!.body).toContain('Wrote note.txt and verified it.')
      expect(reviews[0]!.tools).toContain('read')
      for (const tool of ['write', 'edit', 'pwsh', 'bash', 'outline_plan']) expect(reviews[0]!.tools).not.toContain(tool)
    } else {
      await until(() => bodies.length >= 2 && frames.includes('Wrote note.txt'))
      await delay(400)
      expect(bodies.filter(entry => entry.review)).toHaveLength(0)
      expect(frames).not.toContain('操作审查')
    }
    await key('/exit'); await key('\r'); expect((await product).exitCode).toBe(0)
  } finally {
    input.end(); await runtime.close(); await product.catch(() => undefined)
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true })
  }
}, 20_000)
