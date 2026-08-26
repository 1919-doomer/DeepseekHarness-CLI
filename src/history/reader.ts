import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence, { type JsonlCompression } from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  diagnosticHistorySummary,
  historySearchText,
  projectHistorySession,
} from './projection.js'
import type {
  HistoryCatalog,
  HistoryListQuery,
  HistoryReader,
  HistorySessionDetail,
} from './types.js'

export const DEFAULT_HISTORY_LIMIT = 200
export const MAX_HISTORY_LIMIT = 500
const INSPECTION_CONCURRENCY = 4

export interface JsonlHistoryReaderOptions {
  root?: string
  compression?: JsonlCompression
  env?: NodeJS.ProcessEnv
}

export class JsonlHistoryReader implements HistoryReader {
  readonly root: string
  readonly compression: JsonlCompression

  constructor(options: JsonlHistoryReaderOptions = {}) {
    const resolved = resolveHistoryStore(options.env ?? process.env)
    this.root = resolve(options.root ?? resolved.root)
    this.compression = options.compression ?? resolved.compression
  }

  async list(query: HistoryListQuery, signal?: AbortSignal): Promise<HistoryCatalog> {
    const workspace = resolve(query.workspace)
    const allWorkspaces = query.allWorkspaces === true
    const limit = clampLimit(query.limit)
    const needle = query.text?.trim().toLocaleLowerCase('en-US')

    return this.withBackend(async (backend) => {
      const snapshots = await backend.listSnapshots(signal)
      const { inScope, candidates } = selectHistorySnapshots(snapshots, workspace, allWorkspaces, limit)
      const diagnostics: string[] = []
      const inspected = await mapLimit(candidates, INSPECTION_CONCURRENCY, async (snapshot) => {
        let detail: HistorySessionDetail
        try {
          const inspection = await backend.inspect(snapshot.header.id, signal)
          detail = projectHistorySession(inspection.meta, inspection.events)
        } catch (error) {
          // Cancellation is lifecycle control (Ctrl+C/EOF/view replacement),
          // never evidence that a durable session is corrupt. Preserve it so
          // callers can stop promptly and do not render hundreds of false
          // metadata-only diagnostics after an abort.
          if (isAbort(error, signal)) throw error
          const message = `Session ${String(snapshot.header.id)} could not be inspected: ${errorMessage(error)}`
          diagnostics.push(message)
          detail = {
            summary: diagnosticHistorySummary(snapshot.header, errorMessage(error)),
            messages: [],
            approvals: [],
            tools: [],
            eventCount: 0,
            droppedMessageCount: 0,
          } satisfies HistorySessionDetail
        }
        return {
          summary: detail.summary,
          matches: needle === undefined || needle.length === 0 || historySearchText(detail.summary, detail).includes(needle),
        }
      })
      const sessions = inspected
        .filter(item => item.matches)
        .map(item => item.summary)
      return {
        root: this.root,
        workspace,
        allWorkspaces,
        totalSnapshots: snapshots.length,
        matchingSnapshots: inScope.length,
        inspectedSnapshots: candidates.length,
        omittedSnapshots: Math.max(0, inScope.length - candidates.length),
        sessions,
        diagnostics,
      }
    })
  }

  async inspect(sessionId: string, signal?: AbortSignal): Promise<HistorySessionDetail> {
    if (sessionId.trim().length === 0) throw new Error('history session id must not be empty')
    return this.withBackend(async (backend) => {
      const inspection = await backend.inspect(SessionId(sessionId), signal)
      return projectHistorySession(inspection.meta, inspection.events)
    })
  }

  private async withBackend<T>(
    action: (backend: JsonlSessionPersistence) => Promise<T>,
  ): Promise<T> {
    const ctx = new Context()
    const sessions = ctx.plugin(SessionStore)
    await sessions
    const persistence = ctx.plugin(JsonlSessionPersistence, {
      root: this.root,
      compression: this.compression,
      preparedSessionCacheSize: 1,
    })
    try {
      await persistence
      return await action(ctx.sessionPersistence as JsonlSessionPersistence)
    } finally {
      await persistence.dispose()
      await sessions.dispose()
    }
  }
}

export function resolveHistoryStore(env: NodeJS.ProcessEnv = process.env): {
  root: string
  compression: JsonlCompression
} {
  const home = env.DSH_HOME ?? env.HOME ?? env.USERPROFILE ?? process.cwd()
  return {
    root: env.DSH_SESSION_ROOT ?? resolve(home, 'sessions', 'dshc'),
    compression: env.DSH_SNAPSHOT === undefined ? 'zstd' : 'none',
  }
}

export function selectHistorySnapshots(
  snapshots: readonly SessionPersistenceSnapshot[],
  workspace: string,
  allWorkspaces: boolean,
  limit = DEFAULT_HISTORY_LIMIT,
): { inScope: SessionPersistenceSnapshot[]; candidates: SessionPersistenceSnapshot[] } {
  const boundedLimit = clampLimit(limit)
  const inScope = snapshots
    .filter(item => allWorkspaces || sameWorkspace(item.header.cwd, resolve(workspace)))
    .sort((left, right) => right.header.createdAt - left.header.createdAt)
  return { inScope, candidates: inScope.slice(0, boundedLimit) }
}

function sameWorkspace(candidate: string | undefined, workspace: string): boolean {
  if (candidate === undefined || !isAbsolute(candidate)) return false
  const delta = relative(resolve(candidate), workspace)
  return delta.length === 0
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('history limit must be a positive safe integer')
  return Math.min(value, MAX_HISTORY_LIMIT)
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: values.length })
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await action(values[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR'
}
