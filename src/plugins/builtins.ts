import { formatSessionUsage, describeSessionUsage } from '../session/usage.js'
import { toolCallDurations, toolProjectionKey, type NormalizedEvent } from '../session/projection.js'
import { findToolActivityDetail, formatActivityElapsed } from '../terminal/tool-activity.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { terminalBlockId } from '../terminal/transcript.js'
import {
  TERMINAL_PLUGIN_API_VERSION,
  type TerminalAgentTopologyEntry,
  type TerminalCommandContext,
  type TerminalPluginSpec,
  type TerminalRenderContext,
  type TerminalViewContext,
  type TranscriptMutation,
} from './api.js'
import { codingActivityPlugin, VALIDATED_DEFAULT_CODING_TOOLS } from './coding.js'
import { configurationPlugin } from './configuration.js'
import { pluginManagementPlugin } from './plugin-management.js'
import { TerminalPluginHost } from './host.js'
import { cordisEventTags, cordisEventToolName, workbenchPlugin } from './workbench.js'
import { insightsPlugin } from './insights.js'
import type { HistoryWorkbench } from './history.js'
import { capabilityMatrix } from '../capabilities.js'

const TRACE_PAGE_SIZE = 15
const TRACE_USAGE = [
  '/trace [all|errors|tools|agents|unknown] [--page N]',
  '/trace session <id> [--page N]',
  '/trace find <text> [--page N]',
  '/trace cordis [--page N]',
  '/trace plugin <plugin-id> [--page N]',
  '/trace service <service-name> [--page N]',
].join('\n')

export type TraceQueryMode = 'all' | 'errors' | 'tools' | 'agents' | 'unknown' | 'session' | 'find' | 'cordis' | 'plugin' | 'service'

export interface TraceQuery {
  mode: TraceQueryMode
  page: number
  value?: string
}

export function createDefaultTerminalHost(options: {
  devMode?: boolean
  history?: HistoryWorkbench
  env?: NodeJS.ProcessEnv
} = {}): TerminalPluginHost {
  const host = new TerminalPluginHost()
  host.register(corePlugin())
  host.register(insightsPlugin({
    devMode: options.devMode,
    env: options.env,
    historyReaderAvailable: options.history !== undefined,
  }))
  if (options.history !== undefined) host.register(options.history.plugin())
  host.register(codingActivityPlugin())
  if (options.devMode === true) host.register(workbenchPlugin())
  host.register(activityPlugin())
  host.register(configurationPlugin())
  host.register(pluginManagementPlugin())
  return host
}

