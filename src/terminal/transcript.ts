import type { NormalizedEvent } from '../session/projection.js'
import type { TerminalPluginHost } from '../plugins/host.js'
import type { TranscriptBlock, TranscriptMutation } from '../plugins/api.js'
import {
  MAX_RETAINED_TRANSCRIPT_BLOCKS,
  MAX_RETAINED_TRANSCRIPT_FIELD_CHARS,
} from '../retention.js'
import { sanitizeTerminalText } from './sanitize.js'

const TRANSCRIPT_HEAD_CHARS = Math.floor(MAX_RETAINED_TRANSCRIPT_FIELD_CHARS * 0.75)
const TRANSCRIPT_TAIL_CHARS = MAX_RETAINED_TRANSCRIPT_FIELD_CHARS - TRANSCRIPT_HEAD_CHARS

export interface TerminalTranscriptState {
  blocks: readonly TranscriptBlock[]
  unknownEventCount: number
  /** Total distinct blocks created since the most recent local /clear. */
  totalBlockCount: number
  /** Older blocks evicted from local terminal retention. */
  droppedBlockCount: number
}

export function initialTerminalTranscript(): TerminalTranscriptState {
  return { blocks: [], unknownEventCount: 0, totalBlockCount: 0, droppedBlockCount: 0 }
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
      text,
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
    block: { id, kind: 'system', title, text },
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
  let totalBlockCount = state.totalBlockCount
  let droppedBlockCount = state.droppedBlockCount

  const appendBlock = (block: TranscriptBlock): void => {
    blocks.push(sanitizeAndRetainTranscriptBlock(block))
    totalBlockCount += 1
    while (blocks.length > MAX_RETAINED_TRANSCRIPT_BLOCKS) {
      blocks.shift()
      droppedBlockCount += 1
    }
  }

  for (const mutation of mutations) {
    if (mutation.kind === 'append') {
      // Transcript state is itself a trust + retention boundary. A first-party
      // renderer may forget sanitization, and future debugger/exporter/replay
      // consumers may bypass Ink. Store only inert, bounded local copies.
      const block = sanitizeAndRetainTranscriptBlock(mutation.block)
      const existing = blocks.findIndex(current => current.id === block.id)
      if (existing >= 0) blocks[existing] = block
      else appendBlock(mutation.block)
      continue
    }

    const index = blocks.findIndex(block => block.id === mutation.id)
    if (mutation.kind === 'append-text') {
      const addition = sanitizeTerminalText(mutation.text)
      if (index < 0) {
        if (mutation.fallback !== undefined) {
          const fallback = sanitizeAndRetainTranscriptBlock(mutation.fallback)
          const retained = appendRetainedField(fallback.text, fallback.textDroppedChars ?? 0, addition)
          appendBlock({
            ...fallback,
            text: retained.text,
            ...(retained.droppedChars === 0 ? { textDroppedChars: undefined } : { textDroppedChars: retained.droppedChars }),
          })
        }
      } else {
        const previous = blocks[index]!
        const retained = appendRetainedField(previous.text, previous.textDroppedChars ?? 0, addition)
        blocks[index] = {
          ...previous,
          text: retained.text,
          ...(retained.droppedChars === 0 ? { textDroppedChars: undefined } : { textDroppedChars: retained.droppedChars }),
        }
      }
      continue
    }

    if (index < 0) continue
    if (mutation.kind === 'remove') {
      blocks.splice(index, 1)
      continue
    }
    blocks[index] = applySanitizedRetainedPatch(blocks[index]!, mutation.patch)
  }
  return { ...state, blocks, totalBlockCount, droppedBlockCount }
}

/** Render the bounded field with an explicit middle-eviction marker. */
export function retainedTranscriptField(value: string, droppedChars = 0): string {
  if (droppedChars <= 0) return value
  const head = value.slice(0, TRANSCRIPT_HEAD_CHARS)
  const tail = value.slice(-TRANSCRIPT_TAIL_CHARS)
  return `${head}\n… ${droppedChars} chars evicted from local terminal retention; upstream content was processed in full …\n${tail}`
}

