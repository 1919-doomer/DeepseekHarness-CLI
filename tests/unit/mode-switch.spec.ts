import { afterEach, describe, expect, it } from 'vitest'
import { InteractionBridge } from '../../src/upstream/interaction.js'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
import { modeState } from '../../runtime/mode-state.mjs'
import { allowedToolsFor, modeContextText } from '../../runtime/mode-policy.mjs'

/**
 * Switching modes used to restart the runtime, and protocol 0.0.1 has no
 * session resume, so every /plan or /code threw the conversation away. These
 * cover the pieces that make a switch a value change instead.
 */

afterEach(() => { modeState.set('code') })

describe('what each mode permits', () => {
  it('leaves code mode unrestricted, for the plan gate to govern', () => {
    expect(allowedToolsFor('code', true)).toBeUndefined()
  })

  it('keeps plan mode read-only, with present_plan only when the channel exists', () => {
    const withChannel = allowedToolsFor('plan', true)
    expect([...withChannel!].sort()).toEqual(['glob', 'grep', 'present_plan', 'read', 'request_user_input'])
    expect(allowedToolsFor('plan', false)!.has('present_plan')).toBe(false)
  })

  it('never lets a read-only mode write', () => {
    for (const mode of ['plan', 'review', 'research']) {
      const allowed = allowedToolsFor(mode, true)!
      for (const tool of ['write', 'edit', 'pwsh', 'bash', 'subagent']) expect(allowed.has(tool)).toBe(false)
    }
  })

  it('gives research its web tools and nothing else extra', () => {
    const research = allowedToolsFor('research', true)!
    expect(research.has('web_search')).toBe(true)
    expect(allowedToolsFor('review', true)!.has('web_search')).toBe(false)
  })
})

describe('what the model is told', () => {
  it('names the current mode and says it replaces the earlier one', () => {
    // After a switch the conversation still contains the old mode's rules, so
    // the new snapshot has to say it supersedes them.
    for (const mode of ['code', 'plan', 'review', 'research']) {
      const text = modeContextText(mode, true)
      expect(text).toContain(`Current dshc work mode: ${mode}`)
      expect(text).toContain('replaces any earlier work mode')
    }
  })

  it('mentions outline_plan only when the tool can exist', () => {
    expect(modeContextText('code', true)).toContain('outline_plan')
    expect(modeContextText('code', false)).not.toContain('outline_plan')
  })

  it('carries no {{variable}} reference, which the prompt renderer treats as an error', () => {
    for (const mode of ['code', 'plan', 'review', 'research']) {
      expect(modeContextText(mode, true)).not.toContain('{{')
    }
  })
})

describe('the live mode value', () => {
  it('switches and tells its listeners', () => {
    const seen: string[] = []
    const stop = modeState.subscribe((mode, previous) => { seen.push(`${previous}->${mode}`) })
    expect(modeState.set('plan')).toBe(true)
    expect(modeState.get()).toBe('plan')
    stop()
    expect(seen).toEqual(['code->plan'])
  })

  it('reports a no-op instead of replaying listeners for it', () => {
    let calls = 0
    const stop = modeState.subscribe(() => { calls += 1 })
    expect(modeState.set('code')).toBe(false)
    stop()
    expect(calls).toBe(0)
  })

  it('refuses a mode that does not exist', () => {
    expect(() => modeState.set('danger')).toThrow(/Unknown dshc work mode/)
    expect(modeState.get()).toBe('code')
  })

  it('does not let one failing listener leave the others on the old mode', () => {
    // A half-applied switch is the worst available state for a permission.
    const reached: string[] = []
    const stopA = modeState.subscribe(() => { throw new Error('first listener broke') })
    const stopB = modeState.subscribe(mode => { reached.push(mode) })
    modeState.set('review')
    stopA(); stopB()
    expect(reached).toEqual(['review'])
  })
})

describe('switching over the real channel', () => {
  const bridges: InteractionBridge[] = []
  const disposers: (() => void)[] = []

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose()
    await Promise.all(bridges.splice(0).map(bridge => bridge.close()))
  })

  async function mounted(): Promise<InteractionBridge> {
    const bridge = new InteractionBridge()
    bridges.push(bridge)
    const env = await bridge.start()
    const previous = { ...process.env }
    Object.assign(process.env, env)
    disposers.push(() => { process.env = previous })
    const effects: (() => void)[] = []
    const plugin = await import('../../runtime/steering.mjs')
    await plugin.apply({ agents: { get: () => undefined }, effect: (factory: () => () => void) => { effects.push(factory()) } })
    disposers.push(() => { for (const stop of effects) stop() })
    return bridge
  }

  it('changes the runtime mode without a restart', async () => {
    const bridge = await mounted()
    expect(await bridge.setMode('plan')).toBe(true)
    expect(modeState.get()).toBe('plan')
    expect(await bridge.setMode('plan')).toBe(false)
  })

  it('rejects a mode the runtime does not know', async () => {
    const bridge = await mounted()
    await expect(bridge.setMode('danger')).rejects.toThrow(/refused/)
    expect(modeState.get()).toBe('code')
  })

  it('refuses anyone without the token', async () => {
    const bridge = await mounted()
    const endpoint = (bridge as unknown as { steering: { url: string } }).steering.url
    const response = await fetch(`${endpoint}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtimeId: bridge.id, mode: 'code' }),
    })
    expect(response.status).toBe(403)
  })

  it('says it cannot switch in place when the runtime has no channel', async () => {
    const bridge = new InteractionBridge()
    bridges.push(bridge)
    await bridge.start()
    await expect(bridge.setMode('plan')).rejects.toThrow(/cannot switch modes in place/)
  })
})

describe('the commands', () => {
  const host = createDefaultTerminalHost()
  const context = {
    runtime: { workspace: '/w', provider: 'p', model: 'm', serverName: 's', protocolVersion: '0.0.1' },
    session: { sessionId: 'root', turnCount: 0, generation: 1 },
    phase: 'idle' as const,
    totalTurns: 0,
    locale: 'en' as const,
  }
  const run = (name: string, args: readonly string[]) => {
    const command = host.resolveCommand(name)
    if (command === undefined) throw new Error(`no command ${name}`)
    return command.execute(context as never, args)
  }

  it('switches in place without asking, since nothing is lost', () => {
    expect(run('plan', [])).toEqual({ kind: 'switch-mode', mode: 'plan', allowRestart: false })
    expect(run('mode', ['review'])).toEqual({ kind: 'switch-mode', mode: 'review', allowRestart: false })
  })

  it('treats --yes as consent to the restart fallback, not as required', () => {
    expect(run('mode', ['code', '--yes'])).toEqual({ kind: 'switch-mode', mode: 'code', allowRestart: true })
  })

  it('still restarts for settings that cannot change in place', () => {
    const outcome = run('style', ['explanatory', '--yes']) as { kind: string }
    expect(outcome.kind).toBe('restart-runtime')
  })
})
