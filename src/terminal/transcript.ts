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

export function reduceTerminalEvent(
  state: TerminalTranscriptState,
  event: NormalizedEvent,
  host: TerminalPluginHost,
  activityId: string,
  debug = false,
): TerminalTranscriptState {
  const context = { debug, activityId }
  const renderer = host.matchingRenderer(event)
  const mutations = renderer?.render(event, context) ?? genericEventMutations(event, context)
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
  event: NormalizedEvent,
  context: { debug: boolean; activityId: string },
): readonly TranscriptMutation[] {
  switch (event.kind) {
    case 'assistant-delta': {
      const id = `assistant-${context.activityId}`
      return [{
        kind: 'append-text',
        id,
        text: event.text,
        fallback: {
          id,
          kind: 'assistant',
          title: 'assistant',
          text: '',
          state: 'running',
          sessionId: event.sessionId,
        },
      }]
    }
    case 'assistant-message':
      return [{
        kind: 'append',
        block: {
          id: `assistant-${context.activityId}`,
          kind: 'assistant',
          title: 'assistant',
          text: sanitizeTerminalText(event.text),
          state: 'success',
          sessionId: event.sessionId,
        },
      }]
    case 'tool-call':
      return [{
        kind: 'append',
        block: {
          id: `tool-${context.activityId}-${event.callId}`,
          kind: 'tool',
          title: sanitizeTerminalText(event.name),
          text: sanitizeTerminalText(event.arguments),
          state: 'running',
          foldable: true,
          sessionId: event.sessionId,
        },
      }]
    case 'tool-result':
      return [{
        kind: 'patch',
        id: `tool-${context.activityId}-${event.callId}`,
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
          id: `agent-${context.activityId}-${event.childSessionId}`,
          kind: 'agent',
          title: event.provider === undefined ? 'subagent' : `subagent · ${sanitizeTerminalText(event.provider)}`,
          text: sanitizeTerminalText(event.childSessionId),
          detail: `parent ${sanitizeTerminalText(event.parentSessionId)}`,
          state: 'running',
          sessionId: event.parentSessionId,
        },
      }]
    case 'subagent-finished':
      return [{ kind: 'patch', id: `agent-${context.activityId}-${event.childSessionId}`, patch: { state: 'finished' } }]
    case 'turn-error':
      return [{
        kind: 'append',
        block: {
          id: `error-${context.activityId}-${event.sequence}`,
          kind: 'error',
          title: 'turn error',
          text: sanitizeTerminalText(event.message),
          state: 'error',
          sessionId: event.sessionId,
        },
      }]
    case 'unknown':
      return context.debug ? [{
        kind: 'append',
        block: {
          id: `unknown-${context.activityId}-${event.sequence}`,
          kind: 'debug',
          title: 'unknown event',
          text: `${sanitizeTerminalText(event.method)}${event.type === undefined ? '' : `/${sanitizeTerminalText(event.type)}`}`,
        },
      }] : []
    case 'session-status':
    case 'user-message':
    case 'internal':
      return []
  }
}
