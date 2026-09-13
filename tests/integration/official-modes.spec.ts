import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

describe('Harness work mode execution boundary', () => {
  it.each(['plan', 'review', 'research'] as const)('%s rejects writes, shell and delegation even when the provider requests them', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-mode-'))
    await writeFile(join(root, 'keep.txt'), 'unchanged')
    const requests: Record<string, unknown>[] = []
    const steps = [
      { name: 'read', args: { file_path: 'keep.txt' } },
      { name: 'write', args: { file_path: 'keep.txt', content: 'changed' } },
      { name: process.platform === 'win32' ? 'pwsh' : 'bash', args: { command: 'echo forbidden', description: 'must be denied' } },
      { name: 'subagent', args: { prompt: 'write keep.txt', description: 'must be denied' } },
      { name: 'researcher', args: { prompt: 'write keep.txt' } },
      { name: 'run_code', args: { code: 'await tools.write({file_path:"keep.txt",content:"changed"})' } },
    ]
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += String(chunk) })
      req.on('end', () => {
        requests.push(JSON.parse(body))
        const step = steps[requests.length - 1]
        const delta = step ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] } : { content: 'mode-test-complete' }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No server address')
    const runtime = new HarnessRuntime({ workspace: root, preferences: { mode }, activityTimeoutMs: 25_000,
      env: { DEEPSEEK_API_KEY: 'fixture-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, DSH_HOME: join(root, 'state'), DSH_SESSION_ROOT: join(root, 'state', 'sessions') } })
    try {
      const result = await runtime.run('Execute the tool regression sequence')
      expect(result.finalResponse).toBe('mode-test-complete')
      expect(result.projection.lastTurnError).toBeUndefined()
      expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('unchanged')
      expect(result.events.filter(event => event.kind === 'tool-result' && event.isError)).toHaveLength(5)
      const schemas = JSON.stringify(requests[0]?.['tools'])
      expect(schemas).toContain('"read"')
      for (const tool of ['write', 'edit', 'subagent', 'researcher', 'pwsh', 'bash']) expect(schemas).not.toContain(`"name":"${tool}"`)
      if (mode === 'research') expect(schemas).toContain('"web_search"')
    } finally {
      await runtime.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 35_000)
})
