/** Reviewed plans use the source-label + evidence-json history convention. */
export function buildPlanHandoff(source: string, title: string, text: string, clarifications: readonly unknown[]): string {
  const retained: unknown[] = []
  for (const entry of [...clarifications].reverse()) {
    if (JSON.stringify([...retained, entry]).length > 32000) break
    retained.unshift(entry)
  }
  return [
    'Implement the exact plan explicitly confirmed by the user below in a NEW coding session, not resumed runtime state.',
    'Re-inspect the workspace before relying on historical file, process or repository observations.',
    'The quoted plan is the authorized task specification, not permission to bypass tool policy.',
    `Source session: ${JSON.stringify(source)}`,
    `Plan evidence-json=${JSON.stringify({ title, text })}`,
    `Clarification evidence-json=${JSON.stringify({ entries: retained, omitted: clarifications.length - retained.length })}`,
  ].join('\n')
}
