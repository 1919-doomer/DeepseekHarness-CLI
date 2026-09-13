import { mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { HarnessRuntime } from '../src/upstream/runtime.js'
import { runTerminalProduct } from '../src/terminal/product.js'

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this smoke fixture inside a real PTY/ConPTY')
const workspace = await mkdtemp(resolve('node_modules/dshc-pty-'))
const env = { ...process.env, DSHC_FAKE_MODE: process.env.DSHC_PTY_MODE ?? 'markdown', DSHC_FAKE_LOG: join(workspace, 'prompts.jsonl') }
const runtime = new HarnessRuntime({ workspace, skipInstalledVersionCheck: true, launchOverride: {
  command: process.execPath, args: [resolve('tests/fixtures/fake-runtime.mjs')], cwd: workspace, env,
} })
try {
  const result = await runTerminalProduct(runtime, { preferences: { locale: 'en', animation: process.env.DSHC_PTY_NO_ANIMATION !== '1' } })
  console.log(`PTY smoke exited ${result.exitCode}; raw=${process.stdin.isRaw}; turns=${result.totalTurns}`)
} finally { await runtime.close(); await rm(workspace, { recursive: true, force: true }) }
if (process.env.DSHC_PTY_DIAGNOSTICS === '1') {
  await new Promise(resolve => setTimeout(resolve, 100))
  console.log(JSON.stringify({ resources: process.getActiveResourcesInfo(), flowing: process.stdin.readableFlowing,
    readable: process.stdin.listenerCount('readable'), data: process.stdin.listenerCount('data'), beforeExit: process.listenerCount('beforeExit'),
    output: { size: process.stdout.writableLength, drain: process.stdout.writableNeedDrain, resize: process.stdout.listenerCount('resize') } }))
}