function corePlugin(): TerminalPluginSpec {
  let traceQuery: TraceQuery = { mode: 'all', page: 1 }
  return {
    id: 'dshc.core',
    version: '1.0.0',
    apiVersion: TERMINAL_PLUGIN_API_VERSION,
    commands: [
      { name: 'help', aliases: ['h'], summary: 'Show capability-aware terminal help', execute: () => ({ kind: 'view', viewId: 'help' }) },
      { name: 'status', summary: 'Show runtime, model, workspace and session status', execute: context => ({ kind: 'message', title: 'status', text: statusMessage(context) }) },
      { name: 'session', summary: 'Show the active Harness session id', execute: context => ({ kind: 'message', title: 'session', text: `${context.session.sessionId} · turns ${context.session.turnCount} · generation ${context.session.generation}` }) },
      { name: 'new', summary: 'Select a fresh Harness session without restarting the runtime', execute: () => ({ kind: 'new-session' }) },
      { name: 'clear', summary: 'Clear local presentation only; Harness history is unchanged', execute: () => ({ kind: 'clear' }) },
      { name: 'plugins', aliases: ['capabilities'], summary: 'Inspect verified runtime metadata and active terminal adapters', execute: () => ({ kind: 'view', viewId: 'capabilities' }) },
      {
        name: 'trace',
        summary: 'Query the bounded normalized event debugger; /trace help shows filters and paging',
        execute: (_context, args) => {
          if (args.length === 1 && args[0]?.toLowerCase() === 'help') {
            return { kind: 'message', title: 'trace', text: TRACE_USAGE }
          }
          traceQuery = parseTraceQuery(args)
          return { kind: 'view', viewId: 'trace' }
        },
      },
      { name: 'agents', summary: 'Show current root/descendant topology projected from public events', execute: () => ({ kind: 'view', viewId: 'agents' }) },
      { name: 'tools', summary: 'Show or hide the tool activity sidebar', execute: () => ({ kind: 'toggle-tools' }) },
      { name: 'exit', aliases: ['quit'], summary: 'Close the owned Harness runtime and exit', execute: () => ({ kind: 'exit' }) },
    ],
    views: [
      { id: 'help', title: 'Help', render: renderHelp },
      { id: 'capabilities', title: 'Capability Explorer', render: renderCapabilities },
      { id: 'trace', title: 'Session Trace', render: context => renderTraceQuery(context, traceQuery) },
      { id: 'agents', title: 'Agent Topology', render: renderAgents },
      { id: 'tool-detail', title: 'Tool Call', render: renderToolDetail },
    ],
    statusSegments: [
      { id: 'phase', priority: 100, render: context => context.phase },
      { id: 'model', priority: 90, render: context => context.runtime.model },
      { id: 'session', priority: 80, render: context => compactSession(context.session.sessionId) },
      { id: 'turns', priority: 70, render: context => `turns:${context.totalTurns}` },
      {
        id: 'usage',
        priority: 60,
        render: context => context.usage === undefined ? undefined : formatSessionUsage(context.usage),
      },
      { id: 'workspace', priority: 10, render: context => context.runtime.workspace },
    ],
  }
}

function activityPlugin(): TerminalPluginSpec {
  return {
    id: 'dshc.activity',
    version: '1.0.0',
    apiVersion: TERMINAL_PLUGIN_API_VERSION,
    eventRenderers: [
      {
        id: 'tool-block',
        priority: 100,
        match: event => event.kind === 'tool-call' || event.kind === 'tool-result',
        render: (event, context) => toolMutations(event, context),
      },
      {
        id: 'agent-block',
        priority: 90,
        match: event => event.kind === 'subagent-started' || event.kind === 'subagent-finished',
        render: (event, context) => agentMutations(event, context),
      },
    ],
  }
}

function toolMutations(event: NormalizedEvent, context: TerminalRenderContext): readonly TranscriptMutation[] {
  if (event.kind === 'tool-call') {
    return [{
      kind: 'append',
      block: {
        id: terminalBlockId('tool', context.activityId, event.sessionId, event.callId),
        kind: 'tool',
        title: scopedTitle(`tool · ${sanitizeTerminalText(event.name)}`, event.sessionId, context.rootSessionId),
        text: event.arguments,
        state: 'running',
        foldable: true,
        sessionId: event.sessionId,
        activityId: context.activityId,
        ...(event.upstreamTime === undefined ? {} : { startedAt: event.upstreamTime }),
      },
    }]
  }
  if (event.kind === 'tool-result') {
    return [{
      kind: 'patch',
      id: terminalBlockId('tool', context.activityId, event.sessionId, event.callId),
      patch: {
        detail: event.text,
        state: event.isError ? 'error' : 'success',
        foldable: true,
        ...(event.upstreamTime === undefined ? {} : { endedAt: event.upstreamTime }),
      },
    }]
  }
  return []
}

