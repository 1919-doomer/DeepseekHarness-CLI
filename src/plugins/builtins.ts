import type { NormalizedEvent } from '../session/projection.js'
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
import { TerminalPluginHost } from './host.js'

export function createDefaultTerminalHost(): TerminalPluginHost {
  const host = new TerminalPluginHost()
  host.register(corePlugin())
  host.register(codingActivityPlugin())
  host.register(activityPlugin())
  return host
}

function corePlugin(): TerminalPluginSpec {
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
      { name: 'trace', summary: 'Open the bounded normalized event timeline; hidden reasoning is never reconstructed', execute: () => ({ kind: 'view', viewId: 'trace' }) },
      { name: 'agents', summary: 'Show current root/descendant topology projected from public events', execute: () => ({ kind: 'view', viewId: 'agents' }) },
      { name: 'exit', aliases: ['quit'], summary: 'Close the owned Harness runtime and exit', execute: () => ({ kind: 'exit' }) },
    ],
    views: [
      { id: 'help', title: 'Help', render: renderHelp },
      { id: 'capabilities', title: 'Capability Explorer', render: renderCapabilities },
      { id: 'trace', title: 'Session Trace', render: renderTrace },
      { id: 'agents', title: 'Agent Topology', render: renderAgents },
    ],
    statusSegments: [
      { id: 'phase', priority: 100, render: context => context.phase },
      { id: 'model', priority: 90, render: context => context.runtime.model },
      { id: 'session', priority: 80, render: context => compactSession(context.session.sessionId) },
      { id: 'turns', priority: 70, render: context => `turns:${context.totalTurns}` },
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
  return `Commands exposed by the active terminal plugin host:\n\n${rows.join('\n\n')}\n\nUse //text to send a literal prompt beginning with /.`
}

function renderCapabilities(context: TerminalViewContext): string {
  const plugins = context.plugins.map(plugin => `${plugin.id}@${plugin.version}`).join(', ') || 'none'
  const renderers = context.renderers.map(renderer => `${renderer.id}@${renderer.pluginId}`).join(', ') || 'generic safe fallback only'
  const defaultShell = process.platform === 'win32' ? 'pwsh' : 'bash'
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
    'Shipped default coding baseline: locally validated; not runtime discovery; overrides may differ',
    `- tools: ${VALIDATED_DEFAULT_CODING_TOOLS.filter(tool => tool !== 'bash' && tool !== 'pwsh').join(', ')}, ${defaultShell}`,
    '',
    `Terminal plugins: ${plugins}`,
    `Specialized renderers: ${renderers}`,
    `Commands: ${context.commands.map(command => `/${command.name}`).join(', ')}`,
  ].join('\n')
}

function renderTrace(context: TerminalViewContext): string {
  const retention = context.retention
  if (context.events.length === 0) {
    return retention !== undefined && retention.droppedEventCount > 0
      ? `No retained normalized events. ${retention.droppedEventCount} older events were evicted from local trace retention.`
      : 'No normalized runtime events have been observed in this terminal process yet.'
  }

  const visible = context.events.slice(-120)
  const absoluteStart = retention === undefined
    ? context.events.length - visible.length
    : retention.totalEventCount - visible.length
  const lines = visible.map((event, index) => formatTraceEvent(event, absoluteStart + index))
  const notes: string[] = []
  if (retention !== undefined && retention.droppedEventCount > 0) {
    notes.push(`retention: ${retention.droppedEventCount} older normalized events evicted locally; total observed ${retention.totalEventCount}`)
  }
  if (context.events.length > visible.length) {
    notes.push(`view: showing newest ${visible.length} of ${context.events.length} retained events`)
  }
  return notes.length === 0 ? lines.join('\n') : `${notes.join('\n')}\n\n${lines.join('\n')}`
}

export function formatTraceEvent(event: NormalizedEvent, timelineIndex = event.sequence): string {
  const prefix = String(timelineIndex).padStart(4, '0')
  switch (event.kind) {
    case 'session-status': return `${prefix} session ${short(event.sessionId)} ${event.status}`
    case 'user-message': return `${prefix} user ${short(event.sessionId)} ${preview(event.text)}`
    case 'assistant-delta': return `${prefix} assistant.stream ${short(event.sessionId)} +${event.text.length} retained chars`
    case 'assistant-message': return `${prefix} assistant.commit ${short(event.sessionId)} ${event.text.length} retained chars`
    case 'tool-call': return `${prefix} tool.call ${short(event.sessionId)} ${sanitizeTerminalText(event.name)} ${short(event.callId)}`
    case 'tool-result': return `${prefix} tool.${event.isError ? 'error' : 'result'} ${short(event.sessionId)} ${short(event.callId)} ${event.text.length} retained chars`
    case 'subagent-started': return `${prefix} agent.start ${short(event.childSessionId)} <- ${short(event.parentSessionId)}`
    case 'subagent-finished': return `${prefix} agent.finish ${short(event.childSessionId)} <- ${short(event.parentSessionId)}`
    case 'turn-error': return `${prefix} turn.error ${short(event.sessionId)} ${preview(event.message)}`
    case 'internal': return `${prefix} internal${event.sessionId === undefined ? '' : ` ${short(event.sessionId)}`} ${sanitizeTerminalText(event.type)}`
    case 'unknown': return `${prefix} unknown${event.sessionId === undefined ? '' : ` ${short(event.sessionId)}`} ${sanitizeTerminalText(event.method)}${event.type === undefined ? '' : `/${sanitizeTerminalText(event.type)}`}`
  }
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
  return `runtime=${context.runtime.serverName}/${context.runtime.protocolVersion} provider=${context.runtime.provider} model=${context.runtime.model} phase=${context.phase} session=${context.session.sessionId} turns=${context.totalTurns} workspace=${context.runtime.workspace}`
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
