import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'

export type SessionActivity = 'starting' | 'initializing' | 'idle' | 'running' | 'shutting-down' | 'closed' | 'failed'

/**
 * Public facts carried on the `session.event` envelope, kept distinct from
 * anything dshc computes locally. Absent on notifications that are not session
 * events, and individually absent when upstream omits them.
 */
export interface UpstreamEventEnvelope {
  /** Upstream event timestamp in ms. Not when dshc observed the notification. */
  upstreamTime?: number
  /** Upstream event sequence. Distinct from dshc's local `sequence` counter. */
  upstreamSeq?: number
  /** Upstream sequences this event derives from; a result links back to its call. */
  sourceEventSeqs?: readonly number[]
}

/**
 * Token accounting one model request reported, exactly as upstream sends it.
 *
 * Counts are disjoint: `inputTokens` is uncached input, with cache reads and
 * writes reported separately. Capacity is not part of this usage object;
 * `/context` correlates it only with a separately observed public
 * `request/context.contextWindow` event. The sum of the latest request's input
 * fields is the true request-input size even when no capacity was advertised.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Allowlisted public presentation metadata observed on tool/result.data.meta. */
export interface ToolResultMetadata {
  pluginId?: string
  packageId?: string
  pluginRunId?: string
}

export type NormalizedEvent = UpstreamEventEnvelope & (
  | { sequence: number; kind: 'session-status'; sessionId: string; status: 'running' | 'idle' }
  | { sequence: number; kind: 'user-message'; sessionId: string; text: string }
  | { sequence: number; kind: 'assistant-delta'; sessionId: string; text: string }
  | { sequence: number; kind: 'assistant-message'; sessionId: string; text: string; usage?: TokenUsage }
  | { sequence: number; kind: 'tool-call'; sessionId: string; callId: string; name: string; arguments: string }
  | { sequence: number; kind: 'tool-result'; sessionId: string; callId: string; name?: string; metadata?: ToolResultMetadata; text: string; isError: boolean }
  | { sequence: number; kind: 'subagent-started'; parentSessionId: string; childSessionId: string; provider?: string }
  | { sequence: number; kind: 'subagent-finished'; parentSessionId: string; childSessionId: string }
  | { sequence: number; kind: 'turn-error'; sessionId: string; message: string }
  | { sequence: number; kind: 'session-title'; sessionId: string; title: string; source?: string }
  | { sequence: number; kind: 'context-compacted'; sessionId: string; shadowedEvents: number; shadowedTokens?: number; summary: string }
  | { sequence: number; kind: 'request-context'; sessionId: string; provider: string; model: string; contextWindow?: number }
  | { sequence: number; kind: 'approval-asked'; sessionId: string; requestId: string; toolName: string; callId?: string; reason?: string }
  | { sequence: number; kind: 'approval-decided'; sessionId: string; requestId: string; outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }
  | { sequence: number; kind: 'approval-policy'; sessionId: string; policy: 'ask' | 'never'; source?: 'delegation' }
  | { sequence: number; kind: 'internal'; sessionId?: string; type: string }
  | { sequence: number; kind: 'unknown'; sessionId?: string; method: string; type?: string }
)

export interface ToolProjection {
  sessionId: string
  callId: string
  name: string
  arguments: string
  result?: string
  isError?: boolean
}

export interface SubagentProjection {
  childSessionId: string
  parentSessionId: string
  provider?: string
  status: 'running' | 'finished'
}

export interface ProjectionState {
  rootSessionId?: string
  activity: SessionActivity
  lastAssistantMessage: string
  streamedAssistantText: string
  lastTurnError?: string
  tools: ReadonlyMap<string, ToolProjection>
  subagents: ReadonlyMap<string, SubagentProjection>
  unknownEventCount: number
}

export function initialProjectionState(rootSessionId?: string): ProjectionState {
  return {
    ...(rootSessionId === undefined ? {} : { rootSessionId }),
    activity: 'starting',
    lastAssistantMessage: '',
    streamedAssistantText: '',
    tools: new Map(),
    subagents: new Map(),
    unknownEventCount: 0,
  }
}

export function toolProjectionKey(sessionId: string, callId: string): string {
  return `${sessionId.length}:${sessionId}${callId}`
}