function agentMutations(event: NormalizedEvent, context: TerminalRenderContext): readonly TranscriptMutation[] {
  if (event.kind === 'subagent-started') {
    return [{
      kind: 'append',
      block: {
        id: terminalBlockId('agent', context.activityId, event.parentSessionId, event.childSessionId),
        kind: 'agent',
        title: event.provider === undefined ? 'subagent' : `subagent · ${sanitizeTerminalText(event.provider)}`,
        text: event.childSessionId,
        detail: `parent ${event.parentSessionId}`,
        state: 'running',
        sessionId: event.parentSessionId,
        activityId: context.activityId,
      },
    }]
  }
  if (event.kind === 'subagent-finished') {
    return [{
      kind: 'patch',
      id: terminalBlockId('agent', context.activityId, event.parentSessionId, event.childSessionId),
      patch: { state: 'finished' },
    }]
  }
  return []
}

function renderHelp(context: TerminalViewContext): string {
  const rows = context.commands.map(command => {
    const aliases = command.aliases.length === 0 ? '' : ` (${command.aliases.map(alias => `/${alias}`).join(', ')})`
    return `/${command.name}${aliases}\n  ${command.summary}`
  })
  return `Commands exposed by the active terminal plugin host:\n\n${rows.join('\n\n')}\n\nTrace debugger:\n  ${TRACE_USAGE.replaceAll('\n', '\n  ')}\n\nUse //text to send a literal prompt beginning with /.`
}

function renderCapabilities(context: TerminalViewContext): string {
  const plugins = context.plugins.map(plugin => `${plugin.id}@${plugin.version}`).join(', ') || 'none'
  const renderers = context.renderers.map(renderer => `${renderer.id}@${renderer.pluginId}`).join(', ') || 'generic safe fallback only'
  const defaultShell = process.platform === 'win32' ? 'pwsh' : 'bash'
  const contextCapacityObserved = context.events.some(event => event.kind === 'request-context'
    && event.sessionId === context.session.sessionId
    && event.contextWindow !== undefined)
  const matrix = capabilityMatrix({
    historyReaderAvailable: context.commands.some(command => command.name === 'history'),
    contextCapacityObserved,
  })
  return [
    'Harness boundary',
    `- runtime: ${context.runtime.serverName}/${context.runtime.protocolVersion}`,
    `- provider: ${context.runtime.provider}`,
    `- model: ${context.runtime.model}`,
    `- workspace: ${context.runtime.workspace}`,
    '- runtime plugin inventory: partial/unavailable on SDK protocol 0.0.1',
    '- prompt cancel: unavailable',
    '- per-session close: unavailable',
    '',
    'M7 capability matrix',
    ...matrix.map(item => `- ${item.id}: ${item.availability} — ${item.detail}`),
    '',
    'Shipped default coding baseline: locally validated; not runtime discovery; overrides may differ',
    `- tools: ${VALIDATED_DEFAULT_CODING_TOOLS.filter(tool => tool !== 'bash' && tool !== 'pwsh').join(', ')}, ${defaultShell}`,
    '',
    `Terminal plugins: ${plugins}`,
    `Specialized renderers: ${renderers}`,
    `Commands: ${context.commands.map(command => `/${command.name}`).join(', ')}`,
  ].join('\n')
}

export function parseTraceQuery(args: readonly string[]): TraceQuery {
  const tokens = [...args]
  let page = 1
  const pageIndex = tokens.indexOf('--page')
  if (pageIndex >= 0) {
    if (tokens.indexOf('--page', pageIndex + 1) >= 0) throw new Error('/trace accepts only one --page option')
    const raw = tokens[pageIndex + 1]
    if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
      throw new Error('/trace --page requires a positive safe integer')
    }
    page = Number(raw)
    tokens.splice(pageIndex, 2)
  }

  if (tokens.length === 0) return { mode: 'all', page }
  const mode = tokens[0]!.toLowerCase()
  if (mode === 'help') throw new Error(`usage:\n${TRACE_USAGE}`)
  if (mode === 'all' || mode === 'errors' || mode === 'tools' || mode === 'agents' || mode === 'unknown') {
    if (tokens.length !== 1) throw new Error(`/trace ${mode} does not accept extra arguments`)
    return { mode, page }
  }
  if (mode === 'session' || mode === 'plugin' || mode === 'service') {
    if (tokens.length !== 2 || tokens[1]!.length === 0) {
      throw new Error(mode === 'session'
        ? '/trace session requires exactly one session id'
        : `/trace ${mode} requires exactly one value`)
    }
    return { mode, page, value: tokens[1]! }
  }
  if (mode === 'cordis') {
    if (tokens.length !== 1) throw new Error('/trace cordis does not accept extra arguments')
    return { mode, page }
  }
  if (mode === 'find') {
    const value = sanitizeTerminalText(tokens.slice(1).join(' ').trim())
    if (value.length === 0) throw new Error('/trace find requires search text')
    return { mode: 'find', page, value }
  }
  throw new Error(`usage:\n${TRACE_USAGE}`)
}

