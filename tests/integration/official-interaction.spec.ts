import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

describe('first-party Harness interaction', () => {
  const executable = process.env.DSHC_TEST_DSH ?? resolve('node_modules/.dshc-profile-validation/node_modules/@deepseek-ai/dsh/lib/bin.js')
  for (const backend of ['bundled', 'dsh-profile'] as const) {
  it.skipIf(backend === 'dsh-profile' && !existsSync(executable))(`${backend} waits beyond the activity budget, returns answers to the same call, and keeps plan tools read-only`, async () => {
    const root = await mkdtemp(resolve('node_modules/dshc-interaction-'))
    await writeFile(join(root, 'keep.txt'), 'unchanged')
    const requests: Record<string, unknown>[] = []
    const steps = [
      { name: 'request_user_input', args: { questions: [{ id: 'language', title: '选择语言', options: [{ label: '中文', recommended: true }, { label: 'English' }] }] } },
      { name: 'present_plan', args: { title: 'Plan', text: 'Inspect keep.txt. Do not write until the user selects implementation.' } },
      { name: 'write', args: { file_path: 'keep.txt', content: 'forbidden' } },
    ]
    const server = createServer((req, res) => { let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
      requests.push(JSON.parse(body)); const step = steps.shift()
      const delta = step ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] } : { content: 'done' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
    }) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No address')
    const runtime = new HarnessRuntime({ workspace: root, preferences: { mode: 'plan', runtime: backend }, activityTimeoutMs: 3000,
      env: { DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, DSHC_DSH_EXECUTABLE: executable, DSH_HOME: join(root, 'state'), DSH_SESSION_ROOT: join(root, 'state', 'sessions') } })
    runtime.enableInteraction()
    let timer: NodeJS.Timeout | undefined
    runtime.interaction!.subscribe(() => {
      const request = runtime.interaction!.current
      if (!request) return
      if (request.kind === 'questions') timer = setTimeout(() => runtime.interaction!.answer(request.id, { action: 'submit', answers: [{ id: 'language', option: 0, text: '保留英文术语' }] }), 3200)
      else runtime.interaction!.answer(request.id, { action: 'defer' })
    })
    try {
      expect((await runtime.start()).interaction?.available).toBe(true)
      const result = await runtime.run('Ask then plan', { sessionId: 'root-interaction' })
      expect(result.projection.lastTurnError).toBeUndefined()
      expect(result.finalResponse).toBe('done')
      const results = result.events.filter(e => e.kind === 'tool-result')
      expect(results).toHaveLength(3)
      expect(results.filter(e => e.kind === 'tool-result' && e.isError)).toHaveLength(1)
      expect(JSON.stringify(requests)).toContain('保留英文术语')
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('unchanged')
    } finally { clearTimeout(timer); await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
  }, 15_000)
  }
})