/**
 * Pair each tool result with its call and report the elapsed upstream time.
 *
 * The span comes from the timestamps upstream puts on the events themselves,
 * never from when dshc observed them: a locally measured interval would fold in
 * transport and scheduling delay and present a dshc-invented number as a fact
 * about the tool. Pairing prefers `sourceEventSeqs`, which is upstream's own
 * causal link, and falls back to (sessionId, callId) — never callId alone.
 *
 * A pair missing either timestamp, or one that runs backwards, is reported as
 * unknown rather than guessed.
 */
export function toolCallDurations(events: readonly NormalizedEvent[]): ReadonlyMap<string, number> {
  const startedBySeq = new Map<number, number>()
  const startedByKey = new Map<string, number>()
  const durations = new Map<string, number>()

  for (const event of events) {
    if (event.kind === 'tool-call') {
      if (event.upstreamTime === undefined) continue
      startedByKey.set(toolProjectionKey(event.sessionId, event.callId), event.upstreamTime)
      if (event.upstreamSeq !== undefined) startedBySeq.set(event.upstreamSeq, event.upstreamTime)
      continue
    }
    if (event.kind !== 'tool-result' || event.upstreamTime === undefined) continue

    const key = toolProjectionKey(event.sessionId, event.callId)
    let started: number | undefined
    for (const seq of event.sourceEventSeqs ?? []) {
      started = startedBySeq.get(seq)
      if (started !== undefined) break
    }
    started ??= startedByKey.get(key)
    if (started === undefined) continue

    const elapsed = event.upstreamTime - started
    if (elapsed >= 0) durations.set(key, elapsed)
  }

  return durations
}

export function reduceProjection(state: ProjectionState, event: NormalizedEvent): ProjectionState {
  switch (event.kind) {
    case 'session-status':
      return isRootSession(state, event.sessionId) ? { ...state, activity: event.status } : state
    case 'assistant-delta':
      return isRootSession(state, event.sessionId)
        ? { ...state, streamedAssistantText: state.streamedAssistantText + event.text }
        : state
    case 'assistant-message':
      return isRootSession(state, event.sessionId)
        ? { ...state, lastAssistantMessage: event.text, streamedAssistantText: '' }
        : state
    case 'tool-call': {
      const tools = new Map(state.tools)
      tools.set(toolProjectionKey(event.sessionId, event.callId), {
        sessionId: event.sessionId,
        callId: event.callId,
        name: event.name,
        arguments: event.arguments,
      })
      return { ...state, tools }
    }
    case 'tool-result': {
      const tools = new Map(state.tools)
      const key = toolProjectionKey(event.sessionId, event.callId)
      const previous = tools.get(key)
      tools.set(key, {
        sessionId: event.sessionId,
        callId: event.callId,
        name: event.name ?? previous?.name ?? 'unknown-tool',
        arguments: previous?.arguments ?? '',
        result: event.text,
        isError: event.isError,
      })
      return { ...state, tools }
    }
    case 'subagent-started': {
      const subagents = new Map(state.subagents)
      subagents.set(event.childSessionId, {
        childSessionId: event.childSessionId,
        parentSessionId: event.parentSessionId,
        ...(event.provider === undefined ? {} : { provider: event.provider }),
        status: 'running',
      })
      return { ...state, subagents }
    }
    case 'subagent-finished': {
      const subagents = new Map(state.subagents)
      const previous = subagents.get(event.childSessionId)
      subagents.set(event.childSessionId, {
        childSessionId: event.childSessionId,
        parentSessionId: event.parentSessionId,
        ...(previous?.provider === undefined ? {} : { provider: previous.provider }),
        status: 'finished',
      })
      return { ...state, subagents }
    }
    case 'turn-error':
      return isRootSession(state, event.sessionId)
        ? { ...state, activity: 'failed', lastTurnError: event.message }
        : state
    case 'unknown':
      return { ...state, unknownEventCount: state.unknownEventCount + 1 }
    case 'user-message':
    case 'session-title':
    case 'context-compacted':
    case 'request-context':
    case 'approval-asked':
    case 'approval-decided':
    case 'approval-policy':
    case 'internal':
      return state
  }
}

export class SessionProjector {
  private sequence = 0
  private currentState: ProjectionState

  constructor(rootSessionId?: string) {
    this.currentState = initialProjectionState(rootSessionId)
  }

  get state(): ProjectionState {
    return this.currentState
  }