export function renderTraceQuery(context: TerminalViewContext, query: TraceQuery): string {
  const retention = context.retention
  const retainedStart = retention === undefined
    ? 0
    : Math.max(0, retention.totalEventCount - context.events.length)
  // Durations are paired across the whole retained tail, not the page, so a
  // result still reports its span when its call sits on an earlier page.
  const durations = toolCallDurations(context.events)
  const entries = context.events.map((event, index) => ({ event, absoluteIndex: retainedStart + index }))
  const matches = entries.filter(entry => matchesTraceQuery(entry.event, entry.absoluteIndex, query, durations, context.events))
  const totalPages = Math.max(1, Math.ceil(matches.length / TRACE_PAGE_SIZE))
  const pageEnd = Math.max(0, matches.length - (query.page - 1) * TRACE_PAGE_SIZE)
  const pageStart = Math.max(0, pageEnd - TRACE_PAGE_SIZE)
  const visible = query.page > totalPages ? [] : matches.slice(pageStart, pageEnd)

  const notes = [
    `query: ${traceQueryLabel(query)} · page ${query.page}/${totalPages} · ${matches.length} retained matches`,
    retention === undefined
      ? `scope: ${context.events.length} retained normalized events; retention metadata unavailable`
      : `scope: retained ${context.events.length}/${retention.totalEventCount} normalized events; ${retention.droppedEventCount} older evicted locally`,
  ]
  if ((retention?.droppedEventCount ?? 0) > 0) {
    notes.push('scope note: filters/search cannot inspect events already evicted from local retention')
  }
  if (query.mode === 'errors') notes.push(failureSummary(matches.map(entry => entry.event)))
  if (query.mode === 'unknown') notes.push(unknownSummary(matches.map(entry => entry.event)))

  if (visible.length === 0) {
    notes.push(query.page > totalPages
      ? `No such retained page. Available pages: 1-${totalPages}.`
      : 'No retained normalized events match this query.')
    return notes.join('\n')
  }

  return `${notes.join('\n')}\n\n${visible.map(entry => formatTraceEvent(entry.event, entry.absoluteIndex, durations)).join('\n')}`
}

function matchesTraceQuery(
  event: NormalizedEvent,
  absoluteIndex: number,
  query: TraceQuery,
  durations?: ReadonlyMap<string, number>,
  contextEvents: readonly NormalizedEvent[] = [],
): boolean {
  switch (query.mode) {
    case 'all': return true
    case 'errors': return event.kind === 'turn-error' || (event.kind === 'tool-result' && event.isError)
    case 'tools': return event.kind === 'tool-call' || event.kind === 'tool-result'
    case 'agents': return event.kind === 'subagent-started' || event.kind === 'subagent-finished'
    case 'unknown': return event.kind === 'unknown'
    case 'session': return query.value !== undefined && eventSessionIds(event).includes(query.value)
    case 'cordis': return cordisEventToolName(event, contextEvents) !== undefined
    case 'plugin': return query.value !== undefined && cordisEventTags(event, contextEvents).pluginIds.includes(query.value)
    case 'service': return query.value !== undefined && cordisEventTags(event, contextEvents).serviceNames.includes(query.value)
    case 'find': {
      const needle = query.value?.toLocaleLowerCase() ?? ''
      return needle.length > 0 && formatTraceEvent(event, absoluteIndex, durations).toLocaleLowerCase().includes(needle)
    }
  }
}

