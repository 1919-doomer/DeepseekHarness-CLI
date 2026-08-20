import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('../../src/cli/bin.ts', import.meta.url))
const tempRoots: string[] = []
const ALT_SCREEN_ON = '\u001B[?1049h'

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('M3 official DeepSeek Harness TTY product', () => {
  it.skipIf(process.platform !== 'linux')('runs two same-session turns and capability view through a real PTY', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m3-tui-'))
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
        response.write(`data: {"choices":[{"delta":{"content":"m3-tui-turn-${replyIndex}"}}]}\n\n`)
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

    const dshcCommand = [
      process.execPath,
      '--import', 'tsx/esm', cliPath,
      '--workspace', root,
      '--session', 'm3-official-session',
      '--max-tokens', '128',
    ].map(shellQuote).join(' ')
    const command = `stty rows 28 cols 96 raw -echo; exec ${dshcCommand}`

    const child = spawn('script', ['-q', '-e', '-f', '-c', command, '/dev/null'], {
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        DEEPSEEK_API_KEY: 'dshc-m3-smoke-no-real-call',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })

    try {
      await waitFor(() => stdout.includes(ALT_SCREEN_ON), 10_000, () => stdout)

      child.stdin.write('first tui turn\r')
      await waitFor(() => modelRequests.length >= 1, 15_000, () => stdout)
      await waitFor(() => stdout.includes('m3-tui-turn-1'), 15_000, () => stdout)

      child.stdin.write('second tui turn\r')
      await waitFor(() => modelRequests.length >= 2, 15_000, () => stdout)
      await waitFor(() => stdout.includes('m3-tui-turn-2'), 15_000, () => stdout)

      child.stdin.write('/plugins\r')
      await waitFor(() => stdout.includes('Capability Explorer'), 5_000, () => stdout)
      expect(stdout).toContain('partial/unavailable on SDK protocol 0.0.1')
      expect(stdout).toContain('prompt cancel: unavailable')
      expect(stdout).toContain('dshc.core@1.0.0')

      child.stdin.write('q')
      await new Promise(resolve => setTimeout(resolve, 100))
      child.stdin.write('/exit\r')
      child.stdin.end()

      const exit = await waitForExit(child, 15_000)
      expect(exit).toEqual({ code: 0, signal: null })
      expect(stderr).toBe('')
      expect(stdout).toContain('M3')
      expect(stdout).toContain('DeepSeek Harness Console')
      expect(stdout).toContain('first tui turn')
      expect(stdout).toContain('second tui turn')
      expect(modelRequests).toHaveLength(2)

      const firstMessages = Array.isArray(modelRequests[0]?.messages) ? modelRequests[0].messages : []
      const secondMessages = Array.isArray(modelRequests[1]?.messages) ? modelRequests[1].messages : []
      expect(secondMessages.length).toBeGreaterThan(firstMessages.length)
    } finally {
      child.kill()
      await new Promise<void>(resolve => modelServer.close(() => resolve()))
    }
  }, 60_000)
})

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  diagnostic: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for PTY output. Tail:\n${diagnostic().slice(-4_000)}`)
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`PTY child did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}
