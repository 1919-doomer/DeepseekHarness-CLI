import type { NormalizedEvent } from '../session/projection.js'
import type { TerminalPluginHost } from '../plugins/host.js'
import type { TranscriptBlock, TranscriptMutation } from '../plugins/api.js'
import { sanitizeTerminalText } from './sanitize.js'

export interface TerminalTranscriptState {
  blocks: readonly TranscriptBlock[]
  unknownEventCount: number
}

export function initialTerminalTranscript(): TerminalTranscriptState {
  return { blocks: [], unknownEventCount: 0 }
}

export function appendUserPrompt(
  state: TerminalTranscriptState,
  sessionId: string,
  text: string,
  id = `user-local-${Date.now()}`,
): TerminalTranscriptState {
  return applyMutations(state, [{
    kind: 'append',
    block: {
      id,
      kind: 'user',
      title: 'you',
      text: sanitizeTerminalText(text),
      sessionId,
    },
  }])
}

export function appendSystemMessage(
  state: TerminalTranscriptState,
  text: string,
  title = 'dshc',
  id = `system-${Date.now()}`,
): TerminalTranscriptState {
  return applyMutations(state, [{
    kind: 'append',
    block: { id, kind: 'system', title, text: sanitizeTerminalText(text) },
  }])
}

export function terminalBlockId(
  kind: string,
  activityId: string,
  sessionId: string,
  discriminator = '',
): string {
  return [kind, activityId, sessionId, discriminator]
    .map(part => `${part.length}:${part}`)
    .join('|')
}

export function reduceTerminalEvent(
  state: TerminalTranscriptState,
  event: NormalizedEvent,
  host: TerminalPluginHost,
  activityId: string,
  rootSessionId: string,
  debug = false,
): TerminalTranscriptState {
  const context = { debug, activityId, rootSessionId }
  let mutations: readonly TranscriptMutation[]
  try {
    const renderer = host.matchingRenderer(event)
    mutations = renderer?.render(event, context) ?? genericEventMutations(state, event, context)
  } catch (error) {
    mutations = [
      ...genericEventMutations(state, event, context),
      presentationFailureMutation(event, context, error),
    ]
  }
  const next = applyMutations(state, mutations)
  return event.kind === 'unknown'
    ? { ...next, unknownEventCount: next.unknownEventCount + 1 }
    : next
}

export function applyMutations(
  state: TerminalTranscriptState,
  mutations: readonly TranscriptMutation[],
): TerminalTranscriptState {
  if (mutations.length === 0) return state
  const blocks = [...state.blocks]
  for (const mutation of mutations) {
    if (mutation.kind === 'append') {
      const existing = blocks.findIndex(block => block.id === mutation.block.id)
      if (existing >= 0) blocks[existing] = mutation.block
      else blocks.push(mutation.block)
      continue
    }

    const index = blocks.findIndex(block => block.id === mutation.id)
    if (mutation.kind === 'append-text') {
      const text = sanitizeTerminalText(mutation.text)
      if (index < 0) {
        if (mutation.fallback !== undefined) blocks.push({ ...mutation.fallback, text })
      } else {
        const previous = blocks[index]!
        blocks[index] = { ...previous, text: previous.text + text }
      }
      continue
    }

    if (index < 0) continue
    if (mutation.kind === 'remove') {
      blocks.splice(index, 1)
      continue
    }
    blocks[index] = { ...blocks[index]!, ...mutation.patch, id: mutation.id }
  }
  return { ...state, blocks }
}

