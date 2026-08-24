import { toolCallDurations, toolProjectionKey, type NormalizedEvent } from '../session/projection.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { terminalBlockId } from '../terminal/transcript.js'
import { DEV_MODE_WARNING, isCordisToolName, type CordisToolName } from '../workbench/contract.js'
import {
  TERMINAL_PLUGIN_API_VERSION,
  type TerminalPluginSpec,
  type TerminalRenderContext,
  type TerminalViewContext,
  type TranscriptMutation,
} from './api.js'

interface CordisActivity {
  call: Extract<NormalizedEvent, { kind: 'tool-call' }>
  result?: Extract<NormalizedEvent, { kind: 'tool-result' }>
  elapsedMs?: number
}

export function workbenchPlugin(): TerminalPluginSpec {
  return {
    id: 'dshc.workbench',
    version: '1.0.0',
    apiVersion: TERMINAL_PLUGIN_API_VERSION,
    commands: [{
      name: 'workbench',
      summary: 'Show observed Cordis lifecycle activity (diagnostic timeline, not runtime inventory)',
      execute: () => ({ kind: 'view', viewId: 'workbench' }),
    }],
    views: [{ id: 'workbench', title: 'Cordis Plugin Workbench', render: renderWorkbench }],
    eventRenderers: [{
      id: 'cordis-lifecycle',
      priority: 250,
      match: event => event.kind === 'tool-call'
        ? isCordisToolName(event.name)
        : event.kind === 'tool-result' && event.name !== undefined && isCordisToolName(event.name),
      render: renderCordisEvent,
    }],
    statusSegments: [{ id: 'developer-mode', priority: 95, render: () => 'DEV:trusted-code' }],
  }
}

/** Resolve the Cordis tool name for a call or correlated result. */
export function cordisEventToolName(
  event: NormalizedEvent,
  events: readonly NormalizedEvent[],
): CordisToolName | undefined {
  if (event.kind === 'tool-call') return isCordisToolName(event.name) ? event.name : undefined
  if (event.kind !== 'tool-result') return undefined
  if (event.name !== undefined && isCordisToolName(event.name)) return event.name
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = events[index]
    if (candidate?.kind !== 'tool-call') continue
    if (candidate.sessionId !== event.sessionId || candidate.callId !== event.callId) continue
    return isCordisToolName(candidate.name) ? candidate.name : undefined
  }
  return undefined
}

/** Structured call-input tags used by `/trace`; result prose is never parsed. */
export function cordisEventTags(
  event: NormalizedEvent,
  events: readonly NormalizedEvent[],
): { pluginIds: readonly string[]; serviceNames: readonly string[] } {
  const pluginIds = event.kind === 'tool-result' && event.metadata?.pluginId !== undefined
    ? [event.metadata.pluginId]
    : []
  const call = event.kind === 'tool-call'
    ? event
    : findCordisCall(event, events)
  if (call === undefined || !isCordisToolName(call.name)) return { pluginIds, serviceNames: [] }
  const args = parseArguments(call.arguments)
  if (args === undefined) return { pluginIds, serviceNames: [] }

  pluginIds.push(...stringsAt(args, ['pluginId']))
  const plugin = recordAt(args, 'plugin')
  if (plugin !== undefined) pluginIds.push(...stringsAt(plugin, ['pluginId']))
  const serviceNames = stringsAt(args, ['service', 'serviceName'])
  // The official host Service inspector carries the exact service key inside
  // `cordis_inspect_query.input`. Read that public JSON field directly; do not
  // mine the rendered result prose or confuse provider/method names with a
  // runtime Service identity.
  const input = recordAt(args, 'input')
  if (input !== undefined) serviceNames.push(...stringsAt(input, ['service', 'serviceName']))
  return { pluginIds: unique(pluginIds), serviceNames: unique(serviceNames) }
}

export function renderWorkbench(context: TerminalViewContext): string {
  const sessions = workbenchSessions(context)
  const activities = projectCordisActivities(context.events)
    .filter(activity => sessions.has(activity.call.sessionId))
  const lines = [
    DEV_MODE_WARNING,
    '',
    'Observed event timeline — not authoritative real-time inventory.',
    'Only retained public tool call/result events are shown. Use the official inspect tools through the Agent for current runtime state.',
    'Lifecycle changes remain model-driven; this view has no Run/Stop controls.',
    '',
  ]

  if (activities.length === 0) {
    lines.push('No Cordis lifecycle activity has been observed in local retention.')
  } else {
    for (const activity of activities) {
      lines.push(formatActivity(activity, context.session.sessionId))
    }
  }

  const dropped = context.retention?.droppedEventCount ?? 0
  if (dropped > 0) {
    lines.push('', `Retention note: ${dropped} older normalized events were evicted; this timeline may be incomplete.`)
  }
  return lines.join('\n')
}

function workbenchSessions(context: TerminalViewContext): ReadonlySet<string> {
  const sessions = new Set([context.session.sessionId])
  const topology = context.agentTopology ?? []
  let changed = true
  while (changed) {
    changed = false
    for (const entry of topology) {
      if (!sessions.has(entry.parentSessionId) || sessions.has(entry.childSessionId)) continue
      sessions.add(entry.childSessionId)
      changed = true
    }
  }
  return sessions
}

