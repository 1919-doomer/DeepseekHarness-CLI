import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('official DeepSeek Harness JSON-RPC runtime', () => {
  it('proves initialize -> prompt -> events -> idle -> shutdown without a real provider credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-official-m1-'))
    tempRoots.push(root)
    const modelRequests: Record<string, unknown>[] = []

    const modelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        if (body.length > 0) modelRequests.push(JSON.parse(body) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n')
        response.write('data: {"choices":[{"delta":{"content":"m1-official-ok"}}]}\n\n')
        response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n')
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>((resolve, reject) => {
      modelServer.once('error', reject)
      modelServer.listen(0, '127.0.0.1', resolve)
    })
    const address = modelServer.address()
    if (address === null || typeof address === 'string') throw new Error('mock model server did not bind a TCP port')

    const runtime = new HarnessRuntime({
      workspace: root,
      model: 'deepseek-v4-flash',
      maxTokens: 128,
      requestTimeoutMs: 10_000,
      activityTimeoutMs: 20_000,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: 'dshc-keyless-smoke-no-real-call',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
    })

    try {
      const metadata = await runtime.start()
      expect(metadata).toMatchObject({
        serverName: 'deepseek-harness-sdk-runtime',
        protocolVersion: '0.0.1',
        sdkVersion: '0.1.0-rc.8',
        runtimePackageVersion: '0.1.0-rc.8',
      })

      const result = await runtime.run('Reply with the smoke-test marker.', { sessionId: 'm1-smoke' })
      expect(result.finalResponse).toBe('m1-official-ok')
      expect(result.projection.activity).toBe('idle')
      expect(result.projection.lastTurnError).toBeUndefined()
      expect(modelRequests.length).toBeGreaterThanOrEqual(1)
      expect(modelRequests[0]).toMatchObject({
        model: 'deepseek-v4-flash',
        max_tokens: 128,
      })
    } finally {
      await runtime.close()
      await new Promise<void>(resolve => modelServer.close(() => resolve()))
    }
  }, 30_000)
})