function eventSessionIds(event: NormalizedEvent): readonly string[] {
  switch (event.kind) {
    case 'session-status':
    case 'user-message':
    case 'assistant-delta':
    case 'assistant-message':
    case 'tool-call':
    case 'tool-result':
    case 'turn-error':
    case 'session-title':
    case 'context-compacted':
    case 'request-context':
    case 'approval-asked':
    case 'approval-decided':
    case 'approval-policy':
      return [event.sessionId]
    case 'subagent-started':
    case 'subagent-finished':
      return [event.parentSessionId, event.childSessionId]
    case 'internal':
    case 'unknown':
      return event.sessionId === undefined ? [] : [event.sessionId]
  }
}

function traceQueryLabel(query: TraceQuery): string {
  if (query.mode === 'session' || query.mode === 'plugin' || query.mode === 'service') return `${query.mode} ${sanitizeTerminalText(query.value ?? '')}`
  if (query.mode === 'find') return `find ${JSON.stringify(sanitizeTerminalText(query.value ?? ''))}`
  return query.mode
}

function failureSummary(events: readonly NormalizedEvent[]): string {
  let turnErrors = 0
  let toolErrors = 0
  for (const event of events) {
    if (event.kind === 'turn-error') turnErrors += 1
    if (event.kind === 'tool-result' && event.isError) toolErrors += 1
  }
  return `failure summary: ${turnErrors} upstream turn-error · ${toolErrors} tool-result error; local transport/protocol/configuration failures are not relabelled as trace events`
}