  ingest(notification: HarnessNotification): NormalizedEvent {
    let event = normalizeNotification(notification, this.sequence++)
    if (event.kind === 'tool-result' && event.name === undefined) {
      const previous = this.currentState.tools.get(toolProjectionKey(event.sessionId, event.callId))
      if (previous !== undefined) event = { ...event, name: previous.name }
    }
    this.currentState = reduceProjection(this.currentState, event)
    return event
  }
}

export function normalizeNotification(notification: HarnessNotification, sequence = 0): NormalizedEvent {
  const event = classifyNotification(notification, sequence)
  const envelope = readEnvelope(notification)
  return Object.keys(envelope).length === 0 ? event : { ...event, ...envelope }
}

/**
 * Reads the envelope facts upstream publishes alongside every session event.
 * Each is optional: a missing field stays missing rather than being defaulted,
 * so a consumer can tell "upstream did not say" from "upstream said zero".
 */
function readEnvelope(notification: HarnessNotification): UpstreamEventEnvelope {
  if (notification.method !== 'session.event') return {}
  const rawEvent = recordField(notification.params, 'event')
  if (rawEvent === undefined) return {}

  const envelope: UpstreamEventEnvelope = {}
  const time = numberField(rawEvent, 'time')
  if (time !== undefined) envelope.upstreamTime = time
  const seq = numberField(rawEvent, 'seq')
  if (seq !== undefined) envelope.upstreamSeq = seq
  const sources = rawEvent['sourceEventSeqs']
  if (Array.isArray(sources)) {
    const numeric = sources.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    if (numeric.length > 0) envelope.sourceEventSeqs = numeric
  }
  return envelope
}

