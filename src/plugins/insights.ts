import { Buffer } from 'node:buffer'
import { capabilityMatrix } from '../capabilities.js'
import { describeSessionUsage, type SessionUsage } from '../session/usage.js'
import type { NormalizedEvent } from '../session/projection.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { buildPersona, type PersonaFacts } from '../upstream/persona.js'
import { readNetworkFacts } from '../upstream/network.js'
import { DEV_PERSONA_APPENDIX } from '../workbench/contract.js'
import type {
  ContextInsightProjection,
  ProjectionFact,
  PromptLayerProjection,
} from '../history/types.js'
import {
  TERMINAL_PLUGIN_API_VERSION,
  type TerminalPluginSpec,
  type TerminalViewContext,
} from './api.js'

export interface InsightsPluginOptions {
  devMode?: boolean
  env?: NodeJS.ProcessEnv
  historyReaderAvailable?: boolean
}

type ApprovalAskedEvent = Extract<NormalizedEvent, { kind: 'approval-asked' }>
type ApprovalDecidedEvent = Extract<NormalizedEvent, { kind: 'approval-decided' }>

export interface ApprovalAuditProjection {
  readonly decisions: ReadonlyMap<string, ApprovalDecidedEvent>
  readonly pendingCount: number
  readonly anomalies: readonly string[]
}

export function insightsPlugin(options: InsightsPluginOptions = {}): TerminalPluginSpec {
  return {
    id: 'dshc.insights',
    version: '1.0.0',
    apiVersion: TERMINAL_PLUGIN_API_VERSION,
    commands: [
      {
        name: 'context',
        summary: 'Inspect observed token usage, runtime capacity metadata and compaction events',
        execute: (_context, args) => noArgsView('/context', args, 'context'),
      },
      {
        name: 'prompt',
        summary: 'Inspect dshc-owned local prompt layers without claiming the final Harness assembly',
        execute: (_context, args) => noArgsView('/prompt', args, 'prompt'),
      },
      {
        name: 'permissions',
        summary: 'Inspect fail-closed approval policy, capability limits and observed durable audit events',
        execute: (_context, args) => noArgsView('/permissions', args, 'permissions'),
      },
    ],
    views: [
      { id: 'context', title: 'Context', render: renderContext },
      { id: 'prompt', title: 'Prompt Projection', render: context => renderPrompt(context, options) },
      { id: 'permissions', title: 'Permissions', render: renderPermissions },
    ],
  }
}

export function renderContext(context: TerminalViewContext): string {
  const events = sessionEvents(context.events, context.session.sessionId)
  const compactions = events.filter(event => event.kind === 'context-compacted')
  const projection = projectContextInsights(context)
  const route = projection.route.value
  return [
    'Authority: runtime/observed for session events; local/observed for folded token totals.',
    '',
    ...describeSessionUsage(context.usage ?? emptyUsage()),
    factLine('latest request output', projection.latestOutputTokens, value => `${value.toLocaleString('en-US')} tokens`),
    factLine('latest request cache-read share', projection.latestCacheReadShare, value => `${value}%`),
    '',
    route === undefined
      ? 'route metadata: unavailable — no request/context event retained for this session'
      : `route: ${route.provider}/${route.model} (runtime/observed)`,
    projection.contextWindow.value === undefined
      ? 'context capacity: unavailable — dshc will not invent a model window'
      : `context capacity: ${projection.contextWindow.value.toLocaleString('en-US')} tokens (runtime/observed)`,
    projection.inputCapacityShare.value === undefined
      ? 'context percentage: unavailable'
      : `latest input / capacity: ${projection.inputCapacityShare.value}% (clamped display; raw counts remain above)`,
    `compaction events retained for this session: ${compactions.length}`,
    ...compactions.slice(-5).map(event => event.kind === 'context-compacted'
      ? `- seq ${event.upstreamSeq ?? '?'}: ${event.shadowedEvents} events${event.shadowedTokens === undefined ? '' : ` / ${event.shadowedTokens} tokens`} shadowed`
      : ''),
    '',
    'No configured compaction warning threshold is exposed on this transport, so dshc does not invent one.',
  ].join('\n')
}

