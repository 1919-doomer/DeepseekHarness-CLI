import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NormalizedEvent } from '../session/projection.js'
import type { TranscriptBlock } from '../plugins/api.js'
import { sanitizeTerminalText } from './sanitize.js'

type WindowEntryKind = 'note' | 'user' | 'delta' | 'message' | 'message-end' | 'call' | 'result' | 'error' | 'finished'
interface WindowLog {
  token: string; title: string; entries: { sequence: number; text: string; kind: WindowEntryKind; title?: string }[]; bytes: number
  sequence: number; seenAt: number; connected: boolean; failed: boolean; ended: boolean; streaming: boolean
}
export interface AgentWindowLaunch { url: string; token: string; sessionId: string; locale: string }

/** A new visible console has its own capabilities, independent of a CI/pipe
 * environment inherited from the hidden launch helper. */
export function agentWindowEnvironment(options: AgentWindowLaunch, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent, TERM: 'xterm-256color', FORCE_COLOR: '3', DSHC_AGENT_COLOR: '1',
    DSHC_AGENT_NODE: process.execPath,
    DSHC_AGENT_VIEWER: fileURLToPath(new URL('../../runtime/agent-window.mjs', import.meta.url)),
    DSHC_AGENT_URL: options.url, DSHC_AGENT_TOKEN: options.token,
    DSHC_AGENT_SESSION: options.sessionId, DSHC_AGENT_LOCALE: options.locale }
  delete env.NO_COLOR
  return env
}

