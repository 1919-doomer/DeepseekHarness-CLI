import { describe, expect, it } from 'vitest'
import { capabilityMatrix } from '../../src/capabilities.js'
import { contextPercentage, projectContextInsights, renderContext, renderPermissions, renderPrompt } from '../../src/plugins/insights.js'
import type { TerminalViewContext } from '../../src/plugins/api.js'

function viewContext(overrides: Partial<TerminalViewContext> = {}): TerminalViewContext {
  return {
    runtime: {
      workspace: 'C:\\workspace',
      provider: 'p',
      model: 'm',
      serverName: 'test',
      protocolVersion: '0.0.1',
    },
    session: { sessionId: 'main', turnCount: 1, generation: 0 },
    phase: 'idle',
    totalTurns: 1,
    events: [],
    commands: [],
    renderers: [],
    plugins: [],
    ...overrides,
  }
}

describe('M7 context and prompt projections', () => {
  it('never invents capacity and clamps an observed ratio to 0-100', () => {
    expect(renderContext(viewContext())).toContain('context percentage: unavailable')
    expect(contextPercentage(200, 100)).toBe(100)
    expect(contextPercentage(-1, 100)).toBe(0)

    const rendered = renderContext(viewContext({
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 190,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        latestInputTokens: 200,
        latestOutputTokens: 2,
        latestCacheReadTokens: 190,
        requests: 1,
      },
      events: [{
        sequence: 1,
        kind: 'request-context',
        sessionId: 'main',
        provider: 'p',
        model: 'm',
        contextWindow: 100,
      }],
    }))
    expect(rendered).toContain('latest input / capacity: 100%')
    expect(rendered).toContain('latest request output: 2 tokens')
    expect(rendered).toContain('latest request cache-read share: 95%')
    expect(projectContextInsights(viewContext({
      events: [{ sequence: 1, kind: 'request-context', sessionId: 'main', provider: 'p', model: 'm', contextWindow: 100 }],
    })).contextWindow).toEqual({ value: 100, source: 'runtime', authority: 'observed' })
  })

  it('labels prompt content as a local projection rather than runtime authority', () => {
    const rendered = renderPrompt(viewContext(), { env: { DSH_SYSTEM_PROMPT: 'local override' } })
    expect(rendered).toContain('dshc local projection')
    expect(rendered).toContain('DSH_SYSTEM_PROMPT override')
    expect(rendered).toContain('local/requested')
    expect(rendered).toContain('unavailable on SDK protocol 0.0.1')
  })

  it('keeps permissions fail-closed without an upstream answerer', () => {
    const rendered = renderPermissions(viewContext())
    expect(rendered).toContain('effective policy: never')
    expect(rendered).toContain('answerer: unavailable · fail-closed')
    expect(rendered).not.toContain('session-wide allow')
    expect(capabilityMatrix({ historyReaderAvailable: false }).find(item => item.id === 'approval.answerer')?.availability).toBe('requires-upstream')
  })
})
