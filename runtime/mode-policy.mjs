// A Harness-owned execution boundary. Terminal text cannot grant tools.
//
// The mode is read live from mode-state rather than captured at load, so a
// mode switch changes enforcement, tool visibility and the model's
// instructions without a new process — and so without a new session.
// Authority is unchanged: only the terminal, over its token-authenticated
// loopback channel, can switch modes, exactly as only it could choose one at
// launch. No tool exposes a mode switch to the model.
import { planGate } from './plan-gate.mjs'
import { modeState } from './mode-state.mjs'

export const name = 'dshc-mode-policy'
export const inject = ['tools', 'agents']

const REQUIRED = ['read', 'glob', 'grep']

/**
 * Tools a read-only mode permits, or `undefined` for code mode, which is
 * unrestricted and governed by the plan gate instead. Pure, so the rule reads
 * as a table.
 */
export function allowedToolsFor(mode, interactionAvailable) {
  if (mode === 'code') return undefined
  const allowed = new Set([...REQUIRED, ...(mode === 'research' ? ['web_search', 'web_fetch'] : [])])
  if (interactionAvailable) {
    allowed.add('request_user_input')
    if (mode === 'plan') allowed.add('present_plan')
  }
  return allowed
}

/**
 * What the model is told about the current mode. Delivered as a runtime
 * context snapshot, not baked into the system prompt: a switch appends one
 * superseding snapshot instead of rewriting the prompt the whole conversation
 * is cached against.
 */
export function modeContextText(mode, interactionAvailable) {
  const switched = 'It replaces any earlier work mode stated in this conversation.'
  switch (mode) {
    case 'plan':
      return `Current dshc work mode: plan. ${switched} Inspect read-only, clarify material decisions with request_user_input when available, then present a decision-complete implementation and verification plan with present_plan when available. Do not modify files. After an implement answer, end the turn; the terminal owns switching to code mode. Without present_plan, report the plan as text and wait for explicit instructions.`
    case 'review':
      return `Current dshc work mode: review. ${switched} Report actionable findings with evidence and file locations. Do not modify files.`
    case 'research':
      return `Current dshc work mode: research. ${switched} Gather primary evidence, cite sources, and distinguish facts from inference. Do not modify files.`
    default:
      return interactionAvailable
        ? `Current dshc work mode: code. ${switched} You may change the workspace. Before a task that takes more than one step, call outline_plan once with two to six short steps, then carry them out; changes are refused until the turn has a declared plan. Do not call it for a single-step answer, and do not narrate the plan in prose as well.`
        : `Current dshc work mode: code. ${switched} You may change the workspace.`
  }
}

export function apply(ctx) {
  const interactionAvailable = Boolean(process.env.DSHC_INTERACTION_URL)
  /** Live agents and the exact disposer for the mode restriction on each. */
  const restrictions = new Map()

  const restrictFor = (agent, mode, atCreation) => {
    const previous = restrictions.get(agent.id)
    try { previous?.lift?.() } catch { /* the scope is already gone */ }
    const allowed = allowedToolsFor(mode, interactionAvailable)
    if (allowed === undefined) { restrictions.set(agent.id, { agent, lift: undefined }); return }
    const names = [...allowed].filter(toolName => agent.ctx.tools.get(toolName) !== undefined)
    const missing = REQUIRED.filter(toolName => !names.includes(toolName))
    if (missing.length > 0) {
      const message = `dshc ${mode} mode requires ${missing.join(', ')}`
      // At creation this is a broken composition and must fail loud. On a
      // live switch the guard below still enforces the mode; only the tool
      // list the model sees stays wider than it should, and that is reported.
      if (atCreation) throw new Error(message)
      process.stderr.write(`dshc-mode: ${message}; tool list not narrowed\n`)
      restrictions.set(agent.id, { agent, lift: undefined })
      return
    }
    restrictions.set(agent.id, { agent, lift: agent.ctx.tools.restrict({ allow: names }) })
  }

  ctx.on('agent/created', ({ agent }) => restrictFor(agent, modeState.get(), true))

  // One guard for every mode, reading the mode at call time. A global guard
  // covers scoped registrations and nested executions too; restriction alone
  // masks inherited schemas but cannot fence new local tools.
  ctx.effect(() => ctx.tools.guard(execution => {
    const mode = modeState.get()
    const allowed = allowedToolsFor(mode, interactionAvailable)
    if (allowed !== undefined) {
      return allowed.has(execution.name)
        ? undefined
        : `dshc ${mode} mode denies ${execution.name}; the person can switch to code mode to make changes`
    }
    const agentId = execution.agent?.id
    if (agentId === undefined) return undefined
    const decision = planGate.check(agentId, execution.name, { mode, planToolAvailable: planGate.available })
    return decision.allow ? undefined : decision.reason
  }))

  ctx.effect(() => modeState.subscribe(mode => {
    // Deferred so every synchronous listener has run first — in particular
    // the interaction plugin registering present_plan or outline_plan. A
    // restriction computed before present_plan exists would hide it from the
    // very mode that needs it.
    queueMicrotask(() => {
      for (const [id, entry] of restrictions) {
        if (ctx.agents.get(id) !== entry.agent) {
          try { entry.lift?.() } catch { /* already disposed */ }
          restrictions.delete(id)
          continue
        }
        restrictFor(entry.agent, mode, false)
      }
    })
  }))

  // Optional on purpose: the guard above must never wait on the prompt service.
  ctx.inject(['systemPrompt'], scope => {
    scope.systemPrompt.context({
      name: 'dshc:work-mode',
      order: 120,
      text: () => modeContextText(modeState.get(), interactionAvailable),
    })
  })

  installPlanGateLifecycle(ctx)
}

/**
 * Keep the plan gate's per-turn state current. Registered in every mode,
 * because a session can now enter code mode without a new process.
 */
function installPlanGateLifecycle(ctx) {
  // A plan approved in plan mode carries into the code session it handed off
  // to, rather than demanding the person's just-approved plan be restated.
  const approved = process.env.DSHC_APPROVED_PLAN
  let seeded = approved === undefined || approved.length === 0

  ctx.on('agent/created', ({ agent }) => {
    if (seeded) return
    seeded = true
    planGate.seed(agent.id)
  })

  // Turn boundary. `agent/status` is how the loop publishes idle-to-running,
  // and a plan covers the turn it was declared in, not the next one.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') planGate.reset(agent.id)
  })

  // A child executes one step of its parent's plan and is exempt.
  ctx.on('subagent/start', (identity) => {
    const id = identity?.agentId ?? identity?.childSessionId ?? identity?.id
    if (typeof id === 'string') planGate.markChild(id)
  })
}
