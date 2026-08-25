import { Context } from '@deepseek-ai/cordis'
import {
  SessionId,
  type Session,
  default as SessionStore,
} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlHistoryReader, selectHistorySnapshots } from '../../src/history/reader.js'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('official JSONL history reader', () => {
  it('uses inspect/listSnapshots read-only and preserves the artifact byte-for-byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-history-reader-'))
    tempRoots.push(root)
    const workspace = resolve(root, 'workspace')
    const { artifact, sessionId } = await writeOfficialSession(root, workspace)
    const before = await sha256(artifact)

    const reader = new JsonlHistoryReader({ root, compression: 'none' })
    const catalog = await reader.list({ workspace })
    const detail = await reader.inspect(sessionId)
    const after = await sha256(artifact)

    expect(after).toBe(before)
    expect(catalog.sessions).toHaveLength(1)
    expect(catalog.sessions[0]).toMatchObject({ id: sessionId, provider: 'test-provider', model: 'test-model' })
    expect(detail.messages.map(message => message.text)).toEqual(['historical question', 'historical answer'])
    expect(detail.summary.contextWindow).toBe(8_192)
  })

  it('requires explicit cross-workspace scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-history-scope-'))
    tempRoots.push(root)
    const otherWorkspace = resolve(root, 'other-workspace')
    await writeOfficialSession(root, otherWorkspace)
    const reader = new JsonlHistoryReader({ root, compression: 'none' })

    expect((await reader.list({ workspace: resolve(root, 'current') })).sessions).toHaveLength(0)
    expect((await reader.list({ workspace: resolve(root, 'current'), allWorkspaces: true })).sessions).toHaveLength(1)
  })

  it('degrades a corrupt session to metadata without mutating its bytes or hiding healthy rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-history-corrupt-'))
    tempRoots.push(root)
    const workspace = resolve(root, 'workspace')
    const broken = await writeOfficialSession(root, workspace)
    await writeOfficialSession(root, workspace)
    const lines = (await readFile(broken.artifact, 'utf8')).split('\n')
    await writeFile(broken.artifact, `${lines[0]}\n{"not":"a valid event"}\n`, 'utf8')
    const before = await sha256(broken.artifact)

    const catalog = await new JsonlHistoryReader({ root, compression: 'none' }).list({ workspace })

    expect(await sha256(broken.artifact)).toBe(before)
    expect(catalog.sessions).toHaveLength(2)
    expect(catalog.sessions.some(session => session.diagnostic !== undefined)).toBe(true)
    expect(catalog.sessions.some(session => session.messageCount === 2)).toBe(true)
  })

  it('bounds a ten-thousand-session rebuild before any full inspections', () => {
    const workspace = resolve('C:\\workspace')
    const snapshots = Array.from({ length: 10_000 }, (_, index) => ({
      header: {
        version: 0,
        id: SessionId(`s-${index}`),
        cwd: workspace,
        createdAt: index,
      },
      revision: { dev: 1, ino: index + 1, size: 1, mtimeNs: 1n, ctimeNs: 1n },
    })) as unknown as SessionPersistenceSnapshot[]
    const selected = selectHistorySnapshots(snapshots, workspace, false)
    expect(selected.inScope).toHaveLength(10_000)
    expect(selected.candidates).toHaveLength(200)
    expect(String(selected.candidates[0]?.header.id)).toBe('s-9999')
  })
})

async function writeOfficialSession(root: string, workspace: string): Promise<{ artifact: string; sessionId: string }> {
  const ctx = new Context()
  const sessions = ctx.plugin(SessionStore)
  await sessions
  const persistence = ctx.plugin(JsonlSessionPersistence, {
    root,
    compression: 'none',
    packChunks: false,
    writeBatchMaxDelayMs: 10,
  })
  await persistence
  const sessionId = `history-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const session = ctx.sessions.create(SessionId(sessionId), { meta: { cwd: workspace } })
  appendCompletedTurn(session)
  await ctx.parallel('session/flush', session)
  const location = ctx.sessionPersistence.locate(session.header)
  if (location?.path === undefined) throw new Error('JSONL persistence did not return an artifact path')
  const artifact = location.path
  await persistence.dispose()
  await sessions.dispose()
  return { artifact, sessionId }
}

function appendCompletedTurn(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'historical question' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('request/header', {
    header: { config: { provider: 'test-provider', model: 'test-model' } },
    reason: 'initial',
  })
  session.append('request/context', {
    provider: 'test-provider',
    model: 'test-model',
    contextWindow: 8_192,
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: 'historical answer' }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
    usage: { inputTokens: 50, outputTokens: 4, cacheReadTokens: 100 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}
