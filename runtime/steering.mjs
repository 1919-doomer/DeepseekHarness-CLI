import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { modeState, WORK_MODES } from './mode-state.mjs'
import { planGate } from './plan-gate.mjs'

/**
 * Steering: put a message into the running turn rather than the next one.
 *
 * `session/prompt` is the only way in over protocol 0.0.1 and it is hardwired
 * to `agent.followup()`, which targets the next *turn* — so anything typed
 * while the model is working waits for it to finish. `agent.steer()` targets
 * the next *step*, and the loop will not end a turn while step-targeted inbox
 * items are pending, so the message joins the work already in progress.
 *
 * That capability is in-process only, which is why this is a runtime-side
 * plugin rather than terminal code. It is the same private, token-authenticated
 * localhost channel the interaction bridge already uses, pointed the other way:
 * the terminal calls in, instead of the runtime calling out.
 *
 * Steering lands at the next step boundary, never mid-step. Nothing here
 * cancels work in flight; tokens already produced are kept.
 *
 * The same authenticated channel carries mode switches (`/mode`), which is the
 * other thing that used to need a new process.
 */
export const name = 'dshc-steering'
export const inject = ['agents']

const MAX_STEER_CHARS = 16_000

export async function apply(ctx) {
  const url = process.env.DSHC_INTERACTION_URL
  const token = process.env.DSHC_INTERACTION_TOKEN
  const runtimeId = process.env.DSHC_INTERACTION_ID
  if (!url || !token || !runtimeId) return

  const steerToken = randomBytes(32).toString('hex')
  const server = createServer((req, res) => {
    const reject = (status) => { res.writeHead(status); res.end(); req.resume() }
    // Same posture as the interaction bridge: loopback only, POST only, bearer
    // token, and no browser-originated request is ever served.
    if (req.method !== 'POST' || req.headers.authorization !== `Bearer ${steerToken}` || req.headers.origin) { reject(403); return }
    if (req.url !== '/steer' && req.url !== '/mode') { reject(404); return }
    let size = 0
    const chunks = []
    req.on('data', chunk => { size += chunk.length; if (size > 64 * 1024) req.destroy(); else chunks.push(chunk) })
    req.on('error', () => { if (!res.writableEnded) res.destroy() })
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (body.runtimeId !== runtimeId) { reject(409); return }
        if (req.url === '/mode') {
          // Switching modes used to mean a new process and so a new session.
          // It is now a value the live policy reads; see mode-state.mjs.
          if (typeof body.mode !== 'string' || !WORK_MODES.includes(body.mode)) { reject(400); return }
          const changed = modeState.set(body.mode)
          // A plan approved in plan mode covers the turn that implements it, so
          // switching to code for a handoff must not demand it be restated. The
          // seed survives exactly one turn start, then the gate is back to normal.
          if (typeof body.seedPlanFor === 'string' && body.seedPlanFor.length > 0 && body.seedPlanFor.length <= 256) {
            planGate.seed(body.seedPlanFor)
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ changed, mode: modeState.get() }))
          return
        }
        const sessionId = body.sessionId
        const text = body.text
        if (typeof sessionId !== 'string' || typeof text !== 'string' || text.length === 0 || text.length > MAX_STEER_CHARS) { reject(400); return }
        // An agent id is the identity its session shares, so the terminal's
        // session id addresses it directly. A disposed or unknown session is
        // reported rather than silently dropped, because the terminal has
        // already told the reader their message went somewhere.
        const agent = ctx.agents.get(sessionId)
        if (!agent) { reject(404); return }
        agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end('{}')
      } catch { reject(400) }
    })
  })

  server.requestTimeout = 5000
  server.headersTimeout = 5000
  // Steering must never be the reason the runtime stays alive.
  server.unref()

  const endpoint = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { reject(new Error('No steering endpoint')); return }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })

  ctx.effect(() => () => { server.closeAllConnections?.(); server.close() })

  // Hand the endpoint to the terminal over the channel it already trusts.
  // Best effort on purpose: steering is an optional convenience, and a terminal
  // that cannot register it falls back to queueing for the next turn. Letting a
  // registration failure propagate would make an optional feature able to stop
  // the runtime from starting at all — which is exactly what it did the first
  // time this ran against a terminal that did not yet serve the endpoint.
  try {
    await register()
  } catch (error) {
    process.stderr.write(`dshc-steering: not available (${error instanceof Error ? error.message : String(error)})
`)
    server.closeAllConnections?.()
    server.close()
  }

  function register() {
   return new Promise((resolve, reject) => {
    const req = httpRequest(`${url}/steering`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    }, res => { res.resume(); res.statusCode === 200 ? resolve() : reject(new Error(`steering registration failed (${res.statusCode})`)) })
    req.on('error', reject)
    req.end(JSON.stringify({ runtimeId, steerUrl: endpoint, steerToken }))
   })
  }
}
