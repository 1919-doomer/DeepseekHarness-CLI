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
    process.env.DSHC_WORK_MODE === 'plan' ? 'Inspect read-only, clarify decisions, then use present_plan when available. After the user selects implement, end the turn; the terminal owns switching to code mode.' : '',
    process.env.DSHC_WORK_MODE !== 'code' ? `Work mode: ${process.env.DSHC_WORK_MODE}. Inspect and report; do not modify the workspace.` : '',
  ].filter(Boolean).join('\n')
  ctx.effect(() => ctx.systemPrompt.section({ name: 'dshc-preferences', order: 450, text,
    ...(explicit === undefined ? {} : { complete: true }) }))
}
