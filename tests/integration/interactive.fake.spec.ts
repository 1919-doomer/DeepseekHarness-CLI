import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runInteractiveLoop } from '../../src/cli/interactive.js'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

const fakeRuntimePath = fileURLToPath(new URL('../fixtures/fake-runtime.mjs', import.meta.url))
const tempRoots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshc-m2-'))
  tempRoots.push(root)
  return root
}

function runtimeFor(root: string, logPath: string): HarnessRuntime {
  const env = {
    ...process.env,
    DSHC_FAKE_MODE: 'success',
    DSHC_FAKE_LOG: logPath,
  }
  return new HarnessRuntime({
    workspace: root,
    env,
    skipInstalledVersionCheck: true,
    activityTimeoutMs: 1_000,
    launchOverride: {
      command: process.execPath,
      args: [fakeRuntimePath],
      cwd: root,
      env,
      requestTimeoutMs: 500,
      shutdownTimeoutMs: 100,
      disposeEofGraceMs: 250,
      disposeGraceMs: 250,
    },
  })
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('M2 interactive loop with fake Harness runtime', () => {
  it('reuses one session across turns and /new changes session without restarting runtime', async () => {
    const root = await workspace()
    const logPath = join(root, 'fake-prompts.jsonl')
    const runtime = runtimeFor(root, logPath)
    const input = Readable.from(['first turn\nsecond turn\n/new\nthird turn\n/exit\n'])
    const output = new PassThrough()
    let rendered = ''
    output.setEncoding('utf8')
    output.on('data', chunk => { rendered += String(chunk) })

    try {
      const result = await runInteractiveLoop(runtime, {
        input,
        output,
        error: output,
        terminal: false,
        installSignals: false,
        initialSessionId: 'session-first',
      })
      expect(result.exitCode).toBe(0)
      expect(result.totalTurns).toBe(3)
      expect(result.session.turnCount).toBe(1)
      expect(result.session.sessionGeneration).toBe(2)

      const records = (await readFile(logPath, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { sessionId: string })
      expect(records).toHaveLength(3)
      expect(records[0]?.sessionId).toBe('session-first')
      expect(records[1]?.sessionId).toBe('session-first')
      expect(records[2]?.sessionId).not.toBe('session-first')

      expect(rendered.match(/assistant> hello/g)).toHaveLength(3)
      expect(rendered).toContain('tool> read')
      expect(rendered).toContain('agent+')
      expect(rendered).not.toContain('private-reasoning-must-not-render')
    } finally {
      await runtime.close()
    }
  })
})
