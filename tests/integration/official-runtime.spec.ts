import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

const tempRoots: string[] = []
const cliEntry = fileURLToPath(new URL('../../src/cli/bin.ts', import.meta.url))

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('official DeepSeek Harness JSON-RPC runtime', () => {
  it('proves initialize -> prompt -> events -> idle -> shutdown without a real provider credential', async () => {
    const root = await testWorkspace()
    const modelRequests: Record<string, unknown>[] = []
    const stub = await startModelStub('m1-official-ok', modelRequests)

    const runtime = new HarnessRuntime({
      workspace: root,
      model: 'deepseek-v4-flash',
      maxTokens: 128,
      requestTimeoutMs: 10_000,
      activityTimeoutMs: 20_000,
      env: modelEnvironment(stub.baseUrl),
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
      await closeServer(stub.server)
    }
  }, 30_000)

  it('runs the actual dshc one-shot command through the published runtime', async () => {
    const root = await testWorkspace()
    const modelRequests: Record<string, unknown>[] = []
    const stub = await startModelStub('m1-cli-ok', modelRequests)

    try {
      const result = await runProcess(
        process.execPath,
        [
          '--import',
          'tsx',
          cliEntry,
          '--workspace',
          root,
          '--model',
          'deepseek-v4-flash',
          '--max-tokens',
          '64',
          '--activity-timeout-ms',
          '20000',
          'Reply with the CLI smoke-test marker.',
        ],
        modelEnvironment(stub.baseUrl),
      )

      expect(result.code).toBe(0)
      expect(result.stdout).toBe('assistant> m1-cli-ok\n')
      expect(result.stderr).toBe('')
      expect(modelRequests.length).toBeGreaterThanOrEqual(1)
    } finally {
      await closeServer(stub.server)
    }
  }, 30_000)
})

async function testWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshc-official-m1-'))
  tempRoots.push(root)
  return root
}

function modelEnvironment(baseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEEPSEEK_API_KEY: 'dshc-keyless-smoke-no-real-call',
    DEEPSEEK_BASE_URL: baseUrl,
  }
}

async function startModelStub(
  marker: string,
  requests: Record<string, unknown>[],
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      if (body.length > 0) requests.push(JSON.parse(body) as Record<string, unknown>)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n')
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: marker } }] })}\n\n`)
      response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n')
      response.end('data: [DONE]\n\n')
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock model server did not bind a TCP port')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

async function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => resolve({ code, stdout, stderr }))
  })
}