export function projectContextInsights(context: TerminalViewContext): ContextInsightProjection {
  const events = sessionEvents(context.events, context.session.sessionId)
  const route = latest(events, 'request-context')
  const usage = context.usage
  const hasUsage = usage !== undefined && usage.requests > 0
  const latestInput = hasUsage ? usage.latestInputTokens : undefined
  const latestOutput = hasUsage ? usage.latestOutputTokens : undefined
  const latestCacheShare = !hasUsage
    || usage.latestCacheReadTokens === undefined
    || usage.latestInputTokens <= 0
    ? undefined
    : contextPercentage(usage.latestCacheReadTokens, usage.latestInputTokens)
  const capacityShare = route?.contextWindow === undefined || latestInput === undefined
    ? undefined
    : contextPercentage(latestInput, route.contextWindow)
  return {
    latestInputTokens: localObserved(latestInput),
    latestOutputTokens: localObserved(latestOutput),
    latestCacheReadShare: localObserved(latestCacheShare),
    route: route === undefined
      ? unavailableFact()
      : runtimeObserved({ provider: route.provider, model: route.model }),
    contextWindow: route?.contextWindow === undefined ? unavailableFact() : runtimeObserved(route.contextWindow),
    inputCapacityShare: capacityShare === undefined ? unavailableFact() : localObserved(capacityShare),
    compactionCount: runtimeObserved(events.filter(event => event.kind === 'context-compacted').length),
  }
}

export function renderPrompt(context: TerminalViewContext, options: InsightsPluginOptions = {}): string {
  const env = options.env ?? process.env
  const configured = env.DSH_SYSTEM_PROMPT?.trim()
  const facts: PersonaFacts = {
    platform: process.platform,
    workspace: context.runtime.workspace,
    network: readNetworkFacts(env, context.runtime.workspace),
  }
  const layers: PromptLayerProjection[] = configured === undefined || configured.length === 0
    ? [
        promptLayer('dshc persona', buildPersona(facts)),
        ...(options.devMode === true
          ? [promptLayer('developer appendix', DEV_PERSONA_APPENDIX)]
          : []),
      ]
    : [promptLayer('DSH_SYSTEM_PROMPT override', configured)]
  const patches = context.composition?.patches ?? []
  return [
    'This is a dshc local projection, not the final Harness system prompt.',
    'Runtime-assembled sections, context contributions and tool schemas are unavailable on SDK protocol 0.0.1.',
    '',
    'Requested local layers (assembly order)',
    ...layers.map((layer, index) => `${index + 1}. ${formatPromptLayer(layer)}`),
    '',
    `composition base: ${context.composition?.base.path ?? 'unavailable'}`,
    ...(patches.length === 0
      ? ['composition patches: none observed in dshc launch request']
      : patches.map((patch, index) => `composition patch ${index + 1}: ${patch.path} · ${patch.patchCount} include operations · local/requested`)),
    '',
    'Full prompt text reveal and optimization are disabled until upstream publishes an authoritative assembled structure.',
  ].join('\n')
}

export function renderPermissions(context: TerminalViewContext): string {
  const events = sessionEvents(context.events, context.session.sessionId)
  const policyEvent = latest(events, 'approval-policy')
  const asked = events.filter(event => event.kind === 'approval-asked')
  const decided = events.filter(event => event.kind === 'approval-decided')
  const audit = projectApprovalAudit(events)
  const matrix = capabilityMatrix({
    historyReaderAvailable: context.commands.some(command => command.name === 'history'),
    contextCapacityObserved: latest(events, 'request-context')?.contextWindow !== undefined,
  })
  const policyFact: ProjectionFact<'ask' | 'never'> | undefined = policyEvent === undefined
    ? undefined
    : runtimeObserved(policyEvent.policy)
  return [
    policyFact === undefined
      ? 'effective policy: unavailable (runtime/unavailable); shipped requested default: never (local/requested)'
      : `effective policy: ${policyFact.value} (${policyFact.source}/${policyFact.authority} session event)`,
    'answerer: unavailable · fail-closed',
    'supported grants: allowed-once only; dshc does not offer session-wide or persistent allow rules',
    '',
    'Capability matrix',
    ...matrix.map(item => `- ${item.id}: ${item.availability} — ${item.detail}`),
    '',
    `retained approval audit: ${asked.length} asked · ${decided.length} decided · ${audit.pendingCount} pending`,
    ...(audit.anomalies.length === 0
      ? []
      : [
          `audit anomalies: ${audit.anomalies.length} (observed only; never treated as authorization)`,
          ...audit.anomalies.slice(-5).map(item => `- ${item}`),
        ]),
    ...asked.slice(-10).map(event => {
      if (event.kind !== 'approval-asked') return ''
      const decision = audit.decisions.get(event.requestId)
      return `- ${short(event.requestId)} · ${sanitizeTerminalText(event.toolName)}${event.callId === undefined ? '' : ` · call ${short(event.callId)}`} · ${decision?.kind === 'approval-decided' ? decision.outcome : 'pending/unobserved'}`
    }),
    '',
    'Policy switching and Allow once/Reject controls require a supported upstream answerer handshake; no private bridge is installed.',
  ].join('\n')
}