function unknownSummary(events: readonly NormalizedEvent[]): string {
  const counts = new Map<string, number>()
  for (const event of events) {
    if (event.kind !== 'unknown') continue
    const key = `${sanitizeTerminalText(event.method)}${event.type === undefined ? '' : `/${sanitizeTerminalText(event.type)}`}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (counts.size === 0) return 'unknown summary: none in retained query scope'
  const rows = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([key, count]) => `${key} ×${count}`)
  const extra = counts.size > rows.length ? ` · +${counts.size - rows.length} more signatures` : ''
  return `unknown summary: ${rows.join(' · ')}${extra}; meanings are not inferred`
}

export function formatTraceEvent(
  event: NormalizedEvent,
  timelineIndex = event.sequence,
  durations?: ReadonlyMap<string, number>,
): string {
  const prefix = String(timelineIndex).padStart(4, '0')
  switch (event.kind) {
    case 'session-status': return `${prefix} session ${short(event.sessionId)} ${event.status}`
    case 'user-message': return `${prefix} user ${short(event.sessionId)} ${preview(event.text)}`
    case 'assistant-delta': return `${prefix} assistant.stream ${short(event.sessionId)} +${event.text.length} retained chars`
    case 'assistant-message': return `${prefix} assistant.commit ${short(event.sessionId)} ${event.text.length} retained chars`
    case 'tool-call': return `${prefix} tool.call ${short(event.sessionId)} ${sanitizeTerminalText(event.name)} ${short(event.callId)}`
    case 'tool-result': {
      const elapsed = formatElapsed(durations?.get(toolProjectionKey(event.sessionId, event.callId)))
      return event.isError
        ? `${prefix} tool.error ${short(event.sessionId)} ${short(event.callId)}${elapsed} ${preview(event.text)}`
        : `${prefix} tool.result ${short(event.sessionId)} ${short(event.callId)}${elapsed} ${event.text.length} retained chars`
    }
    case 'subagent-started': return `${prefix} agent.start ${short(event.childSessionId)} <- ${short(event.parentSessionId)}`
    case 'subagent-finished': return `${prefix} agent.finish ${short(event.childSessionId)} <- ${short(event.parentSessionId)}`
    case 'turn-error': return `${prefix} turn.error ${short(event.sessionId)} ${preview(event.message)}`
    case 'context-compacted': return `${prefix} context.compacted ${short(event.sessionId)} ${event.shadowedEvents} events${event.shadowedTokens === undefined ? '' : ` · ${event.shadowedTokens} tokens`} shadowed`
    case 'session-title': return `${prefix} session.title ${short(event.sessionId)}${event.source === undefined ? '' : ` ${sanitizeTerminalText(event.source)}`} ${preview(event.title)}`
    case 'request-context': return `${prefix} request.context ${short(event.sessionId)} ${sanitizeTerminalText(event.provider)}/${sanitizeTerminalText(event.model)}${event.contextWindow === undefined ? '' : ` window=${event.contextWindow}`}`
    case 'approval-asked': return `${prefix} approval.asked ${short(event.sessionId)} ${sanitizeTerminalText(event.toolName)} ${short(event.requestId)}`
    case 'approval-decided': return `${prefix} approval.decided ${short(event.sessionId)} ${sanitizeTerminalText(event.outcome)} ${short(event.requestId)}`
    case 'approval-policy': return `${prefix} approval.policy ${short(event.sessionId)} ${event.policy}${event.source === undefined ? '' : ` ${event.source}`}`
    case 'internal': return `${prefix} internal${event.sessionId === undefined ? '' : ` ${short(event.sessionId)}`} ${sanitizeTerminalText(event.type)}`
    case 'unknown': return `${prefix} unknown${event.sessionId === undefined ? '' : ` ${short(event.sessionId)}`} ${sanitizeTerminalText(event.method)}${event.type === undefined ? '' : `/${sanitizeTerminalText(event.type)}`}`
  }
}

/**
 * Elapsed upstream time between a tool call and its result. Blank when upstream
 * did not timestamp both ends, so an unknown span is never shown as zero.
 */
function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return ''
  return ms < 1000 ? ` ${ms}ms` : ` ${(ms / 1000).toFixed(1)}s`
}

/**
 * Everything observed about the selected call. Absent facts are named as
 * absent rather than filled in, and retained sizes are labelled as retained,
 * because retention may already have truncated the result.
 */
function renderToolDetail(context: TerminalViewContext): string {
  const key = context.selectedToolKey
  if (key === undefined) return 'No tool call is selected.'

  const detail = findToolActivityDetail(context.events, context.session.sessionId, key)
  if (detail === undefined) {
    return 'That tool call is no longer in local retention. Older activity is evicted to keep this terminal process bounded.'
  }

  const { row } = detail
  const lines = [
    `${row.label}`,
    `outcome: ${row.state}${row.state === 'running' ? ' (no result observed yet)' : ''}`,
    `session: ${sanitizeTerminalText(row.sessionId)}${row.orphaned ? ' (parent chain not observed)' : ''}`,
    `call: ${sanitizeTerminalText(row.callId)}`,
    row.elapsedMs === undefined
      ? 'elapsed: unknown (upstream did not timestamp both ends)'
      : `elapsed: ${formatActivityElapsed(row.elapsedMs)} between upstream events`,
    '',
    'arguments',
    detail.argumentsText === undefined
      ? '  (the call was evicted from local retention)'
      : indentBlock(sanitizeTerminalText(detail.argumentsText)),
    '',
    'result',
    detail.resultText === undefined
      ? '  (no result observed yet)'
      : `  ${detail.resultText.length} retained chars\n${indentBlock(sanitizeTerminalText(detail.resultText))}`,
  ]
  return lines.join('\n')
}

function indentBlock(text: string): string {
  return text.split('\n').map(line => `  ${line}`).join('\n')
}

function renderAgents(context: TerminalViewContext): string {
  const topology = context.agentTopology ?? deriveTopologyFromEvents(context.events)
  const agents = new Map<string, TerminalAgentTopologyEntry>()
  const children = new Map<string, string[]>()

  for (const entry of topology) {
    agents.set(entry.childSessionId, entry)
    const siblings = children.get(entry.parentSessionId) ?? []
    if (!siblings.includes(entry.childSessionId)) children.set(entry.parentSessionId, [...siblings, entry.childSessionId])
  }

  const root = context.session.sessionId
  const lines = [`root ${sanitizeTerminalText(root)} · ${context.phase}`]
  const reachable = new Set<string>()

  const walk = (parent: string, depth: number, path: ReadonlySet<string>): void => {
    for (const child of children.get(parent) ?? []) {
      if (path.has(child)) {
        lines.push(`${'  '.repeat(depth)}└─ ${sanitizeTerminalText(child)} · cycle ignored`)
        continue
      }
      const agent = agents.get(child)
      if (agent === undefined || agent.parentSessionId !== parent) continue
      reachable.add(child)
      lines.push(
        `${'  '.repeat(depth)}└─ ${sanitizeTerminalText(child)} · ${agent.status}`
        + `${agent.provider === undefined ? '' : ` · ${sanitizeTerminalText(agent.provider)}`}`,
      )
      walk(child, depth + 1, new Set([...path, child]))
    }
  }

  walk(root, 1, new Set([root]))
  if (reachable.size === 0) lines.push('  └─ no descendant activity observed for this session')
  if ((context.retention?.droppedTopologyEntryCount ?? 0) > 0) {
    lines.push(`  retention: ${context.retention!.droppedTopologyEntryCount} older topology entries evicted; view may be partial`)
  }
  return lines.join('\n')
}

function deriveTopologyFromEvents(events: readonly NormalizedEvent[]): readonly TerminalAgentTopologyEntry[] {
  const agents = new Map<string, TerminalAgentTopologyEntry>()
  for (const event of events) {
    if (event.kind !== 'subagent-started' && event.kind !== 'subagent-finished') continue
    const previous = agents.get(event.childSessionId)
    agents.set(event.childSessionId, {
      childSessionId: event.childSessionId,
      parentSessionId: event.parentSessionId,
      ...(event.kind === 'subagent-started' && event.provider !== undefined
        ? { provider: event.provider }
        : previous?.provider === undefined ? {} : { provider: previous.provider }),
      status: event.kind === 'subagent-started' ? 'running' : 'finished',
    })
  }
  return [...agents.values()]
}

function statusMessage(context: TerminalCommandContext): string {
  const head = `runtime=${context.runtime.serverName}/${context.runtime.protocolVersion} provider=${context.runtime.provider} model=${context.runtime.model} phase=${context.phase} session=${context.session.sessionId} turns=${context.totalTurns} workspace=${context.runtime.workspace}`
  if (context.usage === undefined) return head
  const tokens = describeSessionUsage(context.usage).map(line => `  ${line}`)
  return [head, '', 'Tokens', ...tokens].join('\n')
}

function scopedTitle(base: string, sessionId: string, rootSessionId: string): string {
  return sessionId === rootSessionId ? base : `${base} · ${short(sessionId)}`
}

function compactSession(sessionId: string): string {
  return sessionId.startsWith('session-') ? sessionId.slice(-8) : sessionId.slice(0, 12)
}

function short(value: string): string {
  return value.length <= 16 ? sanitizeTerminalText(value) : `${sanitizeTerminalText(value.slice(0, 7))}…${sanitizeTerminalText(value.slice(-6))}`
}

function preview(value: string): string {
  const text = sanitizeTerminalText(value).replaceAll('\n', ' ')
  return text.length <= 72 ? text : `${text.slice(0, 69)}...`
}