function classifyNotification(notification: HarnessNotification, sequence: number): NormalizedEvent {
  const params = notification.params

  if (notification.method === 'session.status') {
    const sessionId = stringField(params, 'sessionId')
    const status = params.status
    if (sessionId !== undefined && (status === 'running' || status === 'idle')) {
      return { sequence, kind: 'session-status', sessionId, status }
    }
  }

  if (notification.method === 'subagent.started') {
    const parentSessionId = stringField(params, 'parentSessionId')
    const childSessionId = stringField(params, 'childSessionId')
    if (parentSessionId !== undefined && childSessionId !== undefined) {
      const provider = stringField(params, 'providerName') ?? stringField(params, 'provider')
      return {
        sequence,
        kind: 'subagent-started',
        parentSessionId,
        childSessionId,
        ...(provider === undefined ? {} : { provider }),
      }
    }
  }

  if (notification.method === 'subagent.finished') {
    const parentSessionId = stringField(params, 'parentSessionId')
    const childSessionId = stringField(params, 'childSessionId')
    if (parentSessionId !== undefined && childSessionId !== undefined) {
      return { sequence, kind: 'subagent-finished', parentSessionId, childSessionId }
    }
  }

  if (notification.method !== 'session.event') {
    return {
      sequence,
      kind: 'unknown',
      sessionId: stringField(params, 'sessionId'),
      method: notification.method,
    }
  }

  const sessionId = stringField(params, 'sessionId')
  const rawEvent = recordField(params, 'event')
  const type = rawEvent === undefined ? undefined : stringField(rawEvent, 'type')
  if (sessionId === undefined || rawEvent === undefined || type === undefined) {
    return { sequence, kind: 'unknown', sessionId, method: notification.method, type }
  }

  const data = recordField(rawEvent, 'data')

  if (type === 'user/message') {
    return { sequence, kind: 'user-message', sessionId, text: extractContentText(data?.content) }
  }

  if (type === 'assistant/chunk') {
    const chunk = data === undefined ? undefined : recordField(data, 'chunk')
    if (chunk !== undefined && stringField(chunk, 'type') === 'text-delta') {
      return { sequence, kind: 'assistant-delta', sessionId, text: stringField(chunk, 'text') ?? '' }
    }
    // Reasoning and tool-call deltas are intentionally not surfaced as text in M1/M2.
    return { sequence, kind: 'internal', sessionId, type }
  }

  if (type === 'assistant/message') {
    const message = data === undefined ? undefined : recordField(data, 'message')
    // `usage` is a sibling of `message`, not a field inside it. The same numbers
    // also stream as an `assistant/chunk` of type `usage`; this durable surface
    // event is authoritative, so the chunk deliberately stays internal and the
    // totals are not counted twice.
    const usage = data === undefined ? undefined : readTokenUsage(recordField(data, 'usage'))
    return {
      sequence,
      kind: 'assistant-message',
      sessionId,
      text: extractContentText(message?.content),
      ...(usage === undefined ? {} : { usage }),
    }
  }

  if (type === 'tool/call') {
    const callId = stringField(data, 'callId')
    if (callId === undefined) {
      return { sequence, kind: 'unknown', sessionId, method: notification.method, type }
    }
    return {
      sequence,
      kind: 'tool-call',
      sessionId,
      callId,
      name: stringField(data, 'name') ?? 'unknown-tool',
      arguments: stringField(data, 'arguments') ?? '',
    }
  }

  if (type === 'tool/result') {
    const message = data === undefined ? undefined : recordField(data, 'message')
    const error = data === undefined ? undefined : recordField(data, 'error')
    const result = extractToolResult(message)
    const metadata = readToolResultMetadata(recordField(data, 'meta'))
    const callId = result.callId
      ?? stringField(recordField(message, 'source'), 'callId')
      ?? stringField(message, 'toolCallId')
      ?? stringField(data, 'callId')
    if (callId === undefined) {
      return { sequence, kind: 'unknown', sessionId, method: notification.method, type }
    }
    return {
      sequence,
      kind: 'tool-result',
      sessionId,
      callId,
      ...(stringField(data, 'name') === undefined ? {} : { name: stringField(data, 'name') }),
      ...(metadata === undefined ? {} : { metadata }),
      text: result.text,
      isError: error !== undefined || result.isError || message?.isError === true,
    }
  }

  if (type === 'compaction/summary') {
    // Compaction replaces part of the conversation the model can see, so it is
    // state-changing activity and has to be visible. Counts come straight from
    // the event; an absent token count stays absent rather than being guessed.
    const shadowed = data?.['shadowedSeqs']
    return {
      sequence,
      kind: 'context-compacted',
      sessionId,
      shadowedEvents: Array.isArray(shadowed) ? shadowed.length : 0,
      ...(numberField(data, 'shadowedTokenCount') === undefined
        ? {}
        : { shadowedTokens: numberField(data, 'shadowedTokenCount') }),
      summary: stringField(data, 'summary') ?? '',
    }
  }

  if (type === 'session/title') {
    // Session naming metadata, not agent activity. The title is model-authored
    // text and stays untrusted until a renderer sanitizes it.
    const source = data === undefined ? undefined : recordField(data, 'source')
    const kind = stringField(source, 'kind')
    return {
      sequence,
      kind: 'session-title',
      sessionId,
      title: stringField(data, 'title') ?? '',
      ...(kind === undefined ? {} : { source: kind }),
    }
  }

  if (type === 'request/context') {
    const provider = stringField(data, 'provider')
    const model = stringField(data, 'model')
    if (provider !== undefined && model !== undefined) {
      const contextWindow = positiveSafeIntegerField(data, 'contextWindow')
      return {
        sequence,
        kind: 'request-context',
        sessionId,
        provider,
        model,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      }
    }
    return { sequence, kind: 'internal', sessionId, type }
  }

  if (type === 'approval/asked') {
    const requestId = stringField(data, 'id')
    const toolName = stringField(data, 'toolName')
    if (requestId !== undefined && toolName !== undefined) {
      const callId = stringField(data, 'callId')
      const reason = stringField(data, 'reason')
      return {
        sequence,
        kind: 'approval-asked',
        sessionId,
        requestId,
        toolName,
        ...(callId === undefined ? {} : { callId }),
        ...(reason === undefined ? {} : { reason }),
      }
    }
    return { sequence, kind: 'internal', sessionId, type }
  }

  if (type === 'approval/decided') {
    const requestId = stringField(data, 'id')
    const outcome = stringField(data, 'outcome')
    if (requestId !== undefined && isApprovalOutcome(outcome)) {
      return { sequence, kind: 'approval-decided', sessionId, requestId, outcome }
    }
    return { sequence, kind: 'internal', sessionId, type }
  }

  if (type === 'approval/policy') {
    const policy = stringField(data, 'policy')
    const source = stringField(data, 'source')
    if (policy === 'ask' || policy === 'never') {
      return {
        sequence,
        kind: 'approval-policy',
        sessionId,
        policy,
        ...(source === 'delegation' ? { source } : {}),
      }
    }
    return { sequence, kind: 'internal', sessionId, type }
  }

  if (type === 'turn/end') {
    const reason = data === undefined ? undefined : recordField(data, 'reason')
    if (stringField(reason, 'kind') === 'error') {
      const failure = reason === undefined ? undefined : recordField(reason, 'error')
      return {
        sequence,
        kind: 'turn-error',
        sessionId,
        message: stringField(failure, 'message') ?? 'Harness turn failed',
      }
    }
    return { sequence, kind: 'internal', sessionId, type }
  }

  if (type === 'compaction/start' || type === 'agent/inbox/spliced' || type === 'turn/start' || type === 'step/start' || type === 'step/end' || type === 'request/header') {
    return { sequence, kind: 'internal', sessionId, type }
  }

  return { sequence, kind: 'unknown', sessionId, method: notification.method, type }
}