function genericEventMutations(
  state: TerminalTranscriptState,
  event: NormalizedEvent,
  context: { debug: boolean; activityId: string; rootSessionId: string },
): readonly TranscriptMutation[] {
  switch (event.kind) {
    case 'assistant-delta': {
      const id = assistantBlockId(state, context.activityId, event.sessionId)
      return [{
        kind: 'append-text',
        id,
        text: event.text,
        fallback: {
          id,
          kind: 'assistant',
          title: scopedTitle('assistant', event.sessionId, context.rootSessionId),
          text: '',
          state: 'running',
          sessionId: event.sessionId,
          activityId: context.activityId,
        },
      }]
    }
    case 'assistant-message': {
      const id = assistantBlockId(state, context.activityId, event.sessionId)
      return [{
        kind: 'append',
        block: {
          id,
          kind: 'assistant',
          title: scopedTitle('assistant', event.sessionId, context.rootSessionId),
          text: sanitizeTerminalText(event.text),
          state: 'success',
          sessionId: event.sessionId,
          activityId: context.activityId,
        },
      }]
    }
    case 'tool-call':
      return [{
        kind: 'append',
        block: {
          id: terminalBlockId('tool', context.activityId, event.sessionId, event.callId),
          kind: 'tool',
          title: scopedTitle(sanitizeTerminalText(event.name), event.sessionId, context.rootSessionId),
          text: sanitizeTerminalText(event.arguments),
          state: 'running',
          foldable: true,
          sessionId: event.sessionId,
          activityId: context.activityId,
        },
      }]
    case 'tool-result':
      return [{
        kind: 'patch',
        id: terminalBlockId('tool', context.activityId, event.sessionId, event.callId),
        patch: {
          detail: sanitizeTerminalText(event.text),
          state: event.isError ? 'error' : 'success',
          foldable: true,
        },
      }]
    case 'subagent-started':
      return [{
        kind: 'append',
        block: {
          id: terminalBlockId('agent', context.activityId, event.parentSessionId, event.childSessionId),
          kind: 'agent',
          title: event.provider === undefined ? 'subagent' : `subagent · ${sanitizeTerminalText(event.provider)}`,
          text: sanitizeTerminalText(event.childSessionId),
          detail: `parent ${sanitizeTerminalText(event.parentSessionId)}`,
          state: 'running',
          sessionId: event.parentSessionId,
          activityId: context.activityId,
        },
      }]
    case 'subagent-finished':
      return [{
        kind: 'patch',
        id: terminalBlockId('agent', context.activityId, event.parentSessionId, event.childSessionId),
        patch: { state: 'finished' },
      }]
    case 'turn-error':
      return [{
        kind: 'append',
        block: {
          id: terminalBlockId('error', context.activityId, event.sessionId, String(event.sequence)),
          kind: 'error',
          title: scopedTitle('turn error', event.sessionId, context.rootSessionId),
          text: sanitizeTerminalText(event.message),
          state: 'error',
          sessionId: event.sessionId,
          activityId: context.activityId,
        },
      }]
    case 'unknown':
      return context.debug ? [{
        kind: 'append',
        block: {
          id: terminalBlockId('unknown', context.activityId, event.sessionId ?? '', String(event.sequence)),
          kind: 'debug',
          title: 'unknown event',
          text: `${sanitizeTerminalText(event.method)}${event.type === undefined ? '' : `/${sanitizeTerminalText(event.type)}`}`,
          activityId: context.activityId,
        },
      }] : []
    case 'session-status':
    case 'user-message':
    case 'internal':
      return []
  }
}

function assistantBlockId(
  state: TerminalTranscriptState,
  activityId: string,
  sessionId: string,
): string {
  const running = [...state.blocks].reverse().find(block =>
    block.kind === 'assistant'
    && block.activityId === activityId
    && block.sessionId === sessionId
    && block.state === 'running',
  )
  if (running !== undefined) return running.id
  const segment = state.blocks.filter(block =>
    block.kind === 'assistant'
    && block.activityId === activityId
    && block.sessionId === sessionId,
  ).length + 1
  return terminalBlockId('assistant', activityId, sessionId, String(segment))
}

function presentationFailureMutation(
  event: NormalizedEvent,
  context: { activityId: string; rootSessionId: string },
  error: unknown,
): TranscriptMutation {
  const sessionId = eventSessionId(event) ?? context.rootSessionId
  return {
    kind: 'append',
    block: {
      id: terminalBlockId('renderer-error', context.activityId, sessionId, String(event.sequence)),
      kind: 'error',
      title: 'terminal renderer error',
      text: sanitizeTerminalText(errorMessage(error)),
      state: 'error',
      sessionId,
      activityId: context.activityId,
    },
  }
}

function eventSessionId(event: NormalizedEvent): string | undefined {
  if ('sessionId' in event && typeof event.sessionId === 'string') return event.sessionId
  if (event.kind === 'subagent-started' || event.kind === 'subagent-finished') return event.parentSessionId
  return undefined
}

function scopedTitle(base: string, sessionId: string, rootSessionId: string): string {
  return sessionId === rootSessionId ? base : `${base} · ${shortSession(sessionId)}`
}

function shortSession(sessionId: string): string {
  const value = sessionId.startsWith('session-') ? sessionId.slice(-8) : sessionId.slice(0, 12)
  return sanitizeTerminalText(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
