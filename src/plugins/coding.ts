import type { NormalizedEvent } from '../session/projection.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import { terminalBlockId } from '../terminal/transcript.js'
import {
  TERMINAL_PLUGIN_API_VERSION,
  type TerminalPluginSpec,
  type TerminalRenderContext,
  type TranscriptMutation,
} from './api.js'

export const VALIDATED_DEFAULT_CODING_TOOLS = [
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'bash',
  'pwsh',
  'subagent',
  'todo_write',
] as const

const SPECIALIZED_TOOLS = new Set<string>([
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'todo_write',
])

export function codingActivityPlugin(): TerminalPluginSpec {
  return {
    id: 'dshc.coding',
    version: '1.0.0',
    apiVersion: TERMINAL_PLUGIN_API_VERSION,
    eventRenderers: [{
      id: 'coding-tool-call',
      priority: 120,
      // A specialized renderer owns an event only when it can fully explain
      // the observed arguments. Malformed or future argument shapes therefore
      // continue to the generic safe tool renderer instead of disappearing.
      match: isSpecializableCodingCall,
      render: (event, context) => codingToolMutations(event, context),
    }],
  }
}

function isSpecializableCodingCall(event: NormalizedEvent): boolean {
  if (event.kind !== 'tool-call' || !SPECIALIZED_TOOLS.has(event.name)) return false
  const args = parseArguments(event.arguments)
  return args !== undefined && presentCodingCall(event.name, args) !== undefined
}

function codingToolMutations(event: NormalizedEvent, context: TerminalRenderContext): readonly TranscriptMutation[] {
  if (event.kind !== 'tool-call') return []
  const args = parseArguments(event.arguments)
  if (args === undefined) return []
  const presentation = presentCodingCall(event.name, args)
  if (presentation === undefined) return []

  return [{
    kind: 'append',
    block: {
      id: terminalBlockId('tool', context.activityId, event.sessionId, event.callId),
      kind: 'tool',
      title: scopedTitle(presentation.title, event.sessionId, context.rootSessionId),
      text: presentation.text,
      state: 'running',
      foldable: true,
      sessionId: event.sessionId,
      activityId: context.activityId,
      ...(event.upstreamTime === undefined ? {} : { startedAt: event.upstreamTime }),
    },
  }]
}

interface ToolPresentation {
  title: string
  text: string
}

/**
 * The compact description the transcript already shows for a call, reused so a
 * second surface cannot drift from it. Undefined when the arguments are not
 * fully explainable, which is the same condition under which the specialized
 * renderer declines the event.
 */
export function describeToolCall(name: string, argumentsJson: string): string | undefined {
  const args = parseArguments(argumentsJson)
  if (args === undefined) return undefined
  return presentCodingCall(name, args)?.title
}

function presentCodingCall(name: string, args: Record<string, unknown>): ToolPresentation | undefined {
  switch (name) {
    case 'read': {
      const path = stringArg(args, 'file_path')
      if (path === undefined) return undefined
      return { title: `read · ${safeInline(path)}`, text: 'Inspect file' }
    }
    case 'write': {
      const path = stringArg(args, 'file_path')
      const content = stringArg(args, 'content')
      if (path === undefined || content === undefined) return undefined
      return { title: `write · ${safeInline(path)}`, text: `Create or replace file · ${content.length} chars` }
    }
    case 'edit': {
      const path = stringArg(args, 'file_path')
      const before = stringArg(args, 'old_string')
      const after = stringArg(args, 'new_string')
      if (path === undefined || before === undefined || after === undefined) return undefined
      return {
        title: `edit · ${safeInline(path)}`,
        text: `${quotedPreview(before)} → ${quotedPreview(after)}${args['replace_all'] === true ? ' · all matches' : ''}`,
      }
    }
    case 'glob': {
      const pattern = stringArg(args, 'pattern')
      if (pattern === undefined) return undefined
      const path = optionalStringArg(args, 'path')
      return { title: `glob · ${safeInline(pattern)}`, text: path === undefined ? 'Search workspace paths' : `Search under ${safeInline(path)}` }
    }
    case 'grep': {
      const pattern = stringArg(args, 'pattern')
      if (pattern === undefined) return undefined
      const path = optionalStringArg(args, 'path')
      const include = optionalStringArg(args, 'include')
      const scope = path === undefined ? 'workspace' : safeInline(path)
      return { title: `grep · ${safeInline(pattern)}`, text: `Search ${scope}${include === undefined ? '' : ` · ${safeInline(include)}`}` }
    }
    case 'bash':
    case 'pwsh': {
      const command = stringArg(args, 'command')
      const description = stringArg(args, 'description')
      if (command === undefined || description === undefined) return undefined
      return { title: `${name} · ${safeInline(description)}`, text: sanitizeTerminalText(command) }
    }
    case 'todo_write': {
      const todos = args['todos']
      if (!Array.isArray(todos)) return undefined
      return { title: `todo · ${todos.length} item${todos.length === 1 ? '' : 's'}`, text: summarizeTodos(todos) }
    }
    default:
      return undefined
  }
}

function parseArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function summarizeTodos(todos: unknown[]): string {
  const statuses = new Map<string, number>()
  for (const todo of todos) {
    if (todo === null || typeof todo !== 'object') continue
    const status = (todo as Record<string, unknown>)['status']
    if (typeof status === 'string') statuses.set(status, (statuses.get(status) ?? 0) + 1)
  }
  if (statuses.size === 0) return 'Update task list'
  return [...statuses.entries()].map(([status, count]) => `${safeInline(status)}:${count}`).join(' · ')
}

function safeInline(value: string): string {
  return sanitizeTerminalText(value).replaceAll('\n', ' ')
}

function quotedPreview(value: string): string {
  const safe = safeInline(value)
  const clipped = safe.length <= 48 ? safe : `${safe.slice(0, 45)}...`
  return JSON.stringify(clipped)
}

function scopedTitle(base: string, sessionId: string, rootSessionId: string): string {
  if (sessionId === rootSessionId) return base
  return `${base} · ${short(sessionId)}`
}

function short(value: string): string {
  const safe = sanitizeTerminalText(value)
  return safe.length <= 16 ? safe : `${safe.slice(0, 7)}…${safe.slice(-6)}`
}
