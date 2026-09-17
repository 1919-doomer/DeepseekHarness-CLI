import { afterEach, describe, expect, it } from 'vitest'
import { InteractionBridge } from '../../src/upstream/interaction.js'

/**
 * Both halves of steering over the real loopback wire: the runtime plugin
 * registers its endpoint with the bridge, and the bridge calls back into it.
 * Only the Agent is faked — everything between the terminal and `agent.steer()`
 * is the code that ships.
 */
const bridges: InteractionBridge[] = []
const disposers: (() => void)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  await Promise.all(bridges.splice(0).map(bridge => bridge.close()))
})

interface SteeredMessage { content: { type: string; text: string }[]; source: { kind: string } }

async function mountedRuntime(options: { agent?: { steer: (message: SteeredMessage) => void } } = {}) {
  const bridge = new InteractionBridge()
  bridges.push(bridge)
  const env = await bridge.start()
  const previous = { ...process.env }
  Object.assign(process.env, env)
  disposers.push(() => { process.env = previous })

  const steered: SteeredMessage[] = []
  const agent = options.agent ?? { steer: (message: SteeredMessage) => { steered.push(message) } }
  const effects: (() => void)[] = []
  const ctx = {
    agents: { get: (id: string) => id === 'live-session' ? agent : undefined },
    effect: (factory: () => () => void) => { effects.push(factory()) },
  }

  // `apply` builds its own server per call, so one module instance is enough.
  const plugin = await import('../../runtime/steering.mjs') as { apply: (ctx: unknown) => Promise<void> }
  await plugin.apply(ctx)
  disposers.push(() => { for (const stop of effects) stop() })
  return { bridge, steered }
}

describe('steering into a running turn', () => {
  it('registers its endpoint, so the terminal knows the capability exists', async () => {
    const before = new InteractionBridge()
    bridges.push(before)
    await before.start()
    // Without the plugin mounted there is nothing to steer through, and the
    // terminal must fall back to the queue rather than claim otherwise.
    expect(before.canSteer).toBe(false)

    const { bridge } = await mountedRuntime()
    expect(bridge.canSteer).toBe(true)
  })

  it('delivers the message to the addressed agent as user content', async () => {
    const { bridge, steered } = await mountedRuntime()
    await bridge.steer('live-session', 'also update the README')
    expect(steered).toHaveLength(1)
    expect(steered[0]?.content).toEqual([{ type: 'text', text: 'also update the README' }])
    // It must arrive as the person speaking, not as a tool or a plugin.
    expect(steered[0]?.source.kind).toBe('user')
  })

  it('says the session is gone rather than dropping the message quietly', async () => {
    const { bridge, steered } = await mountedRuntime()
    await expect(bridge.steer('finished-session', 'too late')).rejects.toThrow(/no longer running/)
    expect(steered).toHaveLength(0)
  })

  it('refuses a caller without the token', async () => {
    const { bridge, steered } = await mountedRuntime()
    const endpoint = (bridge as unknown as { steering: { url: string } }).steering.url
    const response = await fetch(`${endpoint}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'live-session', text: 'unauthorized' }),
    })
    expect(response.status).toBe(403)
    expect(steered).toHaveLength(0)
  })

  it('refuses a browser-originated request even with the token', async () => {
    // Loopback ports are reachable from any page the reader happens to open.
    const { bridge, steered } = await mountedRuntime()
    const steering = (bridge as unknown as { steering: { url: string; token: string } }).steering
    const response = await fetch(`${steering.url}/steer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${steering.token}`,
        origin: 'https://example.invalid',
      },
      body: JSON.stringify({ runtimeId: bridge.id, sessionId: 'live-session', text: 'from a page' }),
    })
    expect(response.status).toBe(403)
    expect(steered).toHaveLength(0)
  })

  it('refuses an empty or oversized message', async () => {
    const { bridge, steered } = await mountedRuntime()
    await expect(bridge.steer('live-session', '')).rejects.toThrow()
    await expect(bridge.steer('live-session', 'x'.repeat(16_001))).rejects.toThrow()
    expect(steered).toHaveLength(0)
  })

  it('stops advertising steering once the bridge closes', async () => {
    const { bridge } = await mountedRuntime()
    await bridge.close()
    expect(bridge.canSteer).toBe(false)
  })
})
