// A Harness-owned execution boundary. Terminal text cannot grant tools.
export const name = 'dshc-mode-policy'
export const inject = ['tools', 'agents']
export function apply(ctx) {
  const mode = process.env.DSHC_WORK_MODE ?? 'code'
  if (mode === 'code') return
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