function readToolResultMetadata(source: Record<string, unknown> | undefined): ToolResultMetadata | undefined {
  if (source === undefined) return undefined
  const metadata: ToolResultMetadata = {}
  for (const key of ['pluginId', 'packageId', 'pluginRunId'] as const) {
    const value = stringField(source, key)
    if (value !== undefined) metadata[key] = value
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata
}

export function isInboxReceipt(notification: HarnessNotification, sessionId: string, messageId: string): boolean {
  if (notification.method !== 'session.event' || notification.params.sessionId !== sessionId) return false
  const event = recordField(notification.params, 'event')
  if (stringField(event, 'type') !== 'agent/inbox/spliced') return false
  const data = event === undefined ? undefined : recordField(event, 'data')
  const inserted = data?.inserted
  return Array.isArray(inserted) && inserted.some((message) => isRecord(message) && message.id === messageId)
}

function isRootSession(state: ProjectionState, sessionId: string): boolean {
  return state.rootSessionId === undefined || state.rootSessionId === sessionId
}

interface ToolResultParts {
  callId: string | undefined
  text: string
  isError: boolean
}

/**
 * A DSH tool result nests its payload: `message.content` carries `tool-result`
 * blocks, and each block owns the call id, the actual output as its own nested
 * content array, and the error flag. Reading only the outer array yields an
 * empty string and a permanently false `isError`, which silently renders failed
 * tool calls as successes. Plain text blocks are still accepted so a simpler
 * shape degrades instead of disappearing.
 */
function extractToolResult(message: Record<string, unknown> | undefined): ToolResultParts {
  const content = message?.['content']
  if (!Array.isArray(content)) return { callId: undefined, text: '', isError: false }

  let callId: string | undefined
  let isError = false
  const text: string[] = []

  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'tool-result') {
      callId ??= typeof block.toolCallId === 'string' ? block.toolCallId : undefined
      if (block.isError === true) isError = true
      const nested = extractContentText(block.content)
      if (nested.length > 0) text.push(nested)
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text)
  }

  return { callId, text: text.join(''), isError }
}

function extractContentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const text: string[] = []
  for (const block of value) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    text.push(block.text)
  }
  return text.join('')
}

/** Read usage, keeping only the fields upstream actually reported. */
function readTokenUsage(source: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (source === undefined) return undefined
  const inputTokens = nonNegativeSafeIntegerField(source, 'inputTokens')
  const outputTokens = nonNegativeSafeIntegerField(source, 'outputTokens')
  if (inputTokens === undefined && outputTokens === undefined) return undefined

  const optional = (name: string): Record<string, number> => {
    const value = nonNegativeSafeIntegerField(source, name)
    return value === undefined ? {} : { [name]: value }
  }
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...optional('cacheReadTokens'),
    ...optional('cacheWriteTokens'),
    ...optional('reasoningTokens'),
  }
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function positiveSafeIntegerField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = nonNegativeSafeIntegerField(value, key)
  return field !== undefined && field > 0 ? field : undefined
}

function nonNegativeSafeIntegerField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key]
  return typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined
}

function isApprovalOutcome(value: string | undefined): value is 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' {
  return value === 'allowed-once' || value === 'rejected' || value === 'cancelled' || value === 'unavailable'
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key]
  return typeof field === 'string' ? field : undefined
}

function recordField(value: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const field = value?.[key]
  return isRecord(field) ? field : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
