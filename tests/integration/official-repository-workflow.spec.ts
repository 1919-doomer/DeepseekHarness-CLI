import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const cliEntry = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url))
const tempRoots: string[] = []

interface ToolStep {
  name: string
  arguments: Record<string, unknown>
  previousResultIncludes?: string
}

const FILE_NAME = 'fixture.txt'
const BEFORE = 'alpha needle\nsecond line\n'
const AFTER = 'beta needle\nsecond line\n'

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('M4.1 published Harness repository workflow', () => {
  it('reads, edits, searches, and verifies a repository from cwd without --workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dshc-m4-repo-'))
    tempRoots.push(parent)
    const repository = join(parent, 'repo')
    const stateRoot = join(parent, 'state')
    await import('node:fs/promises').then(({ mkdir }) => Promise.all([
      mkdir(repository, { recursive: true }),
      mkdir(stateRoot, { recursive: true }),
    ]))
    await writeFile(join(repository, FILE_NAME), BEFORE, 'utf8')

    const shellStep: ToolStep = process.platform === 'win32'
      ? {
          name: 'pwsh',
          arguments: {
            command: "Get-Content -Raw 'fixture.txt'",
            description: 'Verify edited repository fixture',
          },
          previousResultIncludes: 'beta needle',
        }
      : {
          name: 'bash',
          arguments: {
            command: "cat 'fixture.txt'",
            description: 'Verify edited repository fixture',
          },
          previousResultIncludes: 'beta needle',
        }

    const steps: ToolStep[] = [
      {
        name: 'read',
        arguments: { file_path: FILE_NAME },
      },
      {
        name: 'edit',
        arguments: {
          file_path: FILE_NAME,
          old_string: 'alpha needle',
          new_string: 'beta needle',
        },
        previousResultIncludes: 'alpha needle',
      },
      {
        name: 'grep',
        arguments: { pattern: 'beta needle', path: '.' },
        previousResultIncludes: 'updated successfully',
      },
      shellStep,
    ]

    const requests: Record<string, unknown>[] = []
    const stub = await startToolSequenceServer(steps, requests, 'repository-workflow-complete')

    try {
      const result = await runProcess(
        process.execPath,
        [
          cliEntry,
          '--model',
          'deepseek-v4-flash',
          '--activity-timeout-ms',
          '30000',
          'Inspect fixture.txt, change alpha to beta, search for the new text, verify it using the platform shell, then report completion.',
        ],
        {
          ...process.env,
          DEEPSEEK_API_KEY: 'dshc-keyless-repository-e2e',
          DEEPSEEK_BASE_URL: stub.baseUrl,
          DSH_HOME: stateRoot,
          DSH_SESSION_ROOT: join(stateRoot, 'sessions'),
        },
        repository,
      )

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('repository-workflow-complete')
      expect(await readFile(join(repository, FILE_NAME), 'utf8')).toBe(AFTER)
      expect(requests).toHaveLength(steps.length + 1)

      const firstToolNames = modelToolNames(requests[0] ?? {})
      expect(firstToolNames).toEqual(expect.arrayContaining([
        'read', 'write', 'edit', 'glob', 'grep', 'subagent', 'todo_write',
        process.platform === 'win32' ? 'pwsh' : 'bash',
      ]))
      expect(firstToolNames).not.toContain(process.platform === 'win32' ? 'bash' : 'pwsh')

      // State is explicitly redirected for hermetic CI. The repository itself
      // must contain only user/project files, not dshc-owned persistence.
      await expect(readFile(join(repository, '.sessions'), 'utf8')).rejects.toBeDefined()
      await expect(readFile(join(repository, '.dsh'), 'utf8')).rejects.toBeDefined()
    } finally {
      await closeServer(stub.server)
    }
  }, 45_000)
})

function modelToolNames(request: Record<string, unknown>): string[] {
  const tools = request['tools']
  if (!Array.isArray(tools)) return []
  return tools.flatMap(tool => {
    if (tool === null || typeof tool !== 'object') return []
    const fn = (tool as Record<string, unknown>)['function']
    if (fn === null || typeof fn !== 'object') return []
    const name = (fn as Record<string, unknown>)['name']
    return typeof name === 'string' ? [name] : []
  })
}

async function startToolSequenceServer(
  steps: ToolStep[],
  requests: Record<string, unknown>[],
  finalText: string,
): Promise<{ server: Server; baseUrl: string }> {
  let attempt = 0
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>
        requests.push(parsed)
        const step = steps[attempt]
        if (step !== undefined) {
          if (step.previousResultIncludes !== undefined) {
            const serializedMessages = JSON.stringify(parsed['messages'] ?? [])
            if (!serializedMessages.includes(step.previousResultIncludes)) {
              response.writeHead(500, { 'content-type': 'application/json' })
              response.end(JSON.stringify({
                error: {
                  message: `expected previous DSH tool result to include ${step.previousResultIncludes}`,
                  type: 'repository_e2e_sequence_error',
                },
              }))
              return
            }
          }
          respondWithToolCall(response, `m4-tool-${attempt + 1}`, step.name, JSON.stringify(step.arguments))
        } else {
          const serializedMessages = JSON.stringify(parsed['messages'] ?? [])
          if (!serializedMessages.includes('beta needle')) {
            response.writeHead(500, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ error: { message: 'final shell result missing edited text' } }))
            return
          }
          respondWithText(response, finalText)
        }
        attempt += 1
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: String(error) } }))
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('repository model stub did not bind')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

function respondWithToolCall(response: import('node:http').ServerResponse, id: string, name: string, args: string): void {
  const midpoint = Math.max(1, Math.floor(args.length / 2))
  openSse(response)
  writeSse(response, {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: args.slice(0, midpoint) },
        }],
      },
      finish_reason: null,
    }],
  })
  writeSse(response, {
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(midpoint) } }] },
      finish_reason: null,
    }],
  })
  writeSse(response, terminalChunk('tool_calls'))
  response.end('data: [DONE]\n\n')
}

function respondWithText(response: import('node:http').ServerResponse, text: string): void {
  openSse(response)
  writeSse(response, { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
  writeSse(response, terminalChunk('stop'))
  response.end('data: [DONE]\n\n')
}

function terminalChunk(reason: string): unknown {
  return {
    choices: [{ index: 0, delta: { content: '' }, finish_reason: reason }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  }
}

function openSse(response: import('node:http').ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.flushHeaders()
}

function writeSse(response: import('node:http').ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

async function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
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