/** Displays existing child events only; never starts or controls an Agent. */
export class AgentWindows {
  private rooms = new Map<string, WindowLog>()
  private listeners = new Set<() => void>()
  private server?: Server
  private starting?: Promise<string>
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  constructor(readonly rootSessionId: string, readonly locale: string,
    private launch: (options: AgentWindowLaunch) => Promise<unknown> = launchPowerShellWindow) {}
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(): void { for (const listener of this.listeners) listener() }
  separated(sessionId?: string): boolean { return sessionId !== undefined && this.rooms.get(sessionId)?.connected === true }
  syncSeparated(target: Set<string>): void {
    for (const [id, room] of this.rooms) { if (room.connected) target.add(id); else target.delete(id) }
    while (target.size > 1024) target.delete(target.values().next().value!)
  }
  transcript(blocks: readonly TranscriptBlock[], separated: ReadonlySet<string> = new Set()): readonly TranscriptBlock[] {
    return blocks.filter(block => !this.separated(block.sessionId) && !separated.has(block.sessionId ?? '')).map(block => {
      if (block.kind === 'agent') {
        const room = this.rooms.get(block.text)
        if (room?.connected || separated.has(block.text)) return { ...block, title: this.locale === 'zh-CN' ? '子 Agent · 独立窗口' : 'Subagent · separate window', text: room?.title ?? block.text, detail: undefined }
        if (room?.failed) return { ...block, detail: this.locale === 'zh-CN' ? '窗口不可用，输出显示在主窗口' : 'Window unavailable; output shown here' }
      }
      if (block.kind === 'tool' && block.title === 'subagent' && block.state !== 'error' && (separated.size > 0 || [...this.rooms.values()].some(room => room.connected))) {
        return { ...block, text: this.locale === 'zh-CN' ? '已委派 · /agents 查看状态' : 'Delegated · /agents for status', detail: undefined }
      }
      return block
    })
  }
  observe(event: NormalizedEvent): void {
    if (this.closed) return
    if (event.kind === 'subagent-started') {
      if (event.childSessionId === this.rootSessionId || this.rooms.has(event.childSessionId) || this.rooms.size >= 32) return
      const room: WindowLog = { token: randomBytes(32).toString('hex'), title: event.childSessionId,
        entries: [], bytes: 0, sequence: 0, seenAt: Date.now(), connected: false, failed: false, ended: false, streaming: false }
      this.rooms.set(event.childSessionId, room)
      this.append(room, this.locale === 'zh-CN' ? '子 Agent 已启动\n' : 'Subagent started\n')
      void this.start().then(url => {
        if (!this.closed) return this.launch({ url, token: room.token, sessionId: event.childSessionId, locale: this.locale })
      }).catch(() => { room.failed = true; room.connected = false; this.changed() })
      return
    }
    const id = event.kind === 'subagent-finished' ? event.childSessionId : 'sessionId' in event ? event.sessionId : undefined
    const room = id === undefined ? undefined : this.rooms.get(id)
    if (!room) return
    const zh = this.locale === 'zh-CN'
    switch (event.kind) {
      case 'session-title': room.title = sanitizeTerminalText(event.title).slice(0, 200); break
      case 'user-message': this.append(room, event.text, 'user'); break
      case 'assistant-delta': room.streaming = true; this.append(room, event.text, 'delta'); break
      case 'assistant-message': this.append(room, room.streaming ? '' : event.text, room.streaming ? 'message-end' : 'message'); room.streaming = false; break
      case 'tool-call': this.append(room, event.arguments, 'call', event.name); break
      case 'tool-result': this.append(room, event.text, event.isError ? 'error' : 'result', event.name ?? (zh ? '工具结果' : 'Tool result')); break
      case 'turn-error': this.append(room, event.message, 'error', zh ? '任务异常' : 'Task error'); break
      case 'context-compacted': this.append(room, zh ? '\n上下文已压缩\n' : '\nContext compacted\n'); break
      case 'subagent-finished': room.ended = true; this.append(room, zh ? '子 Agent 已完成 · Enter 关闭窗口' : 'Subagent finished · Enter to close', 'finished'); break
    }
  }
  private append(room: WindowLog, text: string, kind: WindowEntryKind = 'note', title?: string): void {
    const safe = sanitizeTerminalText(text)
    const bounded = safe.length > 32_000 ? `${safe.slice(0, 32_000)}\n[… /trace]\n` : safe
    room.entries.push({ sequence: ++room.sequence, text: bounded, kind,
      ...(title === undefined ? {} : { title: sanitizeTerminalText(title).slice(0, 160) }) }); room.bytes += bounded.length
    while (room.bytes > 256_000 || room.entries.length > 512) room.bytes -= room.entries.shift()!.text.length
  }
  private start(): Promise<string> {
    if (this.starting) return this.starting
    this.starting = new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const room = [...this.rooms.values()].find(room => !room.failed && req.headers.authorization === `Bearer ${room.token}`)
        if (this.closed || req.method !== 'GET' || req.headers.origin || !room || (req.url?.length ?? 0) > 256) { res.writeHead(403).end(); return }
        let url: URL
        try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch { res.writeHead(400).end(); return }
        const after = Number(url.searchParams.get('after') ?? 0)
        if (url.pathname !== '/events' || !Number.isSafeInteger(after) || after < 0) { res.writeHead(400).end(); return }
        room.seenAt = Date.now()
        if (!room.connected) { room.connected = true; this.changed() }
        const entries = room.entries.filter(entry => entry.sequence > after)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ title: room.title, entries, ended: room.ended,
          truncated: after < (room.entries[0]?.sequence ?? 1) - 1 }))
      })
      this.server = server
      server.requestTimeout = 5000; server.headersTimeout = 5000; server.unref()
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        if (this.closed) { server.close(); reject(new Error('Window owner closed')); return }
        const address = server.address()
        if (!address || typeof address === 'string') { reject(new Error('No window endpoint')); return }
        this.timer = setInterval(() => {
          for (const room of this.rooms.values()) if (!room.failed && Date.now() - room.seenAt > 10_000) {
            room.connected = false; room.failed = true; this.changed()
          }
        }, 1000)
        this.timer.unref()
        resolve(`http://127.0.0.1:${address.port}/events`)
      })
    })
    return this.starting
  }
  close(): void {
    this.closed = true; clearInterval(this.timer)
    this.server?.closeAllConnections(); this.server?.close()
    this.listeners.clear(); this.rooms.clear()
  }
}

export async function launchPowerShellWindow(options: AgentWindowLaunch): Promise<number> {
  // No model/repository text is interpolated into PowerShell. Tokens stay in
  // inherited environment variables, never in command lines or temporary files.
  const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); & $env:DSHC_AGENT_NODE $env:DSHC_AGENT_VIEWER; exit"
  const command = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const launcher = `(Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Normal -ArgumentList @('-NoLogo', '-NoProfile', '-EncodedCommand', '${encoded}') -ErrorAction Stop -PassThru).Id`
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], shell: false,
      env: agentWindowEnvironment(options),
    })
    let output = ''
    child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-32) })
    const timer = setTimeout(() => { child.kill(); reject(new Error('PowerShell window launch timed out')) }, 10_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      const pid = Number(output.trim())
      if (code === 0 && Number.isSafeInteger(pid) && pid > 0) resolve(pid)
      else reject(new Error('PowerShell window launch failed'))
    })
  })
}
