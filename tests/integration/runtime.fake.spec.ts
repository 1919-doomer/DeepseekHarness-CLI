import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

const fakeRuntimePath = fileURLToPath(new URL('../fixtures/fake-runtime.mjs', import.meta.url))
const tempRoots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshc-m1-'))
  tempRoots.push(root)
  return root
}

function runtimeFor(root: string, mode: string, extraEnv: NodeJS.ProcessEnv = {}, activityTimeoutMs = 1_000): HarnessRuntime {
  const env = {
    ...process.env,
    ...extraEnv,
    DSHC_FAKE_MODE: mode,
  }
  return new HarnessRuntime({
    workspace: root,
    env,
    skipInstalledVersionCheck: true,
    activityTimeoutMs,
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

describe('HarnessRuntime fake-process integration', () => {
  it('runs receipt -> ordered events -> idle -> clean shutdown', async () => {
    const root = await workspace()
    const runtime = runtimeFor(root, 'success')
    try {
      const metadata = await runtime.start()
      expect(metadata).toMatchObject({
        serverName: 'deepseek-harness-sdk-runtime',
        protocolVersion: '0.0.1',
        workspace: root,
      })

      const result = await runtime.run('hello', { sessionId: 'main' })
      expect(result.messageId).toBe('msg-1')
      expect(result.finalResponse).toBe('hello')
      expect(result.projection.lastAssistantMessage).toBe('hello')
      expect(result.projection.lastTurnError).toBeUndefined()
      expect(result.projection.tools.get('call-1')).toMatchObject({
        name: 'read',
        result: 'README content',
      })
      expect(result.projection.subagents.get('child-1')).toMatchObject({
        status: 'finished',
        provider: 'spawn',
      })
      expect(result.notifications.some(item => item.params.sessionId === 'unrelated-session')).toBe(false)
      expect(result.events.map(event => event.sequence)).toEqual(
        result.events.map((_event, index) => index),
      )
      expect(result.events.some(event => event.kind === 'assistant-delta' && event.text === 'private-reasoning-must-not-render')).toBe(false)
    } finally {
      await runtime.close()
    }
  })

  it('fails loudly on an unsupported runtime protocol identity', async () => {
    const root = await workspace()
    const runtime = runtimeFor(root, 'bad-version')
    await expect(runtime.start()).rejects.toMatchObject({ code: 'compatibility' })
    await runtime.close()
  })

  it('classifies malformed initialize responses as protocol failures', async () => {
    const root = await workspace()
    const runtime = runtimeFor(root, 'malformed-initialize')
    await expect(runtime.start()).rejects.toMatchObject({ code: 'protocol' })
    await runtime.close()
  })

  it('times out an activity without pretending prompt-level cancellation exists', async () => {
    const root = await workspace()
    const runtime = runtimeFor(root, 'hang-activity', {}, 80)
    try {
      await runtime.start()
      await expect(runtime.run('wait forever', { sessionId: 'main' })).rejects.toMatchObject({
        code: 'activity-timeout',
      })
      await expect(runtime.run('wait forever', { sessionId: 'other', activityTimeoutMs: 80 })).rejects.toThrow(
        /no prompt-level cancel/i,
      )
    } finally {
      await runtime.close()
    }
  })

  it('redacts secrets from a crashed child stderr tail', async () => {
    const root = await workspace()
    const secret = 'super-secret-1234'
    const runtime = runtimeFor(root, 'early-exit', { DEEPSEEK_API_KEY: secret })
    try {
      await runtime.start()
      let failure: unknown
      try {
        await runtime.run('crash', { sessionId: 'main' })
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ code: 'transport-closed' })
      const message = failure instanceof Error ? failure.message : String(failure)
      expect(message).not.toContain(secret)
      expect(message).toContain('[REDACTED]')
    } finally {
      await runtime.close()
    }
  })

  it('bounds shutdown even when protocol shutdown never answers', async () => {
    const root = await workspace()
    const runtime = runtimeFor(root, 'hang-shutdown')
    await runtime.start()
    await runtime.run('complete before shutdown', { sessionId: 'main' })
    await expect(runtime.close()).resolves.toBeUndefined()
  })
})
