import {
  appendRetainedTail,
  initialRetainedTail,
  MAX_RETAINED_TERMINAL_EVENTS,
  MAX_RETAINED_TOPOLOGY_ENTRIES,
  retainNormalizedEvent,
  type RetainedTail,
} from '../retention.js'
import type { NormalizedEvent } from '../session/projection.js'
import type { TerminalAgentTopologyEntry } from '../plugins/api.js'

export type TerminalEventHistory = RetainedTail<NormalizedEvent>

export function initialTerminalEventHistory(): TerminalEventHistory {
  return initialRetainedTail<NormalizedEvent>()
}

export function appendTerminalEventHistory(
  state: TerminalEventHistory,
  event: NormalizedEvent,
): TerminalEventHistory {
  return appendRetainedTail(
    state,
    retainNormalizedEvent(event),
    MAX_RETAINED_TERMINAL_EVENTS,
  )
}

export interface AgentTopologyHistory {
  entries: ReadonlyMap<string, TerminalAgentTopologyEntry>
  dropped: number
}

export function initialAgentTopologyHistory(): AgentTopologyHistory {
  return { entries: new Map(), dropped: 0 }
}

export function reduceAgentTopologyHistory(
  state: AgentTopologyHistory,
  event: NormalizedEvent,
): AgentTopologyHistory {
  if (event.kind !== 'subagent-started' && event.kind !== 'subagent-finished') return state

  const entries = new Map(state.entries)
  const previous = entries.get(event.childSessionId)
  const next: TerminalAgentTopologyEntry = {
    childSessionId: event.childSessionId,
    parentSessionId: event.parentSessionId,
    ...(event.kind === 'subagent-started' && event.provider !== undefined
      ? { provider: event.provider }
      : previous?.provider === undefined ? {} : { provider: previous.provider }),
    status: event.kind === 'subagent-started' ? 'running' : 'finished',
  }

  let dropped = state.dropped
  if (!entries.has(event.childSessionId) && entries.size >= MAX_RETAINED_TOPOLOGY_ENTRIES) {
    const oldest = entries.keys().next().value as string | undefined
    if (oldest !== undefined) {
      entries.delete(oldest)
      dropped += 1
    }
  }
  entries.set(event.childSessionId, next)
  return { entries, dropped }
}