function renderCordisEvent(event: NormalizedEvent, context: TerminalRenderContext): readonly TranscriptMutation[] {
  if (event.kind === 'tool-call' && isCordisToolName(event.name)) {
    return [{
      kind: 'append',
      block: {
        id: terminalBlockId('tool', context.activityId, event.sessionId, event.callId),
        kind: 'tool',
        title: `cordis · ${toolLabel(event.name)}`,
        text: structuredArgumentSummary(event.arguments),
        state: 'running',
        foldable: true,
        sessionId: event.sessionId,
        activityId: context.activityId,
        ...(event.upstreamTime === undefined ? {} : { startedAt: event.upstreamTime }),
      },
    }]
  }
  if (event.kind === 'tool-result') {
    const metadata = resultMetadataSummary(event)
    return [{
      kind: 'patch',
      id: terminalBlockId('tool', context.activityId, event.sessionId, event.callId),
      patch: {
        detail: metadata.length === 0 ? event.text : `${metadata}\n${event.text}`,
        state: event.isError ? 'error' : 'success',
        foldable: true,
        ...(event.upstreamTime === undefined ? {} : { endedAt: event.upstreamTime }),
      },
    }]
  }
  return []
}

function projectCordisActivities(events: readonly NormalizedEvent[]): CordisActivity[] {
  const byKey = new Map<string, CordisActivity>()
  const durations = toolCallDurations(events)
  for (const event of events) {
    const key = event.kind === 'tool-call' || event.kind === 'tool-result'
      ? toolProjectionKey(event.sessionId, event.callId)
      : undefined
    if (key === undefined) continue
    if (event.kind === 'tool-call' && isCordisToolName(event.name)) {
      byKey.set(key, { call: event, elapsedMs: durations.get(key) })
      continue
    }
    if (event.kind === 'tool-result') {
      const activity = byKey.get(key)
      if (activity !== undefined) activity.result = event
    }
  }
  return [...byKey.values()]
}

function formatActivity(activity: CordisActivity, rootSessionId: string): string {
  const call = activity.call
  const result = activity.result
  const outcome = result === undefined ? 'running / no result observed' : result.isError ? 'error' : 'success'
  const elapsed = activity.elapsedMs === undefined
    ? 'elapsed unknown'
    : activity.elapsedMs < 1000 ? `${activity.elapsedMs}ms` : `${(activity.elapsedMs / 1000).toFixed(1)}s`
  const scope = call.sessionId === rootSessionId ? '' : ` · session ${short(call.sessionId)}`
  const metadata = result === undefined ? '' : resultMetadataSummary(result)
  return [
    `${String(call.sequence).padStart(4, '0')} ${toolLabel(call.name)} · ${outcome} · ${elapsed}${scope}`,
    `     call ${short(call.callId)} · ${structuredArgumentSummary(call.arguments)}`,
    ...(result === undefined ? [] : [`     result ${result.text.length} retained chars${metadata.length === 0 ? '' : ` · ${metadata}`}${result.isError ? ` · ${preview(result.text)}` : ''}`]),
  ].join('\n')
}

function resultMetadataSummary(event: Extract<NormalizedEvent, { kind: 'tool-result' }>): string {
  const metadata = event.metadata
  if (metadata === undefined) return ''
  return (['pluginId', 'packageId', 'pluginRunId'] as const)
    .flatMap(key => metadata[key] === undefined ? [] : [`${key}=${JSON.stringify(sanitizeTerminalText(metadata[key]!))}`])
    .join(' · ')
}

function structuredArgumentSummary(raw: string): string {
  const args = parseArguments(raw)
  if (args === undefined) return raw.trim().length === 0 ? '(no arguments)' : `arguments: ${preview(raw)}`
  const fields: string[] = []
  for (const key of ['pluginId', 'packageId', 'mode', 'provider', 'method', 'name', 'purpose'] as const) {
    const value = args[key]
    if (typeof value === 'string') fields.push(`${key}=${JSON.stringify(sanitizeTerminalText(value))}`)
  }
  const plugin = recordAt(args, 'plugin')
  if (plugin !== undefined) {
    for (const key of ['kind', 'idPrefix', 'pluginId'] as const) {
      const value = plugin[key]
      if (typeof value === 'string') fields.push(`plugin.${key}=${JSON.stringify(sanitizeTerminalText(value))}`)
    }
  }
  const code = recordAt(args, 'code')
  if (code !== undefined) {
    if (typeof code.host === 'string') fields.push(`host=${code.host.length} chars`)
    if (typeof code.client === 'string') fields.push(`client=${code.client.length} chars`)
  }
  return fields.length === 0 ? '(structured arguments; no stable label fields)' : fields.join(' · ')
}

function findCordisCall(
  event: NormalizedEvent,
  events: readonly NormalizedEvent[],
): Extract<NormalizedEvent, { kind: 'tool-call' }> | undefined {
  if (event.kind !== 'tool-result') return undefined
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = events[index]
    if (candidate?.kind !== 'tool-call') continue
    if (candidate.sessionId === event.sessionId && candidate.callId === event.callId && isCordisToolName(candidate.name)) return candidate
  }
  return undefined
}

function parseArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function stringsAt(record: Record<string, unknown>, keys: readonly string[]): string[] {
  const values: string[] = []
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) values.push(value)
  }
  return values
}

function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolLabel(name: string): string {
  return name.replace(/^cordis_/, '').replaceAll('_', ' ')
}

function short(value: string): string {
  const safe = sanitizeTerminalText(value)
  return safe.length <= 18 ? safe : `${safe.slice(0, 8)}…${safe.slice(-7)}`
}

function preview(value: string): string {
  const safe = sanitizeTerminalText(value).replaceAll('\n', ' ')
  return safe.length <= 88 ? safe : `${safe.slice(0, 85)}...`
}
