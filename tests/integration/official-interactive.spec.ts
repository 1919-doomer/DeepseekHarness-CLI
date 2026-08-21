import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DSHC_VERSION } from '../../src/version.js'

const cliPath = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url))
const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('official DeepSeek Harness interactive CLI', () => {
  it('keeps one published Harness runtime/session alive across two built dshc turns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m2-official-'))
    tempRoots.push(root)
    const modelRequests: Record<string, unknown>[] = []
    let replyIndex = 0

    const modelServer = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        if (body.length > 0) modelRequests.push(JSON.parse(body) as Record<string, unknown>)
        replyIndex++
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n')
        response.write(`data: {"choices":[{"delta":{"content":"m2-turn-${replyIndex}"}}]}\n\n`)
        response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n')
        response.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>((resolve, reject) => {
      modelServer.once('error', reject)
      modelServer.listen(0, '127.0.0.1', resolve)
    })
    const address = modelServer.address()
    if (address === null || typeof address === 'string') throw new Error('mock model server did not bind a TCP port')

    const child = spawn(
      process.execPath,
      [
        cliPath,
        '--interactive',
        '--workspace', root,
        '--session', 'm2-official-session',
        '--max-tokens', '128',
      ],
      {
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'dshc-m2-smoke-no-real-call',
          DSH_SESSION_ROOT: join(root, '.dsh-sessions'),
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.stdin.end('first official turn\nsecond official turn\n/exit\n')

    try {
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve({ code, signal }))
      })

      expect(exit).toEqual({ code: 0, signal: null })
      expect(stderr).toBe('')
      // The banner carries the product name and the shipped version, not an
      // internal milestone label.
      expect(stdout).toContain(`DeepSeek Harness Console ${DSHC_VERSION}`)
      expect(stdout).toContain('user> first official turn')
      expect(stdout).toContain('assistant> m2-turn-1')
      expect(stdout).toContain('user> second official turn')
      expect(stdout).toContain('assistant> m2-turn-2')
      expect(modelRequests).toHaveLength(2)

      const firstMessages = Array.isArray(modelRequests[0]?.messages) ? modelRequests[0].messages : []
      const secondMessages = Array.isArray(modelRequests[1]?.messages) ? modelRequests[1].messages : []
      expect(secondMessages.length).toBeGreaterThan(firstMessages.length)
    } finally {
      child.kill()
      await new Promise<void>(resolve => modelServer.close(() => resolve()))
    }
  }, 40_000)
})
