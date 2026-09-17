import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/**
 * Read the durable session logs Harness writes, so a crash leaves something a
 * person can look at.
 *
 * Diagnosing the mid-answer crash meant hand-writing a frame splitter at a
 * shell prompt, because the logs are zstd and nothing shipped could read them.
 * Anything that takes a throwaway script to inspect will not be inspected when
 * it matters.
 *
 * dshc reads these as opaque records: an event has a `type`, a `seq` and a
 * `time`, and everything else stays whatever upstream wrote. No session schema
 * is interpreted here beyond those three fields.
 */

/** Session persistence writes one zstd frame per append, so a file is a stream of them. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

export interface SessionLogEvent {
  seq?: number
  type?: string
  time?: number
  data?: unknown
}

export interface SessionLogSummary {
  id: string
  /** Workspace directory as persistence named it; reported verbatim, never decoded. */
  workspace: string
  path: string
  modified: Date
  bytes: number
}

export interface SessionLogRead {
  events: readonly SessionLogEvent[]
  /** Lines that would not parse, which is what a killed process leaves behind. */
  truncated: number
  /** Whether the log ends on a completed turn rather than stopping mid-flight. */
  endedCleanly: boolean
  lastEventType?: string
}

/** Decode a whole log. Plain JSONL is accepted too, since compression is configurable. */
export function decodeSessionLog(raw: Buffer): SessionLogRead {
  const text = raw.subarray(0, 4).equals(ZSTD_MAGIC) ? decodeFrames(raw) : raw.toString('utf8')
  const events: SessionLogEvent[] = []
  let truncated = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as { event?: SessionLogEvent } & SessionLogEvent
      events.push(parsed.event ?? parsed)
    } catch {
      // A process killed mid-write leaves a partial line. That is a finding,
      // not a parse bug, so it is counted rather than thrown.
      truncated += 1
    }
  }
  const lastEventType = events.at(-1)?.type
  return {
    events,
    truncated,
    // A turn that ended wrote `turn/end`. Stopping on anything else — a chunk,
    // a tool call — is the signature of a process that died rather than exited.
    endedCleanly: lastEventType === undefined || TERMINAL_EVENTS.has(lastEventType),
    ...(lastEventType === undefined ? {} : { lastEventType }),
  }
}

const TERMINAL_EVENTS = new Set(['turn/end', 'session/end', 'session/closed'])

function decodeFrames(raw: Buffer): string {
  const parts: string[] = []
  let start = raw.indexOf(ZSTD_MAGIC)
  while (start >= 0) {
    const next = raw.indexOf(ZSTD_MAGIC, start + ZSTD_MAGIC.length)
    try {
      parts.push(zstdDecompressSync(raw.subarray(start, next < 0 ? raw.length : next)).toString('utf8'))
    } catch {
      // A frame cut off by a killed process cannot be decoded; earlier frames
      // still hold everything written before the moment that matters.
    }
    start = next
  }
  return parts.join('')
}

export async function readSessionLog(path: string): Promise<SessionLogRead> {
  return decodeSessionLog(await readFile(path))
}

/**
 * Default session root, mirroring the expression in `runtime/cordis.yml`. A
 * test asserts the two stay in step; they are the same deployment decision
 * written on both sides of the process boundary.
 */
export function defaultSessionRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME ?? env.HOME ?? env.USERPROFILE ?? process.cwd()
  return env.DSH_SESSION_ROOT ?? `${home}/sessions/dshc`
}

/** Every session under the root, newest first. Directory names stay verbatim. */
export async function listSessionLogs(root: string, limit = 20): Promise<readonly SessionLogSummary[]> {
  let workspaces: string[]
  try {
    workspaces = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }

  const found: SessionLogSummary[] = []
  for (const workspace of workspaces) {
    let sessions: string[]
    try {
      sessions = (await readdir(join(root, workspace), { withFileTypes: true }))
        .filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch { continue }

    for (const id of sessions) {
      for (const name of ['session.jsonl.zstd', 'session.jsonl']) {
        const path = join(root, workspace, id, name)
        try {
          const info = await stat(path)
          found.push({ id, workspace, path, modified: info.mtime, bytes: info.size })
          break
        } catch { /* the other spelling, or neither */ }
      }
    }
  }
  return found.sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, limit)
}
