import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { toolProjectionKey } from '../../src/session/projection.js'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

const fakeRuntimePath = fileURLToPath(new URL('../fixtures/fake-runtime.mjs', import.meta.url))
const tempRoots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshc-m1-'))
  tempRoots.push(root)
  return root
}

function runtimeFor(
  root: string,
  mode: string,
  extraEnv: NodeJS.ProcessEnv = {},
  activityTimeoutMs = 1_000,
): HarnessRuntime {
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
    launchOverride: fakeLaunch(root, env),
  })
}

function runtimeWithEnvironmentPatch(
  root: string,
  optionsEnv: NodeJS.ProcessEnv,
  launchEnv: NodeJS.ProcessEnv,
): HarnessRuntime {
  return new HarnessRuntime({
    workspace: root,
    env: optionsEnv,
    skipInstalledVersionCheck: true,
    activityTimeoutMs: 1_000,
    launchOverride: fakeLaunch(root, launchEnv),
  })
}

function fakeLaunch(root: string, env: NodeJS.ProcessEnv) {
  return {
    command: process.execPath,
    args: [fakeRuntimePath],
    cwd: root,
    env,
    requestTimeoutMs: 500,
    shutdownTimeoutMs: 100,
    disposeEofGraceMs: 250,
    disposeGraceMs: 250,
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('HarnessRuntime fake-process integration', () => {
  it('runs receipt -> faithful multi-step/session-tree events -> root idle -> clean shutdown', async () => {
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
      expect(result.projection.rootSessionId).toBe('main')
      expect(result.projection.lastAssistantMessage).toBe('hello')
      expect(result.projection.lastTurnError).toBeUndefined()
      expect(result.projection.tools.get(toolProjectionKey('main', 'call-1'))).toMatchObject({
        sessionId: 'main',
        name: 'read',
        result: 'README content',
      })
      expect(result.projection.tools.get(toolProjectionKey('child-1', 'call-1'))).toMatchObject({
        sessionId: 'child-1',
        name: 'child-read',
        result: 'child result',
      })
      expect(result.projection.subagents.get('child-1')).toMatchObject({
        status: 'finished',
        provider: 'spawn',
      })
      expect(result.notifications.some(item => item.params.sessionId === 'unrelated-session')).toBe(false)
      expect(result.events.map(event => event.sequence)).toEqual(
        result.events.map((_event, index) => index),
      )
      expect(result.events.some(event => event.kind === 'assistant-message'
        && event.sessionId === 'child-1'
        && event.text === 'child')).toBe(true)
      expect(result.events.some(event => event.kind === 'assistant-delta'
        && event.text === 'private-reasoning-must-not-render')).toBe(false)

      const rootAssistantMessageIndex = result.events.findIndex(event =>
        event.kind === 'assistant-message' && event.sessionId === 'main' && event.text === 'working')
      const rootToolCallIndex = result.events.findIndex(event =>
        event.kind === 'tool-call' && event.sessionId === 'main')
      expect(rootAssistantMessageIndex).toBeGreaterThanOrEqual(0)
      expect(rootToolCallIndex).toBeGreaterThan(rootAssistantMessageIndex)
    } finally {
      await runtime.close()
    }
  })

  it('gives receipt-to-idle a fresh activity timeout window', async () => {
    const root = await workspace()
    const runtime = runtimeFor(root, 'slow-receipt-turn', {}, 80)
    try {
      await runtime.start()
      const startedAt = Date.now()
      const result = await runtime.run('slow but valid', { sessionId: 'main' })
      expect(result.finalResponse).toBe('hello')
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90)
    } finally {
      await runtime.close()
    }
  })

  it('rejects concurrent same-session activity while preserving sequential and cross-session use', async () => {
    const root = await workspace()
    const promptLog = join(root, 'prompts.jsonl')
    const runtime = runtimeFor(root, 'slow-receipt-turn', { DSHC_FAKE_LOG: promptLog })
    try {
      const first = runtime.run('first', { sessionId: 'shared' })
      await waitFor(async () => (await promptSessions(promptLog)).length === 1)
      await expect(runtime.run('overlap', { sessionId: 'shared' })).rejects.toThrow(
        /already has an active request/i,
      )
      await expect(first).resolves.toMatchObject({ sessionId: 'shared', finalResponse: 'hello' })

      await expect(runtime.run('sequential', { sessionId: 'shared' })).resolves.toMatchObject({
        sessionId: 'shared',
        finalResponse: 'hello',
      })
      await expect(Promise.all([
        runtime.run('left', { sessionId: 'left' }),
        runtime.run('right', { sessionId: 'right' }),
      ])).resolves.toEqual([
        expect.objectContaining({ sessionId: 'left', finalResponse: 'hello' }),
        expect.objectContaining({ sessionId: 'right', finalResponse: 'hello' }),
      ])
      expect(await promptSessions(promptLog)).toEqual(['shared', 'shared', 'left', 'right'])
    } finally {
      await runtime.close()
    }
  })

  it('does not resurrect a child when close races a pending start', async () => {
    const root = await workspace()
    const lifecycleLog = join(root, 'lifecycle.jsonl')
    const runtime = runtimeFor(root, 'slow-initialize', { DSHC_FAKE_LIFECYCLE_LOG: lifecycleLog })

    const start = runtime.start()
    await waitFor(async () => (await lifecycleEvents(lifecycleLog)).includes('initialize-request'))

    const firstClose = runtime.close()
    const secondClose = runtime.close()
    expect(secondClose).toBe(firstClose)

    await expect(firstClose).resolves.toBeUndefined()
    await expect(start).rejects.toBeInstanceOf(Error)
    expect(runtime.metadata).toBeUndefined()
    await expect(runtime.start()).rejects.toMatchObject({ code: 'runtime' })
    await expect(runtime.close()).resolves.toBeUndefined()

    await waitFor(async () => (await lifecycleEvents(lifecycleLog)).includes('process-exit'))
    const events = await lifecycleEvents(lifecycleLog)
    expect(events).toContain('initialize-request')
    expect(events).toContain('process-exit')
    expect(events.filter(event => event === 'process-exit')).toHaveLength(1)
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
      await expect(runtime.run('unsafe reuse', { sessionId: 'main' })).rejects.toThrow(
        /previous request ended without an observed idle state/i,
      )
      await expect(runtime.run('wait forever', { sessionId: 'other', activityTimeoutMs: 80 })).rejects.toThrow(
        /no prompt-level cancel/i,
      )
    } finally {
      await runtime.close()
    }
  })

  it('redacts a secret inherited from process.env even when options.env is only a patch', async () => {
    const root = await workspace()
    const secret = 'parent-secret-1234'
    const previous = process.env.DEEPSEEK_API_KEY
    process.env.DEEPSEEK_API_KEY = secret
    const optionsEnv = { DSHC_FAKE_MODE: 'early-exit' }
    const launchEnv = { ...process.env, ...optionsEnv, DSH_CWD: root }
    const runtime = runtimeWithEnvironmentPatch(root, optionsEnv, launchEnv)

    try {
      await expectRedactedTransportFailure(runtime, secret)
    } finally {
      await runtime.close().catch(() => undefined)
      restoreEnv('DEEPSEEK_API_KEY', previous)
    }
  })

  it('redacts a secret supplied by the incremental options.env patch', async () => {
    const root = await workspace()
    const secret = 'options-secret-1234'
    const optionsEnv = { DSHC_FAKE_MODE: 'early-exit', DEEPSEEK_API_KEY: secret }
    const launchEnv = { ...process.env, ...optionsEnv, DSH_CWD: root }
    const runtime = runtimeWithEnvironmentPatch(root, optionsEnv, launchEnv)
    try {
      await expectRedactedTransportFailure(runtime, secret)
    } finally {
      await runtime.close().catch(() => undefined)
    }
  })

  it('redacts a secret supplied only by launchOverride.env', async () => {
    const root = await workspace()
    const secret = 'override-secret-1234'
    const optionsEnv = { DSHC_FAKE_MODE: 'early-exit' }
    const launchEnv = {
      ...process.env,
      DSHC_FAKE_MODE: 'early-exit',
      DEEPSEEK_API_KEY: secret,
      DSH_CWD: root,
    }
    const runtime = runtimeWithEnvironmentPatch(root, optionsEnv, launchEnv)
    try {
      await expectRedactedTransportFailure(runtime, secret)
    } finally {
      await runtime.close().catch(() => undefined)
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

async function expectRedactedTransportFailure(runtime: HarnessRuntime, secret: string): Promise<void> {
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
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function lifecycleEvents(path: string): Promise<string[]> {
  try {
    const text = await readFile(path, 'utf8')
    return text.trim().length === 0
      ? []
      : text.trim().split('\n').map(line => (JSON.parse(line) as { event: string }).event)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function promptSessions(path: string): Promise<string[]> {
  try {
    const text = await readFile(path, 'utf8')
    return text.trim().length === 0
      ? []
      : text.trim().split('\n').map(line => (JSON.parse(line) as { sessionId: string }).sessionId)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`)
}
