import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { saveCrashReport } from '../../src/terminal/crash-guard.js'
import { renderSessionLogs } from '../../src/cli/logs.js'
import {
  decodeSessionLog,
  defaultSessionRoot,
  listSessionLogs,
} from '../../src/upstream/session-log.js'

const line = (seq: number, type: string, data: unknown = {}) =>
  `${JSON.stringify({ event: { seq, type, time: 1787474868428, data } })}\n`

/** Persistence appends one zstd frame per write, so a file is a stream of them. */
function framed(...groups: string[]): Buffer {
  return Buffer.concat(groups.map(group => zstdCompressSync(Buffer.from(group, 'utf8'))))
}

async function sessionRoot(files: Record<string, Buffer | string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshc-logs-'))
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, contents)
  }
  return root
}

describe('session log decoding', () => {
  it('reads a stream of zstd frames, not just the first one', () => {
    // zstdDecompressSync stops after one frame, which is why a naive read of a
    // 3,110-frame session returned a single line.
    const read = decodeSessionLog(framed(line(1, 'turn/start'), line(2, 'assistant/chunk'), line(3, 'turn/end')))
    expect(read.events).toHaveLength(3)
    expect(read.events.map(event => event.type)).toEqual(['turn/start', 'assistant/chunk', 'turn/end'])
  })

  it('reads a plain log too, since compression is configurable', () => {
    const read = decodeSessionLog(Buffer.from(line(1, 'turn/start') + line(2, 'turn/end'), 'utf8'))
    expect(read.events).toHaveLength(2)
    expect(read.endedCleanly).toBe(true)
  })

  it('calls a log that stops mid-turn what it is', () => {
    // The signature of a killed process: the last record is a chunk, and no
    // turn/end was ever written.
    const read = decodeSessionLog(framed(line(1, 'turn/start'), line(2, 'assistant/chunk')))
    expect(read.endedCleanly).toBe(false)
    expect(read.lastEventType).toBe('assistant/chunk')
  })

  it('does not call an aborted turn clean just because turn/end was written', () => {
    // A runtime disposed out from under a running turn still writes turn/end.
    // Reporting that as clean hides the exact class of failure this exists for.
    const read = decodeSessionLog(framed(
      line(1, 'step/end', { turn: 1, step: 24 }),
      line(2, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }),
    ))
    expect(read.endedCleanly).toBe(false)
    expect(read.outcome).toBe('aborted (disposed)')
  })

  it('treats a completed turn as completed', () => {
    const read = decodeSessionLog(framed(line(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } })))
    expect(read.endedCleanly).toBe(true)
    expect(read.outcome).toBeUndefined()
  })

  it('degrades rather than inventing a verdict on an unfamiliar shape', () => {
    const read = decodeSessionLog(framed(line(1, 'turn/end', { turn: 1, reason: 'a string upstream never sent before' })))
    expect(read.endedCleanly).toBe(true)
    expect(read.outcome).toBeUndefined()
  })

  it('counts a half-written record instead of throwing on it', () => {
    const read = decodeSessionLog(Buffer.from(`${line(1, 'turn/end')}{"event":{"seq":2,`, 'utf8'))
    expect(read.truncated).toBe(1)
    expect(read.events).toHaveLength(1)
  })

  it('keeps the events it can read when a frame is unreadable', () => {
    const corrupt = Buffer.concat([framed(line(1, 'turn/start')), Buffer.from([0x28, 0xB5, 0x2F, 0xFD, 0x00])])
    expect(decodeSessionLog(corrupt).events).toHaveLength(1)
  })

  it('mirrors the session root the shipped composition computes', () => {
    expect(defaultSessionRoot({ DSH_SESSION_ROOT: '/explicit' })).toBe('/explicit')
    expect(defaultSessionRoot({ DSH_HOME: '/home' })).toBe('/home/sessions/dshc')
    expect(defaultSessionRoot({ USERPROFILE: 'C:/u' })).toBe('C:/u/sessions/dshc')
  })
})

describe('listing and reporting sessions', () => {
  it('finds sessions under every workspace, newest first', async () => {
    const root = await sessionRoot({
      'ws-a/session-aaa/session.jsonl.zstd': framed(line(1, 'turn/end')),
      'ws-b/session-bbb/session.jsonl': line(1, 'turn/end'),
    })
    const listed = await listSessionLogs(root)
    expect(listed.map(entry => entry.id).sort()).toEqual(['session-aaa', 'session-bbb'])
  })

  it('returns nothing rather than throwing when the root does not exist', async () => {
    expect(await listSessionLogs(join(tmpdir(), 'dshc-absent-root-xyz'))).toEqual([])
  })

  it('flags the cut session in the listing', async () => {
    const root = await sessionRoot({
      'ws/session-clean/session.jsonl.zstd': framed(line(1, 'turn/end')),
      'ws/session-cut/session.jsonl.zstd': framed(line(1, 'assistant/chunk')),
    })
    const { text } = await renderSessionLogs({ root })
    expect(text).toContain('ended: clean')
    expect(text).toContain('CUT at assistant/chunk')
  })

  it('selects by any unique substring, because ids are prefixed with session-', async () => {
    const root = await sessionRoot({ 'ws/session-b2ad0003/session.jsonl.zstd': framed(line(9, 'turn/end')) })
    const { text, exitCode } = await renderSessionLogs({ root, selector: 'b2ad0003' })
    expect(exitCode).toBe(0)
    expect(text).toContain('turn/end')
  })

  it('reports ambiguity rather than picking one', async () => {
    const root = await sessionRoot({
      'ws/session-dupe-1/session.jsonl.zstd': framed(line(1, 'turn/end')),
      'ws/session-dupe-2/session.jsonl.zstd': framed(line(1, 'turn/end')),
    })
    const { text, exitCode } = await renderSessionLogs({ root, selector: 'dupe' })
    expect(exitCode).toBe(1)
    expect(text).toContain('longer prefix')
  })

  it('filters to one event type', async () => {
    const root = await sessionRoot({
      'ws/session-f/session.jsonl.zstd': framed(line(1, 'tool/call'), line(2, 'assistant/chunk'), line(3, 'turn/end')),
    })
    const { text } = await renderSessionLogs({ root, selector: 'session-f', eventTypeFilter: 'tool/call' })
    expect(text).toContain('tool/call')
    expect(text).not.toContain('assistant/chunk')
  })
})

describe('crash reports on disk', () => {
  it('writes a report a closed terminal cannot take away', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dshc-crash-'))
    const written: Record<string, string> = {}
    const path = saveCrashReport({ directory, write: (at, body) => { written[at] = body } }, 'the reason')
    expect(path).toBeDefined()
    expect(written[path!]).toBe('the reason')
    expect(path).toContain('dshc-crash-')
  })

  it('returns undefined rather than replacing the crash with a write error', () => {
    const path = saveCrashReport({
      directory: join(tmpdir(), 'dshc-crash-unwritable'),
      write: () => { throw new Error('read-only volume') },
    }, 'the reason')
    expect(path).toBeUndefined()
  })
})
