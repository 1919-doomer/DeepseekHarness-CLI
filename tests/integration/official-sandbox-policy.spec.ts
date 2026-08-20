import { spawn } from 'node:child_process'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const cliEntry = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url))
const tempRoots: string[] = []

interface ToolStep {
  name: string
  arguments: Record<string, unknown>
}

const FIXTURE = 'fixture.txt'

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('M4.3 published Harness workspace sandbox', () => {
  it('allows repository work but denies outside writes and unavailable escalation', async () => {
    // workspace-write intentionally grants the platform temp roots in addition
    // to the repository. Put this fixture under the checked-out repository so
    // its sibling escape targets are outside BOTH the session workspace and
    // `/tmp` / os.tmpdir(); otherwise the test would be asserting against an
    // upstream-documented writable root rather than an actual policy escape.
    const parent = await mkdtemp(join(process.cwd(), '.dshc-m4-sandbox-'))
    tempRoots.push(parent)
    const repository = join(parent, 'repo')
    const stateRoot = join(parent, 'state')
    await Promise.all([mkdir(repository, { recursive: true }), mkdir(stateRoot, { recursive: true })])
    await writeFile(join(repository, FIXTURE), 'alpha\n', 'utf8')

    const outsideFs = join(parent, 'outside-fs.txt')
    const outsideShell = join(parent, 'outside-shell.txt')
    const outsideEscalated = join(parent, 'outside-escalated.txt')
    const shell = process.platform === 'win32' ? 'pwsh' : 'bash'

    const steps: ToolStep[] = [
      { name: 'read', arguments: { file_path: FIXTURE } },
      {
        name: 'edit',
        arguments: { file_path: FIXTURE, old_string: 'alpha', new_string: 'beta' },
      },
      {
        name: 'write',
        arguments: { file_path: '../outside-fs.txt', content: 'must-not-exist' },
      },
      {
        name: shell,
        arguments: process.platform === 'win32'
          ? {
              command: "Set-Content -NoNewline -Path 'shell-inside.txt' -Value 'inside-ok'; Get-Content -Raw 'shell-inside.txt'",
              description: 'Write and verify a file inside the repository',
            }
          : {
              command: "printf 'inside-ok' > 'shell-inside.txt' && cat 'shell-inside.txt'",
              description: 'Write and verify a file inside the repository',
            },
      },
      {
        name: shell,
        arguments: process.platform === 'win32'
          ? {
              command: "Set-Content -NoNewline -Path '..\\outside-shell.txt' -Value 'must-not-exist'",
              description: 'Attempt an outside-workspace write without escalation',
            }
          : {
              command: "printf 'must-not-exist' > '../outside-shell.txt'",
              description: 'Attempt an outside-workspace write without escalation',
            },
      },
      {
        name: shell,
        arguments: process.platform === 'win32'
          ? {
              command: "Set-Content -NoNewline -Path '..\\outside-escalated.txt' -Value 'must-not-exist'",
              description: 'Attempt an outside-workspace write with explicit escalation',
              sandbox_permissions: 'danger-full-access',
              justification: 'Security regression test: this must fail because no upstream approval answerer exists.',
            }
          : {
              command: "printf 'must-not-exist' > '../outside-escalated.txt'",
              description: 'Attempt an outside-workspace write with explicit escalation',
              sandbox_permissions: 'danger-full-access',
              justification: 'Security regression test: this must fail because no upstream approval answerer exists.',
            },
      },
    ]

    const requests: Record<string, unknown>[] = []
    const stub = await startSequenceServer(steps, requests, 'sandbox-policy-complete')

    try {
      const result = await runProcess(
        process.execPath,
        [
          cliEntry,
          '--model',
          'deepseek-v4-flash',
          '--activity-timeout-ms',
          '40000',
          'Exercise the workspace-write security regression sequence and report completion.',
        ],
        {
          ...process.env,
          DEEPSEEK_API_KEY: 'dshc-keyless-sandbox-e2e',
          DEEPSEEK_BASE_URL: stub.baseUrl,
          DSH_HOME: stateRoot,
          DSH_SESSION_ROOT: join(stateRoot, 'sessions'),
        },
        repository,
      )

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('sandbox-policy-complete')
      expect(await readFile(join(repository, FIXTURE), 'utf8')).toBe('beta\n')
      expect(await readFile(join(repository, 'shell-inside.txt'), 'utf8')).toContain('inside-ok')
      await expect(pathExists(outsideFs)).resolves.toBe(false)
      await expect(pathExists(outsideShell)).resolves.toBe(false)
      await expect(pathExists(outsideEscalated)).resolves.toBe(false)
      expect(requests).toHaveLength(steps.length + 1)

      const first = requests[0] ?? {}
      expect(shellSchemaSupportsEscalation(first, shell)).toBe(true)

      const history = JSON.stringify(requests.at(-1)?.['messages'] ?? [])
      expect(history).toContain('workspace-write')
      expect(history.toLowerCase()).toContain('sandbox')
      expect(history.toLowerCase()).toMatch(/denied|approval|unavailable|reject/)
    } finally {
      await closeServer(stub.server)
    }
  }, 60_000)
})

function shellSchemaSupportsEscalation(request: Record<string, unknown>, shell: string): boolean {
  const tools = request['tools']
  if (!Array.isArray(tools)) return false
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue
    const fn = (tool as Record<string, unknown>)['function']
    if (fn === null || typeof fn !== 'object') continue
    const record = fn as Record<string, unknown>
    if (record['name'] !== shell) continue
    return JSON.stringify(record['parameters'] ?? {}).includes('sandbox_permissions')
  }
  return false
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function startSequenceServer(
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
        if (step === undefined) respondWithText(response, finalText)
        else respondWithToolCall(response, `sandbox-tool-${attempt + 1}`, step.name, JSON.stringify(step.arguments))
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
  if (address === null || typeof address === 'string') throw new Error('sandbox model stub did not bind')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

function respondWithToolCall(response: ServerResponse, id: string, name: string, args: string): void {
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

function respondWithText(response: ServerResponse, text: string): void {
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

function openSse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.flushHeaders()
}

function writeSse(response: ServerResponse, payload: unknown): void {
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
