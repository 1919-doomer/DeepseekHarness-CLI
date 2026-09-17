import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

export interface Question { id: string; title: string; options: { label: string; description?: string; recommended?: boolean }[] }
export type InteractionContent = { kind: 'questions'; questions: Question[] } | { kind: 'plan'; title: string; text: string }
export type InteractionRequest = InteractionContent & { id: string; sessionId: string; callId: string }
export interface InteractionAnswer { action: 'submit' | 'skip' | 'implement' | 'revise' | 'defer'; answers?: { id: string; option?: number; text: string }[]; text?: string }

/** Private first-party UI channel; never shares the SDK stdout transport. */
export class InteractionBridge {
  readonly id = randomUUID()
  private token = randomBytes(32).toString('hex')
  private server?: Server
  private roots = new Set<string>()
  private seen = new Set<string>()
  private calls = new Map<string, string>()
  private callWaiters = new Map<string, () => void>()
  private listeners = new Set<() => void>()
  private pending?: { request: InteractionRequest; response: ServerResponse; started: number }
  private waited = 0
  ready = false
  /** Endpoint the runtime published for step-targeted injection, when mounted. */
  private steering: { url: string; token: string } | undefined
  get canSteer(): boolean { return this.steering !== undefined }
  get current(): InteractionRequest | undefined { return this.pending?.request }
  get waitingMs(): number { return this.waited + (this.pending ? performance.now() - this.pending.started : 0) }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { for (const listener of this.listeners) listener() }
  begin(sessionId: string): void { if (!this.roots.size) { this.seen.clear(); this.calls.clear() }; this.roots.add(sessionId) }
  expectCall(sessionId: string, callId: string, name: string): void {
    if (!this.roots.has(sessionId) || !['request_user_input', 'present_plan'].includes(name) || this.calls.size >= 1024) return
    const key = `${sessionId}:${callId}`; this.calls.set(key, name); this.callWaiters.get(key)?.()
  }
  private async observedCall(key: string, response: ServerResponse): Promise<string | undefined> {
    if (this.calls.has(key)) return this.calls.get(key)
    if (this.callWaiters.size) return undefined
    await new Promise<void>(resolve => {
      const finish = (): void => { clearTimeout(timer); this.callWaiters.delete(key); response.off('close', finish); resolve() }
      const timer = setTimeout(finish, 1500)
      this.callWaiters.set(key, finish); response.once('close', finish)
    })
    return this.calls.get(key)
  }
  end(sessionId: string): void { this.roots.delete(sessionId); if (this.current?.sessionId === sessionId) this.cancel() }
  async start(): Promise<NodeJS.ProcessEnv> {
    this.server = createServer((req, res) => {
      const reject = (status: number): void => { res.writeHead(status); res.end() }
      if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${this.token}` || req.headers.origin) { reject(403); req.resume(); return }
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 96 * 1024) req.destroy(); else chunks.push(chunk) })
      req.on('error', () => { if (!res.writableEnded) res.destroy() })
      req.on('end', async () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          if (value['runtimeId'] !== this.id) { reject(409); return }
          if (req.url === '/ready') { this.ready = true; res.end('{}'); this.emit(); return }
          if (req.url === '/steering') {
            const steerUrl = value['steerUrl'], steerToken = value['steerToken']
            if (typeof steerUrl !== 'string' || typeof steerToken !== 'string' || !steerUrl.startsWith('http://127.0.0.1:')) { reject(400); return }
            this.steering = { url: steerUrl, token: steerToken }
            res.end('{}'); this.emit(); return
          }
          if (req.url !== '/request') { reject(404); return }
          const sessionId = value['sessionId'], callId = value['callId']
          if (typeof sessionId !== 'string' || !this.roots.has(sessionId) || typeof callId !== 'string' || callId.length > 256 || this.pending || this.seen.has(callId) || this.seen.size >= 1024) { reject(409); return }
          const content = validateInteraction(value['content'])
          const tool = await this.observedCall(`${sessionId}:${callId}`, res)
          if (!this.roots.has(sessionId) || res.destroyed || this.pending || this.seen.has(callId) || tool !== (content.kind === 'plan' ? 'present_plan' : 'request_user_input')) { reject(409); return }
          this.seen.add(callId)
          this.pending = { request: { ...content, id: randomUUID(), sessionId, callId }, response: res, started: performance.now() }
          res.on('close', () => { if (this.pending?.response === res) this.clear() })
          this.emit()
        } catch { reject(400) }
      })
    })
    this.server.requestTimeout = 15_000 // bounds upload, not time spent answering
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve) })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Cannot bind interaction channel')
    return { DSHC_INTERACTION_URL: `http://127.0.0.1:${address.port}`, DSHC_INTERACTION_TOKEN: this.token, DSHC_INTERACTION_ID: this.id }
  }
  answer(id: string, answer: InteractionAnswer): boolean {
    const pending = this.pending
    if (!pending || pending.request.id !== id) return false
    validateAnswer(pending.request, answer)
    pending.response.setHeader('content-type', 'application/json')
    pending.response.end(JSON.stringify(answer))
    this.clear()
    return true
  }
  /**
   * Put a message into the turn already running on `sessionId`.
   *
   * Lands at the next step boundary, never mid-step, and never cancels work in
   * flight: whatever the model has already produced is kept. Rejects rather
   * than silently downgrading to a next-turn queue, because the terminal has
   * told the reader which of the two happened and must not be made to lie.
   */
  async steer(sessionId: string, text: string): Promise<void> {
    const steering = this.steering
    if (steering === undefined) throw new Error('This runtime does not expose steering; the message can only be queued for the next turn.')
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(`${steering.url}/steer`, {
        method: 'POST',
        headers: { authorization: `Bearer ${steering.token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(5_000),
      }, response => {
        response.resume()
        if (response.statusCode === 200) resolve()
        else if (response.statusCode === 404) reject(new Error('That session is no longer running, so there is nothing to steer.'))
        else reject(new Error(`Steering was refused (${response.statusCode}).`))
      })
      req.on('error', reject)
      req.end(JSON.stringify({ runtimeId: this.id, sessionId, text }))
    })
  }
  cancel(): void { if (this.pending) { this.pending.response.destroy(); this.clear() } }
  private clear(): void { if (this.pending) this.waited += performance.now() - this.pending.started; this.pending = undefined; this.emit() }
  async close(): Promise<void> {
    this.cancel(); this.roots.clear(); this.ready = false; this.steering = undefined
    for (const finish of this.callWaiters.values()) finish()
    const server = this.server; this.server = undefined
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
  }
}

export function validateInteraction(value: unknown): InteractionContent {
  const data = value as Record<string, unknown> | null
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
  if (data?.['kind'] === 'plan' && text(data['title'], 200) && text(data['text'], 64_000)) return { kind: 'plan', title: data['title'], text: data['text'] }
  if (data?.['kind'] !== 'questions' || !Array.isArray(data['questions']) || data['questions'].length < 1 || data['questions'].length > 3) throw new Error('Expected 1–3 questions')
  const ids = new Set<string>()
  for (const q of data['questions']) {
    if (!q || !text(q.id, 64) || ids.has(q.id) || !text(q.title, 2000) || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 5) throw new Error('Invalid question')
    ids.add(q.id)
    for (const o of q.options) if (!o || !text(o.label, 200) || (o.description !== undefined && !text(o.description, 1000)) || (o.recommended !== undefined && typeof o.recommended !== 'boolean')) throw new Error('Invalid option')
  }
  return { kind: 'questions', questions: data['questions'] }
}
function validateAnswer(request: InteractionRequest, answer: InteractionAnswer): void {
  if (JSON.stringify(answer).length > 64_000) throw new Error('Answer too long')
  if (request.kind === 'plan') {
    if (!['implement', 'revise', 'defer'].includes(answer.action)) throw new Error('Invalid plan action')
    return
  }
  if (answer.action === 'skip') return
  if (answer.action !== 'submit' || answer.answers?.length !== request.questions.length) throw new Error('Answer every question')
  for (const [index, q] of request.questions.entries()) {
    const a = answer.answers[index]!
    if (a.id !== q.id || typeof a.text !== 'string' || (a.option === undefined ? !a.text.trim() : !Number.isInteger(a.option) || a.option < 0 || a.option >= q.options.length)) throw new Error('Invalid answer')
  }
}
