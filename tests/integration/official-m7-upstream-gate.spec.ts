import { JsonRpcLineTransport, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { M7_UPSTREAM_GATE } from '../../src/capabilities.js'
import { TESTED_DSH_BASELINE } from '../../src/upstream/compatibility.js'
import { resolveRuntimeLaunch } from '../../src/upstream/runtime-launcher.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('official M7.4 SDK extension gate', () => {
  it('captures initialize and the closed extension router from the real pinned server wire', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m74-wire-'))
    tempRoots.push(root)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: join(root, '.dsh-home'),
      DSH_SESSION_ROOT: join(root, '.dsh-sessions'),
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
    }
    delete env.DEEPSEEK_API_KEY
    const launch = await resolveRuntimeLaunch({
      workspace: root,
      env,
      requestTimeoutMs: 10_000,
      shutdownTimeoutMs: 2_000,
      disposeEofGraceMs: 2_000,
      disposeGraceMs: 2_000,
    })
    const child = spawn(launch.command, launch.args ?? [], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const serverRequests: string[] = []
    const transport = new JsonRpcLineTransport(child.stdout, child.stdin)
    transport.onRequest(async method => {
      serverRequests.push(method)
      return { outcome: 'unavailable' }
    })
    transport.start()

    try {
      const initialized = await transport.request('initialize', {
        cwd: root,
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
      }, AbortSignal.timeout(10_000))
      expect(initialized).toEqual({
        serverInfo: {
          name: TESTED_DSH_BASELINE.serverName,
          version: M7_UPSTREAM_GATE.wireProtocolVersion,
        },
      })

      let extensionFailure: unknown
      try {
        await transport.request('dshc/capabilities', {}, AbortSignal.timeout(5_000))
      } catch (error) {
        extensionFailure = error
      }
      expect(extensionFailure).toBeInstanceOf(JsonRpcResponseError)
      const responseError = extensionFailure as JsonRpcResponseError
      expect(responseError.code).toBe(-32603)
      expect(responseError.message).toBe(
        'unknown DeepSeek Harness SDK runtime method: dshc/capabilities',
      )
      expect(serverRequests).toEqual([])

      await transport.request('shutdown', {}, AbortSignal.timeout(5_000))
      await waitForExit(child, 5_000)
      expect(child.exitCode).toBe(0)
      expect(stderr).toBe('')
    } finally {
      transport.close()
      if (child.exitCode === null) {
        child.kill('SIGTERM')
        await waitForExit(child, 5_000).catch(() => undefined)
      }
    }
  }, 30_000)
})

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return
  await Promise.race([
    once(child, 'exit').then(() => undefined),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Harness child did not exit within ${timeoutMs}ms`)), timeoutMs)
      timer.unref()
    }),
  ])
}
