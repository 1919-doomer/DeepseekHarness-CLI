import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'
import { TESTED_PROFILE_VERSION } from '../../src/upstream/dsh-profile.js'

const executable = process.env.DSHC_TEST_DSH ?? resolve('node_modules/.dshc-profile-validation/node_modules/@deepseek-ai/dsh/lib/bin.js')
describe.skipIf(!existsSync(executable))('exact official DSH SDK Profile', () => {
  it.each(['code', 'plan', 'review', 'research'] as const)('runs %s through initialize, tool events, usage, idle and clean shutdown', async mode => {
    const root = await mkdtemp(resolve('node_modules/dshc-official-profile-'))
    await writeFile(join(root, 'fixture.txt'), 'profile-fixture')
    const requests: Record<string, unknown>[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', data => { body += String(data) })
      req.on('end', () => {
        requests.push(JSON.parse(body))
        const tool = requests.length === 1 ? { name: 'read', arguments: JSON.stringify({ file_path: 'fixture.txt' }) }
          : requests.length === 2 ? { name: 'write', arguments: JSON.stringify({ file_path: 'fixture.txt', content: 'changed' }) } : undefined
        const delta = tool ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: tool }] } : { content: 'profile-complete' }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No address')
    const runtime = new HarnessRuntime({ workspace: root, activityTimeoutMs: 20_000, preferences: { runtime: 'dsh-profile', dshProfile: 'sdk', mode, replyLanguage: 'zh-CN', style: 'explanatory' },
      env: { DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`, DSHC_DSH_EXECUTABLE: executable, DSH_HOME: join(root, 'home'), DSH_TELEMETRY_MODE: 'DISABLED' } })
    try {
      const metadata = await runtime.start()
      expect(metadata.profile?.cliVersion).toBe(TESTED_PROFILE_VERSION)
      const result = await runtime.run('Exercise the fixture tools')
      expect(result.projection.lastTurnError).toBeUndefined()
      expect(result.finalResponse).toBe('profile-complete')
      expect(result.events.some(event => event.kind === 'assistant-message' && event.usage !== undefined)).toBe(true)
      expect(await readFile(join(root, 'fixture.txt'), 'utf8')).toBe(mode === 'code' ? 'changed' : 'profile-fixture')
      expect(JSON.stringify(requests[0]?.['messages'])).toContain('Reply in zh-CN')
      expect(result.events.filter(event => event.kind === 'tool-result' && event.isError)).toHaveLength(mode === 'code' ? 0 : 1)
    } finally {
      await runtime.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(root, { recursive: true, force: true })
    }
  }, 35_000)
})
