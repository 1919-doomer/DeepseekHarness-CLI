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
  debug = false,
): TerminalTranscriptState {
  const renderer = host.matchingRenderer(event)
  const mutations = renderer?.render(event, { debug }) ?? genericEventMutations(event, debug)
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
    if (index < 0) continue
    if (mutation.kind === 'remove') {
      blocks.splice(index, 1)
      continue
    }
    blocks[index] = { ...blocks[index]!, ...mutation.patch, id: mutation.id }
  }
  return { ...state, blocks }
}

function genericEventMutations(event: NormalizedEvent, debug: boolean): readonly TranscriptMutation[] {
  switch (event.kind) {
    case 'assistant-delta':
      return [{
        kind: 'append',
        block: {
          id: assistantStreamId(event.sessionId),
          kind: 'assistant',
          title: 'assistant',
          text: sanitizeTerminalText(event.text),
          state: 'running',
          sessionId: event.sessionId,
        },
      }]
    case 'assistant-message':
      return [{
        kind: 'append',
        block: {
          id: assistantStreamId(event.sessionId),
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
          id: `tool-${event.callId}`,
          kind: 'tool',
          title: event.name,
          text: sanitizeTerminalText(event.arguments),
          state: 'running',
          foldable: true,
          sessionId: event.sessionId,
        },
      }]
    case 'tool-result':
      return [{
        kind: 'patch',
        id: `tool-${event.callId}`,
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
          id: `agent-${event.childSessionId}`,
          kind: 'agent',
          title: event.provider === undefined ? 'subagent' : `subagent · ${sanitizeTerminalText(event.provider)}`,
          text: sanitizeTerminalText(event.childSessionId),
          detail: `parent ${sanitizeTerminalText(event.parentSessionId)}`,
          state: 'running',
          sessionId: event.parentSessionId,
        },
      }]
    case 'subagent-finished':
      return [{ kind: 'patch', id: `agent-${event.childSessionId}`, patch: { state: 'finished' } }]
    case 'turn-error':
      return [{
        kind: 'append',
        block: {
          id: `error-${event.sequence}`,
          kind: 'error',
          title: 'turn error',
          text: sanitizeTerminalText(event.message),
          state: 'error',
          sessionId: event.sessionId,
        },
      }]
    case 'unknown':
      return debug ? [{
        kind: 'append',
        block: {
          id: `unknown-${event.sequence}`,
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

function assistantStreamId(sessionId: string): string {
  return `assistant-current-${sessionId}`
}
