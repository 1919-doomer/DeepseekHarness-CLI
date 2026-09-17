import { listSessionLogs, readSessionLog, type SessionLogEvent } from '../upstream/session-log.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'

/**
 * Read the session logs from the terminal that wrote them.
 *
 * The point is the `ended` column. A log whose last event is a chunk or a tool
 * call is a process that died rather than exited, and that is the difference
 * between "dshc closed" and "dshc was killed" — which no amount of staring at
 * a scrollback will tell you.
 */

export interface LogsOptions {
  root: string
  /** Session id, or a unique prefix of one. Absent lists recent sessions. */
  selector?: string | undefined
  limit?: number
  eventTypeFilter?: string | undefined
  json?: boolean
}

export async function renderSessionLogs(options: LogsOptions): Promise<{ text: string; exitCode: number }> {
  const sessions = await listSessionLogs(options.root, options.selector === undefined ? (options.limit ?? 20) : 500)
  if (sessions.length === 0) {
    return { text: `No session logs under ${safe(options.root)}\n`, exitCode: 1 }
  }

  if (options.selector === undefined) {
    const rows = await Promise.all(sessions.slice(0, options.limit ?? 20).map(async session => {
      const read = await readSessionLog(session.path).catch(() => undefined)
      return {
        id: session.id,
        workspace: session.workspace,
        modified: session.modified,
        bytes: session.bytes,
        events: read?.events.length ?? 0,
        ended: read === undefined ? 'unreadable' : read.endedCleanly ? 'clean' : read.outcome ?? `CUT at ${read.lastEventType ?? 'nothing'}`,
        truncated: read?.truncated ?? 0,
      }
    }))
    if (options.json === true) return { text: `${JSON.stringify(rows, undefined, 2)}\n`, exitCode: 0 }

    const lines = [`Session logs under ${safe(options.root)}`, '']
    for (const row of rows) {
      lines.push(`${row.modified.toISOString().slice(0, 19).replace('T', ' ')}  ${safe(row.id)}`)
      lines.push(`    ${row.events} events · ${row.bytes} bytes · ${safe(row.workspace)}`)
      // The whole reason this command exists.
      lines.push(`    ended: ${safe(row.ended)}${row.truncated > 0 ? ` · ${row.truncated} unparseable line(s)` : ''}`)
    }
    lines.push('', 'dshc logs <session-id>   show one session; --type <event/type> filters')
    return { text: `${lines.join('\n')}\n`, exitCode: 0 }
  }

  const selector = options.selector
  // Ids are `session-<hash>`, so a hash pasted from a log or a crash report
  // never matches as a prefix. Any unique substring selects; ambiguity is
  // reported rather than resolved by guessing.
  const matches = sessions.filter(session => session.id === selector || session.id.includes(selector))
  const session = matches[0]
  if (session === undefined) return { text: `No session matches ${safe(selector)}\n`, exitCode: 1 }
  if (matches.length > 1) {
    return { text: `${matches.length} sessions start with ${safe(selector)}; use a longer prefix\n`, exitCode: 1 }
  }

  const read = await readSessionLog(session.path)
  const shown = options.eventTypeFilter === undefined
    ? read.events
    : read.events.filter(event => event.type === options.eventTypeFilter)

  if (options.json === true) return { text: `${JSON.stringify(shown, undefined, 2)}\n`, exitCode: 0 }

  const lines = [
    `${safe(session.id)}  ${safe(session.workspace)}`,
    `${read.events.length} events · ended: ${read.endedCleanly ? 'clean' : safe(read.outcome ?? `CUT at ${read.lastEventType ?? 'nothing'}`)}`,
    ...(read.truncated > 0 ? [`${read.truncated} unparseable line(s) — a write cut off mid-record`] : []),
    '',
  ]
  for (const event of shown) lines.push(describeEvent(event))
  return { text: `${lines.join('\n')}\n`, exitCode: 0 }
}

function describeEvent(event: SessionLogEvent): string {
  const seq = event.seq === undefined ? '' : String(event.seq).padStart(7)
  const time = event.time === undefined ? '' : new Date(event.time).toISOString().slice(11, 23)
  const body = event.data === undefined ? '' : safe(JSON.stringify(event.data)).slice(0, 140)
  return `${seq} ${time} ${safe(event.type ?? 'unknown').padEnd(20)} ${body}`
}

function safe(value: string): string {
  return sanitizeTerminalText(value)
}
