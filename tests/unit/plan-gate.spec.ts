import { describe, expect, it } from 'vitest'
import { decideToolCall, GATED_TOOLS, PlanGate } from '../../runtime/plan-gate.mjs'

const base = { mode: 'code', planDeclared: false, planToolAvailable: true, isChild: false }

describe('what waits for a plan', () => {
  it('lets the model look before it plans', () => {
    // You cannot plan what you have not read. Gating reads would make the rule
    // impossible to satisfy rather than strict.
    for (const name of ['read', 'glob', 'grep', 'read_image', 'todo_write', 'outline_plan', 'request_user_input']) {
      expect(decideToolCall({ ...base, name }).allow).toBe(true)
    }
  })

  it('holds back everything that changes the world', () => {
    for (const name of ['write', 'edit', 'pwsh', 'bash', 'subagent']) {
      const decision = decideToolCall({ ...base, name })
      expect(decision.allow).toBe(false)
      // The denial has to be actionable, or the model cannot recover by itself.
      expect(decision.reason).toContain('outline_plan')
      expect(decision.reason).toContain(name)
    }
  })

  it('lets the read-only roles through, since they can never reach a gated tool', () => {
    for (const name of ['scout', 'planner', 'reviewer', 'oracle']) {
      expect(decideToolCall({ ...base, name }).allow).toBe(true)
    }
  })

  it('allows everything once a plan is declared', () => {
    for (const name of GATED_TOOLS) {
      expect(decideToolCall({ ...base, name, planDeclared: true }).allow).toBe(true)
    }
  })

  it('does not gate the other modes, which are already read-only', () => {
    for (const mode of ['plan', 'review', 'research']) {
      expect(decideToolCall({ ...base, name: 'write', mode }).allow).toBe(true)
    }
  })

  it('fails open when outline_plan is not registered', () => {
    // The interaction channel is optional. A runtime whose only way to satisfy
    // the gate does not exist would be a brick, not a strict deployment.
    expect(decideToolCall({ ...base, name: 'write', planToolAvailable: false }).allow).toBe(true)
  })

  it('exempts a subagent, which is executing its parent plan', () => {
    expect(decideToolCall({ ...base, name: 'write', isChild: true }).allow).toBe(true)
  })
})

describe('gate state across a session', () => {
  const options = { mode: 'code', planToolAvailable: true }

  it('opens for the agent that declared, and only that one', () => {
    const gate = new PlanGate()
    gate.enable()
    gate.declare('root')
    expect(gate.check('root', 'write', options).allow).toBe(true)
    expect(gate.check('other', 'write', options).allow).toBe(false)
  })

  it('closes again on the next turn', () => {
    // A plan covers the turn it was declared in. Carrying it forward would mean
    // one plan licenses every later change in the session.
    const gate = new PlanGate()
    gate.declare('root')
    expect(gate.check('root', 'edit', options).allow).toBe(true)
    gate.reset('root')
    expect(gate.check('root', 'edit', options).allow).toBe(false)
  })

  it('counts refusals without ever turning them into permission', () => {
    const gate = new PlanGate()
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const decision = gate.check('root', 'write', options)
      expect(decision.allow).toBe(false)
      expect(decision.denials).toBe(attempt)
    }
    // Five refusals later it is still refused. The count is for the person to
    // see, not a budget that buys the write.
    expect(gate.check('root', 'write', options).allow).toBe(false)
    expect(gate.denials('root')).toBe(6)
  })

  it('clears the denial count when the turn does', () => {
    const gate = new PlanGate()
    gate.check('root', 'write', options)
    gate.reset('root')
    expect(gate.denials('root')).toBe(0)
  })

  it('treats a seeded plan exactly like a declared one', () => {
    const gate = new PlanGate()
    gate.seed('root')
    expect(gate.check('root', 'write', options).allow).toBe(true)
  })

  it('lets a seeded plan survive the turn start that immediately follows it', () => {
    // Seeding happens at agent creation and the first turn's running transition
    // arrives right after, so a seed that did not survive one reset was wiped
    // before the turn it existed for ever ran.
    const gate = new PlanGate()
    gate.seed('root')
    gate.reset('root')
    expect(gate.check('root', 'write', options).allow).toBe(true)
  })

  it('does not let a seeded plan cover every later turn', () => {
    const gate = new PlanGate()
    gate.seed('root')
    gate.reset('root')
    gate.reset('root')
    expect(gate.check('root', 'write', options).allow).toBe(false)
  })

  it('does not grow without bound on a long-lived runtime', () => {
    const gate = new PlanGate()
    for (let index = 0; index < 5000; index += 1) gate.markChild(`child-${index}`)
    // Bounded, and a child beyond the cap simply gets gated rather than leaking.
    expect(gate.check('child-4999', 'write', options).allow).toBe(false)
  })
})
