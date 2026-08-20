import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'

export type SessionActivity = 'starting' | 'initializing' | 'idle' | 'running' | 'shutting-down' | 'closed' | 'failed'

export type NormalizedEvent =
  | { sequence: number; kind: 'session-status'; sessionId: string; status: 'running' | 'idle' }
  | { sequence: number; kind: 'user-message'; sessionId: string; text: string }
  | { sequence: number; kind: 'assistant-delta'; sessionId: string; text: string }
  | { sequence: number; kind: 'assistant-message'; sessionId: string; text: string }
  | { sequence: number; kind: 'tool-call'; sessionId: string; callId: string; name: string; arguments: string }
  | { sequence: number; kind: 'tool-result'; sessionId: string; callId: string; text: string; isError: boolean }
  | { sequence: number; kind: 'subagent-started'; parentSessionId: string; childSessionId: string; provider?: string }
  | { sequence: number; kind: 'subagent-finished'; parentSessionId: string; childSessionId: string }
  | { sequence: number; kind: 'turn-error'; sessionId: string; message: string }
  | { sequence: number; kind: 'internal'; sessionId?: string; type: string }
  | { sequence: number; kind: 'unknown'; sessionId?: string; method: string; type?: string }

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
        name: previous?.name ?? 'unknown-tool',
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
    const event = normalizeNotification(notification, this.sequence++)
    this.currentState = reduceProjection(this.currentState, event)
    return event
  }
}

export function normalizeNotification(notification: HarnessNotification, sequence = 0): NormalizedEvent {
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
    return {
      sequence,
      kind: 'assistant-message',
      sessionId,
      text: extractContentText(message?.content),
    }
  }

  if (type === 'tool/call') {
    return {
      sequence,
      kind: 'tool-call',
      sessionId,
      callId: stringField(data, 'callId') ?? 'unknown-call',
      name: stringField(data, 'name') ?? 'unknown-tool',
      arguments: stringField(data, 'arguments') ?? '',
    }
  }

  if (type === 'tool/result') {
    const message = data === undefined ? undefined : recordField(data, 'message')
    const error = data === undefined ? undefined : recordField(data, 'error')
    return {
      sequence,
      kind: 'tool-result',
      sessionId,
      callId: stringField(message, 'toolCallId') ?? stringField(data, 'callId') ?? 'unknown-call',
      text: extractContentText(message?.content),
      isError: error !== undefined || message?.isError === true,
    }
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

  if (type === 'agent/inbox/spliced' || type === 'turn/start' || type === 'step/start' || type === 'step/end' || type === 'request/header' || type === 'request/context') {
    return { sequence, kind: 'internal', sessionId, type }
  }

  return { sequence, kind: 'unknown', sessionId, method: notification.method, type }
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

function extractContentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const text: string[] = []
  for (const block of value) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
    text.push(block.text)
  }
  return text.join('')
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
