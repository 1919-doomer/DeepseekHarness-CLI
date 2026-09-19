import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

/**
 * An operation reviewer is a session the terminal registers before it exists.
 * The runtime must create it read-only in code mode — the mode in which every
 * other session may write — keep it read-only across mode switches, and leave
 * every other session's tools alone. Only the real runtime can show that.
 */
describe('operation reviewer sessions', () => {
  const executable = process.env.DSHC_TEST_DSH ?? resolve('node_modules/.dshc-profile-validation/node_modules/@deepseek-ai/dsh/lib/bin.js')
  const shell = process.platform === 'win32' ? 'pwsh' : 'bash'

  for (const backend of ['bundled', 'dsh-profile'] as const) {
    it.skipIf(backend === 'dsh-profile' && !existsSync(executable))(`${backend} creates a registered reviewer read-only and leaves other sessions alone`, async () => {
      const root = await mkdtemp(resolve('node_modules/dshc-review-'))
      await writeFile(join(root, 'keep.txt'), 'unchanged')
      // Each prompt carries a marker; the step is how many tool results have
      // come back since the latest user message. That keeps the script right
      // regardless of what other requests the runtime makes.
      const scripts: Record<string, { name: string; args: Record<string, unknown> }[]> = {
        'REVIEW-ONE': [
          { name: 'write', args: { file_path: 'keep.txt', content: 'changed by reviewer' } },
          { name: shell, args: { command: 'echo reviewer-shell', description: 'must be denied' } },
          { name: 'outline_plan', args: { steps: ['a', 'b'] } },
          { name: 'read', args: { file_path: 'keep.txt' } },
        ],
        'REVIEW-TWO': [
          { name: 'edit', args: { file_path: 'keep.txt', old_string: 'unchanged', new_string: 'edited by reviewer' } },
        ],
        'NORMAL-ONE': [],
      }
      const seen: { marker: string; tools: string[] }[] = []
      const server = createServer((req, res) => {
        let raw = ''
        req.on('data', chunk => { raw += String(chunk) })
        req.on('end', () => {
          const body = JSON.parse(raw) as { messages?: { role: string; content?: unknown }[]; tools?: { function?: { name?: string } }[] }
          const messages = body.messages ?? []
          // The latest prompt carrying a marker. Not simply the last user-role
          // message: the runtime context snapshot is delivered as one too.
          let lastPrompt = -1
          let marker = 'other'
          messages.forEach((message, index) => {
            if (message.role !== 'user') return
            const found = Object.keys(scripts).find(key => JSON.stringify(message.content ?? '').includes(key))
            if (found !== undefined) { lastPrompt = index; marker = found }
          })
          const done = messages.slice(lastPrompt + 1).filter(message => message.role === 'tool').length
          seen.push({ marker, tools: (body.tools ?? []).map(tool => tool.function?.name ?? '?') })
          const step = scripts[marker]?.[done]
          const delta = step
            ? { tool_calls: [{ index: 0, id: `call-${seen.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] }
            : { content: marker.startsWith('REVIEW') ? 'VERDICT: clean\nSUMMARY: fixture' : `${marker.toLowerCase()}-done` }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
          res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
        })
      })
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No server address')
      const runtime = new HarnessRuntime({ workspace: root, preferences: { mode: 'code', runtime: backend }, activityTimeoutMs: 20_000,
        env: { DEEPSEEK_API_KEY: 'fixture-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, DSHC_DSH_EXECUTABLE: executable, DSH_HOME: join(root, 'state'), DSH_SESSION_ROOT: join(root, 'state', 'sessions') } })
      runtime.enableInteraction()
      const denied = (result: Awaited<ReturnType<HarnessRuntime['run']>>) =>
        result.events.filter(event => event.kind === 'tool-result' && event.isError).length
      const toolsFor = (marker: string) => seen.find(entry => entry.marker === marker)?.tools ?? []
      try {
        await runtime.start()
        expect(runtime.interaction?.canSteer).toBe(true)
        const reviewer = 'review-fixture-0001'
        await runtime.interaction!.registerReviewer(reviewer)

        const first = await runtime.run('REVIEW-ONE check the last turn', { sessionId: reviewer, interactive: false })
        expect(first.projection.lastTurnError).toBeUndefined()
        expect(first.finalResponse).toContain('VERDICT: clean')
        // write, the shell and outline_plan are refused; read works.
        expect(denied(first)).toBe(3)
        expect(first.events.filter(event => event.kind === 'tool-result' && !event.isError)).toHaveLength(1)
        expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('unchanged')
        const reviewerTools = toolsFor('REVIEW-ONE')
        expect(reviewerTools).toContain('read')
        for (const tool of ['write', 'edit', 'pwsh', 'bash', 'subagent', 'outline_plan', 'request_user_input', 'web_fetch']) expect(reviewerTools).not.toContain(tool)

        // Another session in the same runtime keeps code mode's tools.
        const normal = await runtime.run('NORMAL-ONE say hello', { sessionId: 'normal-fixture' })
        expect(normal.finalResponse).toBe('normal-one-done')
        expect(toolsFor('NORMAL-ONE')).toContain('write')
        expect(toolsFor('NORMAL-ONE')).toContain('outline_plan')

        // A session that already exists was not created narrowed, so it cannot become a reviewer.
        await expect(runtime.interaction!.registerReviewer('normal-fixture')).rejects.toThrow(/refused \(409\)/)

        // A mode switch re-narrows ordinary sessions; it must not widen a reviewer.
        expect(await runtime.interaction!.setMode('plan')).toBe(true)
        expect(await runtime.interaction!.setMode('code')).toBe(true)
        const second = await runtime.run('REVIEW-TWO check again', { sessionId: reviewer, interactive: false })
        expect(denied(second)).toBe(1)
        expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('unchanged')
        expect(toolsFor('REVIEW-TWO')).not.toContain('edit')
      } finally {
        await runtime.close()
        server.closeAllConnections()
        await new Promise<void>(done => server.close(() => done()))
        await rm(root, { recursive: true, force: true })
      }
    }, 40_000)
  }
})