/**
 * Fold the retained audit as an append-only log. Only the first decision after
 * an observed ask is correlated. Replayed asks, orphan/late decisions and
 * duplicate answers stay visible as anomalies and cannot overwrite a prior
 * outcome or manufacture a grant.
 */
export function projectApprovalAudit(events: readonly NormalizedEvent[]): ApprovalAuditProjection {
  const states = new Map<string, { asked?: ApprovalAskedEvent; decision?: ApprovalDecidedEvent }>()
  const anomalies: string[] = []
  for (const event of events) {
    if (event.kind === 'approval-asked') {
      const state = states.get(event.requestId) ?? {}
      if (state.asked !== undefined) {
        anomalies.push(`replayed ask ${short(event.requestId)} at event ${event.sequence}`)
      } else {
        state.asked = event
      }
      states.set(event.requestId, state)
      continue
    }
    if (event.kind !== 'approval-decided') continue
    const state = states.get(event.requestId)
    if (state?.asked === undefined) {
      anomalies.push(`decision without observed ask ${short(event.requestId)} at event ${event.sequence}`)
      continue
    }
    if (state.decision !== undefined) {
      anomalies.push(`duplicate decision ${short(event.requestId)} at event ${event.sequence}`)
      continue
    }
    state.decision = event
  }
  const decisions = new Map<string, ApprovalDecidedEvent>()
  let pendingCount = 0
  for (const [requestId, state] of states) {
    if (state.asked === undefined) continue
    if (state.decision === undefined) pendingCount += 1
    else decisions.set(requestId, state.decision)
  }
  return { decisions, pendingCount, anomalies }
}

export function contextPercentage(inputTokens: number, contextWindow: number): number {
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return 0
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((inputTokens / contextWindow) * 100)))
}

function noArgsView(command: string, args: readonly string[], viewId: string) {
  if (args.length > 0) throw new Error(`${command} does not accept arguments`)
  return { kind: 'view' as const, viewId }
}

function sessionEvents(events: readonly NormalizedEvent[], sessionId: string): readonly NormalizedEvent[] {
  return events.filter(event => 'sessionId' in event && event.sessionId === sessionId)
}

function latest<K extends NormalizedEvent['kind']>(
  events: readonly NormalizedEvent[],
  kind: K,
): Extract<NormalizedEvent, { kind: K }> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.kind === kind) return event as Extract<NormalizedEvent, { kind: K }>
  }
  return undefined
}

function promptLayer(name: string, text: string): PromptLayerProjection {
  return { name, content: { value: text, source: 'local', authority: 'requested' } }
}

function formatPromptLayer(layer: PromptLayerProjection): string {
  const text = layer.content.value ?? ''
  return `${layer.name} · ${text.length.toLocaleString('en-US')} chars · ${Buffer.byteLength(text).toLocaleString('en-US')} bytes · ${layer.content.source}/${layer.content.authority}`
}

function factLine<T>(name: string, fact: ProjectionFact<T>, format: (value: T) => string): string {
  return `${name}: ${fact.value === undefined ? 'unavailable' : format(fact.value)} · ${fact.source}/${fact.authority}`
}

function localObserved<T>(value: T | undefined): ProjectionFact<T> {
  return { ...(value === undefined ? {} : { value }), source: 'local', authority: value === undefined ? 'unavailable' : 'observed' }
}

function runtimeObserved<T>(value: T): ProjectionFact<T> {
  return { value, source: 'runtime', authority: 'observed' }
}

function unavailableFact<T>(): ProjectionFact<T> {
  return { source: 'runtime', authority: 'unavailable' }
}

function emptyUsage(): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    latestInputTokens: 0,
    latestOutputTokens: 0,
    latestCacheReadTokens: 0,
    requests: 0,
  }
}

function short(value: string): string {
  const safe = sanitizeTerminalText(value)
  return safe.length <= 18 ? safe : `${safe.slice(0, 8)}…${safe.slice(-7)}`
}
