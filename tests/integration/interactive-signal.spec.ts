import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const fixturePath = fileURLToPath(new URL('../fixtures/interactive-signal-fixture.ts', import.meta.url))
const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const posixIt = process.platform === 'win32' ? it.skip : it

describe('interactive signal lifecycle', () => {
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    posixIt(`${signal} during an active turn closes the whole runtime and exits ${exitCode}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'dshc-m2-signal-'))
      tempRoots.push(root)
      const child = spawn(process.execPath, ['--import', 'tsx/esm', fixturePath], {
        env: {
          ...process.env,
          DSHC_SIGNAL_WORKSPACE: root,
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
        child.stdin.write('wait for signal\n')
        await waitFor(() => stdout.includes('user> wait for signal'), 5_000)
        expect(child.kill(signal)).toBe(true)

        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }))
        })
        expect(exit).toEqual({ code: exitCode, signal: null })
        expect(stderr).toContain('closes the entire Harness runtime')
        expect(stderr).toContain('no prompt-level cancel')
        expect(stderr).not.toContain('cancelled')
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    }, 15_000)
  }
})

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`)
}
