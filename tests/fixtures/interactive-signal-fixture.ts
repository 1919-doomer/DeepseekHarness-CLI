import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInteractiveLoop } from '../../src/cli/interactive.js'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

const workspace = resolve(process.env.DSHC_SIGNAL_WORKSPACE ?? process.cwd())
const fakeRuntimePath = fileURLToPath(new URL('./fake-runtime.mjs', import.meta.url))
const env = {
  ...process.env,
  DSHC_FAKE_MODE: process.env.DSHC_SIGNAL_MODE ?? 'hang-activity',
}

const runtime = new HarnessRuntime({
  workspace,
  env,
  skipInstalledVersionCheck: true,
  activityTimeoutMs: 60_000,
  launchOverride: {
    command: process.execPath,
    args: [fakeRuntimePath],
    cwd: workspace,
    env,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    disposeEofGraceMs: 100,
    disposeGraceMs: 250,
  },
})

let exitCode = 1
try {
  const result = await runInteractiveLoop(runtime, {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    terminal: false,
    initialSessionId: 'session-signal',
  })
  exitCode = result.exitCode
} finally {
  await runtime.close().catch(() => undefined)
}

process.exitCode = exitCode
