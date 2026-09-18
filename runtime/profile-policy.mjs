import { apply as applyMode } from './mode-policy.mjs'
export const name = 'dshc-profile-policy'
export const inject = ['tools', 'agents', 'systemPrompt']
export function apply(ctx) {
  applyMode(ctx)
  const language = process.env.DSHC_REPLY_LANGUAGE ?? 'auto'
  const style = process.env.DSHC_OUTPUT_STYLE ?? 'default'
  const explicit = process.env.DSH_SYSTEM_PROMPT
  const text = explicit ?? [
    language === 'auto' ? "Reply in the language of the user's task." : `Reply in ${language}.`,
    style === 'explanatory' ? 'Explain the decisions and mechanisms behind your answer.' : '',
    style === 'learning' ? 'Teach through examples and small steps; help the user understand the solution.' : '',
    'When available, use request_user_input for material clarification. Subagents report questions to the main agent. A skipped question is not approval.',
    // Work-mode instructions are not here: they change while the runtime
    // lives, so mode-policy delivers them as a runtime context snapshot.
  ].filter(Boolean).join('\n')
  ctx.effect(() => ctx.systemPrompt.section({ name: 'dshc-preferences', order: 450, text,
    ...(explicit === undefined ? {} : { complete: true }) }))
}