function sanitizeAndRetainTranscriptBlock(block: TranscriptBlock): TranscriptBlock {
  const text = retainFreshField(sanitizeTerminalText(block.text))
  const detail = block.detail === undefined
    ? undefined
    : retainFreshField(sanitizeTerminalText(block.detail))
  return {
    ...block,
    ...(block.title === undefined ? {} : { title: sanitizeTerminalText(block.title) }),
    text: text.text,
    ...(text.droppedChars === 0 ? { textDroppedChars: undefined } : { textDroppedChars: text.droppedChars }),
    ...(detail === undefined ? { detail: undefined, detailDroppedChars: undefined } : {
      detail: detail.text,
      ...(detail.droppedChars === 0 ? { detailDroppedChars: undefined } : { detailDroppedChars: detail.droppedChars }),
    }),
  }
}

function applySanitizedRetainedPatch(
  block: TranscriptBlock,
  patch: Partial<Omit<TranscriptBlock, 'id'>>,
): TranscriptBlock {
  const result: TranscriptBlock = {
    ...block,
    ...patch,
    id: block.id,
    ...(patch.title === undefined ? {} : { title: sanitizeTerminalText(patch.title) }),
  }

  if (patch.text !== undefined) {
    const retained = retainFreshField(sanitizeTerminalText(patch.text))
    result.text = retained.text
    result.textDroppedChars = retained.droppedChars || undefined
  }
  if (patch.detail !== undefined) {
    const retained = retainFreshField(sanitizeTerminalText(patch.detail))
    result.detail = retained.text
    result.detailDroppedChars = retained.droppedChars || undefined
  }
  return result
}

function retainFreshField(text: string): { text: string; droppedChars: number } {
  if (text.length <= MAX_RETAINED_TRANSCRIPT_FIELD_CHARS) return { text, droppedChars: 0 }
  const droppedChars = text.length - TRANSCRIPT_HEAD_CHARS - TRANSCRIPT_TAIL_CHARS
  return {
    text: text.slice(0, TRANSCRIPT_HEAD_CHARS) + text.slice(-TRANSCRIPT_TAIL_CHARS),
    droppedChars,
  }
}

function appendRetainedField(
  current: string,
  currentDroppedChars: number,
  addition: string,
): { text: string; droppedChars: number } {
  if (currentDroppedChars === 0) return retainFreshField(current + addition)

  const head = current.slice(0, TRANSCRIPT_HEAD_CHARS)
  const previousTail = current.slice(-TRANSCRIPT_TAIL_CHARS)
  const combinedTail = previousTail + addition
  const tail = combinedTail.slice(-TRANSCRIPT_TAIL_CHARS)
  const additionallyDropped = Math.max(0, combinedTail.length - TRANSCRIPT_TAIL_CHARS)
  return {
    text: head + tail,
    droppedChars: currentDroppedChars + additionallyDropped,
  }
}

function genericEventMutations(
  state: TerminalTranscriptState,
  event: NormalizedEvent,
  context: { debug: boolean; activityId: string; rootSessionId: string },
): readonly TranscriptMutation[] {
  switch (event.kind) {
    case 'assistant-delta': {
      const id = assistantBlockId(state, context.activityId, event.sessionId, event.sequence)
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
      const id = assistantBlockId(state, context.activityId, event.sessionId, event.sequence)
      return [{
        kind: 'append',
        block: {
          id,
          kind: 'assistant',
          title: scopedTitle('assistant', event.sessionId, context.rootSessionId),
          text: event.text,
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
          title: scopedTitle(event.name, event.sessionId, context.rootSessionId),
          text: event.arguments,
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
          detail: event.text,
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
          title: event.provider === undefined ? 'subagent' : `subagent · ${event.provider}`,
          text: event.childSessionId,
          detail: `parent ${event.parentSessionId}`,
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
          text: event.message,
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
          text: `${event.method}${event.type === undefined ? '' : `/${event.type}`}`,
          activityId: context.activityId,
        },
      }] : []
    case 'session-status':
    case 'user-message':
    case 'session-title':
      // Session naming metadata: observable in the trace, but not activity the
      // transcript should present as a turn.
      return []
    case 'internal':
      return []
  }
}

function assistantBlockId(
  state: TerminalTranscriptState,
  activityId: string,
  sessionId: string,
  sequence: number,
): string {
  const running = [...state.blocks].reverse().find(block =>
    block.kind === 'assistant'
    && block.activityId === activityId
    && block.sessionId === sessionId
    && block.state === 'running',
  )
  if (running !== undefined) return running.id
  // Sequence is an observed local ordering number, not upstream causal identity.
  // Using it as the local discriminator avoids id reuse after old blocks evict.
  return terminalBlockId('assistant', activityId, sessionId, String(sequence))
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
      text: errorMessage(error),
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
