import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

const tempRoots: string[] = []
const cliEntry = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url))

const EXPECTED_CODING_TOOLS = [
  'read',
  'write',
  'edit',
  'subagent',
  'todo_write',
] as const

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('official DeepSeek Harness JSON-RPC runtime', () => {
  it('proves initialize -> coding-capability request -> events -> idle -> shutdown without a real provider credential', async () => {
    const root = await testWorkspace()
    const modelRequests: Record<string, unknown>[] = []
    const stub = await startModelStub('m4-official-ok', modelRequests)

    const runtime = new HarnessRuntime({
      workspace: root,
      model: 'deepseek-v4-flash',
      maxTokens: 128,
      requestTimeoutMs: 10_000,
      activityTimeoutMs: 20_000,
      env: modelEnvironment(stub.baseUrl, root),
    })

    try {
      const metadata = await runtime.start()
      expect(metadata).toMatchObject({
        serverName: 'deepseek-harness-sdk-runtime',
        protocolVersion: '0.0.1',
        sdkVersion: '0.1.0-rc.8',
        runtimePackageVersion: '0.1.0-rc.8',
      })

      const result = await runtime.run('Reply with the smoke-test marker.', { sessionId: 'm4-smoke' })
      expect(result.finalResponse).toBe('m4-official-ok')
      expect(result.projection.activity).toBe('idle')
      expect(result.projection.lastTurnError).toBeUndefined()
      expect(modelRequests.length).toBeGreaterThanOrEqual(1)

      const firstRequest = requiredFirstRequest(modelRequests)
      expect(firstRequest).toMatchObject({
        model: 'deepseek-v4-flash',
        max_tokens: 128,
      })

      const toolNames = modelToolNames(firstRequest)
      expect(toolNames).toEqual(expect.arrayContaining([...EXPECTED_CODING_TOOLS]))
      expect(toolNames).toContain(process.platform === 'win32' ? 'pwsh' : 'bash')
      expect(toolNames).not.toContain(process.platform === 'win32' ? 'bash' : 'pwsh')
    } finally {
      await runtime.close()
      await closeServer(stub.server)
    }
  }, 30_000)

  it('runs the built dshc one-shot distribution entrypoint through the published coding runtime', async () => {
    const root = await testWorkspace()
    const modelRequests: Record<string, unknown>[] = []
    const stub = await startModelStub('m4-cli-ok', modelRequests)

    try {
      const result = await runProcess(
        process.execPath,
        [
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
        modelEnvironment(stub.baseUrl, root),
      )

      expect(result.code).toBe(0)
      expect(result.stdout).toBe('assistant> m4-cli-ok\n')
      expect(result.stderr).toBe('')
      expect(modelRequests.length).toBeGreaterThanOrEqual(1)
      expect(modelToolNames(requiredFirstRequest(modelRequests))).toEqual(
        expect.arrayContaining([...EXPECTED_CODING_TOOLS]),
      )
    } finally {
      await closeServer(stub.server)
    }
  }, 30_000)
})

async function testWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshc-official-m4-'))
  tempRoots.push(root)
  return root
}

function modelEnvironment(baseUrl: string, root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEEPSEEK_API_KEY: 'dshc-keyless-smoke-no-real-call',
    DEEPSEEK_BASE_URL: baseUrl,
    DSH_HOME: join(root, '.dsh-home'),
    DSH_SESSION_ROOT: join(root, '.dsh-sessions'),
  }
}

function requiredFirstRequest(requests: Record<string, unknown>[]): Record<string, unknown> {
  const first = requests[0]
  if (first === undefined) throw new Error('model stub did not receive a provider request')
  return first
}

function modelToolNames(request: Record<string, unknown>): string[] {
  const tools = request['tools']
  if (!Array.isArray(tools)) return []
  return tools.flatMap(tool => {
    if (tool === null || typeof tool !== 'object') return []
    const record = tool as Record<string, unknown>
    const fn = record['function']
    if (fn !== null && typeof fn === 'object') {
      const name = (fn as Record<string, unknown>)['name']
      return typeof name === 'string' ? [name] : []
    }
    const name = record['name']
    return typeof name === 'string' ? [name] : []
  })
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
