import { describeToolCall } from '../plugins/coding.js'
import { toolProjectionKey, type NormalizedEvent } from '../session/projection.js'
import { classifyToolCall, isReadOnlyCommand, type RiskContext, type RiskTag } from './risk.js'

/**
 * What an operation review is shown about one finished turn, collected from
 * the events that turn produced and nothing else.
 *
 * Bounded on every axis, because it becomes a model prompt: long outputs keep
 * their head and tail (a test summary is usually at the end), and past a
 * point operations are counted rather than listed. What was left out is
 * always stated, so the reviewer never mistakes a cut for an absence.
 */
export interface EvidenceOperation {
  /** 1-based, over every non-plumbing call in the turn, so `#3` means the same thing everywhere. */
  number: number
  tool: string
  /** The transcript's own description of the call. */
  label: string
  /** Excerpt of the literal arguments; empty for look-only calls. */
  detail: string
  risks: readonly RiskTag[]
  outcome: 'ok' | 'error' | 'no result'
  /** Excerpt of the result, for calls that change something. */
  output?: string
  /** Made by a subagent rather than the agent the person talked to. */
  subagent: boolean
  /** Whether this call may have changed something; look-only calls are listed briefly. */
  changes: boolean
}

export interface TurnEvidence {
  sessionId: string
  /** What the person said: the request first, then anything added while it ran. */
  requests: readonly string[]
  /** Steps the agent declared with outline_plan, when it declared any. */
  plan?: readonly string[]
  operations: readonly EvidenceOperation[]
  /** Calls observed but not listed, to keep the review bounded. */
  omitted: number
  /** How many calls may have changed something, listed or not. */
  changing: number
  finalMessage?: string
  turnError?: string
  /** Events local retention dropped before this was collected. */
  droppedEvents: number
}

/** dshc's own plumbing: declaring a plan or asking a question is not work on the workspace. */
const PLUMBING = new Set(['outline_plan', 'request_user_input', 'present_plan', 'todo_write'])
/** Calls that only look, or that delegate to a child whose own calls are judged one by one. */
const LOOK_ONLY = new Set(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'vision', 'job_output', 'subagent', 'researcher', 'scout', 'planner', 'reviewer', 'oracle'])

const MAX_CHANGING = 30
const MAX_LOOKING = 25
const MAX_REQUESTS = 4
const REQUEST_CHARS = 1_500
const DETAIL_CHARS = 700
const OUTPUT_HEAD = 500
const OUTPUT_TAIL = 300
const FINAL_CHARS = 3_000

export interface TurnEvidenceInput {
  sessionId: string
  /** The prompt the turn was started with; used only if no user message was observed. */
  prompt: string
  events: readonly NormalizedEvent[]
  finalMessage?: string
  turnError?: string
  droppedEvents?: number
  risk?: RiskContext
}

/**
 * Evidence for reviewing a turn, or `undefined` when nothing in it could have
 * changed anything — a turn that only read and searched is not worth a review.
 */
export function collectTurnEvidence(input: TurnEvidenceInput): TurnEvidence | undefined {
  const results = new Map<string, Extract<NormalizedEvent, { kind: 'tool-result' }>>()
  for (const event of input.events) {
    if (event.kind === 'tool-result') results.set(toolProjectionKey(event.sessionId, event.callId), event)
  }

  const requests: string[] = []
  let plan: readonly string[] | undefined
  const operations: EvidenceOperation[] = []
  let number = 0
  let omitted = 0
  let changing = 0
  let listedChanging = 0
  let looking = 0

  for (const event of input.events) {
    // Only what a person said. A runtime-context snapshot arrives in the same
    // role and must not be presented as something they added.
    if (event.kind === 'user-message' && event.sessionId === input.sessionId && (event.source === undefined || event.source === 'user')) {
      if (requests.length < MAX_REQUESTS) requests.push(crop(event.text, REQUEST_CHARS))
      continue
    }
    if (event.kind !== 'tool-call') continue
    const args = parseArguments(event.arguments)
    if (event.name === 'outline_plan' && event.sessionId === input.sessionId) {
      const steps = args?.['steps']
      if (Array.isArray(steps)) plan = steps.filter((step): step is string => typeof step === 'string').map(step => crop(step, 200)).slice(0, 8)
      continue
    }
    if (PLUMBING.has(event.name)) continue

    number += 1
    const changes = mayChange(event.name, args)
    if (changes) changing += 1
    if (changes ? listedChanging >= MAX_CHANGING : looking >= MAX_LOOKING) {
      omitted += 1
      continue
    }
    if (changes) listedChanging += 1
    else looking += 1
    const result = results.get(toolProjectionKey(event.sessionId, event.callId))
    operations.push({
      number,
      tool: event.name,
      label: describeToolCall(event.name, event.arguments) ?? event.name,
      detail: changes ? detailOf(event.name, args, event.arguments) : '',
      risks: classifyToolCall(event.name, event.arguments, input.risk ?? {}),
      outcome: result === undefined ? 'no result' : result.isError ? 'error' : 'ok',
      ...(changes && result !== undefined ? { output: headAndTail(result.text) } : {}),
      subagent: event.sessionId !== input.sessionId,
      changes,
    })
  }

  if (changing === 0) return undefined
  return {
    sessionId: input.sessionId,
    requests: requests.length > 0 ? requests : [crop(input.prompt, REQUEST_CHARS)],
    ...(plan === undefined ? {} : { plan }),
    operations,
    omitted,
    changing,
    ...(input.finalMessage === undefined || input.finalMessage.trim() === '' ? {} : { finalMessage: crop(input.finalMessage, FINAL_CHARS) }),
    ...(input.turnError === undefined ? {} : { turnError: crop(input.turnError, 500) }),
    droppedEvents: input.droppedEvents ?? 0,
  }
}

function mayChange(name: string, args: Record<string, unknown> | undefined): boolean {
  if (name === 'write' || name === 'edit') return true
  if (name === 'pwsh' || name === 'bash') {
    const command = args?.['command']
    return typeof command !== 'string' || !isReadOnlyCommand(command)
  }
  if (LOOK_ONLY.has(name)) return false
  // MCP servers and tools dshc does not know can do anything.
  return true
}

function detailOf(name: string, args: Record<string, unknown> | undefined, raw: string): string {
  if (args === undefined) return crop(raw, DETAIL_CHARS)
  const text = (key: string): string | undefined => typeof args[key] === 'string' ? args[key] : undefined
  switch (name) {
    case 'pwsh':
    case 'bash': {
      const workdir = text('workdir')
      return crop(`${workdir === undefined ? '' : `(in ${workdir}) `}${text('command') ?? raw}`, DETAIL_CHARS)
    }
    case 'write': {
      const content = text('content') ?? ''
      return `${text('file_path') ?? '?'} · ${content.length} chars · starts: ${JSON.stringify(crop(content, 300))}`
    }
    case 'edit':
      return `${text('file_path') ?? '?'} · ${JSON.stringify(crop(text('old_string') ?? '', 250))} → ${JSON.stringify(crop(text('new_string') ?? '', 250))}${args['replace_all'] === true ? ' · all matches' : ''}`
    default:
      return crop(raw, DETAIL_CHARS)
  }
}

function headAndTail(text: string): string {
  if (text.length <= OUTPUT_HEAD + OUTPUT_TAIL + 40) return text
  return `${text.slice(0, OUTPUT_HEAD)}\n… ${text.length - OUTPUT_HEAD - OUTPUT_TAIL} chars omitted …\n${text.slice(-OUTPUT_TAIL)}`
}

function crop(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function parseArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}
