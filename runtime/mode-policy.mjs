// A Harness-owned execution boundary. Terminal text cannot grant tools.
import { planGate } from './plan-gate.mjs'
export const name = 'dshc-mode-policy'
export const inject = ['tools', 'agents']
export function apply(ctx) {
  const mode = process.env.DSHC_WORK_MODE ?? 'code'
  if (mode === 'code') { applyPlanGate(ctx, mode); return }
  if (!['plan', 'review', 'research'].includes(mode)) throw new Error('Unknown dshc work mode')
  const allowed = new Set(['read', 'glob', 'grep', ...(mode === 'research' ? ['web_search', 'web_fetch'] : [])])
  if (process.env.DSHC_INTERACTION_URL) {
    allowed.add('request_user_input')
    if (mode === 'plan') allowed.add('present_plan')
  }
  // A global monotonic guard covers scoped registrations and nested executions
  // too. Restrict alone masks inherited schemas but cannot fence new local tools.
  ctx.effect(() => ctx.tools.guard(execution => allowed.has(execution.name)
    ? undefined : `dshc ${mode} mode denies ${execution.name}; select code mode to make changes`))
  ctx.on('agent/created', ({ agent }) => {
    const names = [...allowed].filter(name => agent.ctx.tools.get(name) !== undefined)
    for (const required of ['read', 'glob', 'grep']) {
      if (!names.includes(required)) throw new Error(`dshc ${mode} mode requires ${required}`)
    }
    agent.ctx.tools.restrict({ allow: names })
  })
}

/**
 * In code mode, hold back anything that changes the world until the model has
 * declared a plan. Reading stays free — you cannot plan what you have not
 * looked at — and the denial tells the model exactly how to proceed, so it
 * recovers by itself in one step.
 *
 * Enforcement never expires into permission. A model that keeps retrying is
 * counted and surfaced to the person, who can steer it mid-turn; repeated
 * refusal is a thing to see, not a reason to let the write through.
 */
function applyPlanGate(ctx, mode) {
  // A plan approved in plan mode carries into the code session it handed off
  // to, rather than demanding the person's just-approved plan be restated.
  const approved = process.env.DSHC_APPROVED_PLAN
  let seeded = approved === undefined || approved.length === 0

  ctx.on('agent/created', ({ agent }) => {
    if (seeded) return
    seeded = true
    planGate.seed(agent.id)
  })

  // Turn boundary. `agent/status` is how the loop publishes idle↔running, and
  // a plan covers the turn it was declared in, not the next one.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') planGate.reset(agent.id)
  })

  // A child executes one step of its parent's plan and is exempt.
  ctx.on('subagent/start', (identity) => {
    const id = identity?.agentId ?? identity?.childSessionId ?? identity?.id
    if (typeof id === 'string') planGate.markChild(id)
  })

  ctx.effect(() => ctx.tools.guard(execution => {
    const agentId = execution.agent?.id
    if (agentId === undefined) return undefined
    const decision = planGate.check(agentId, execution.name, {
      mode,
      planToolAvailable: planGate.available,
    })
    return decision.allow ? undefined : decision.reason
  }))
}
