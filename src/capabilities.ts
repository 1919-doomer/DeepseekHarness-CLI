export type CapabilityAvailability = 'available' | 'unavailable' | 'requires-upstream'

export interface CapabilityEntry {
  id: 'history.reader' | 'bridge.protocol' | 'approval.answerer' | 'context.capacity' | 'prompt.runtime-inspection'
  availability: CapabilityAvailability
  detail: string
}

export interface CapabilityMatrixOptions {
  historyReaderAvailable: boolean
  contextCapacityObserved?: boolean
}

export function capabilityMatrix(options: CapabilityMatrixOptions): readonly CapabilityEntry[] {
  return [
    {
      id: 'history.reader',
      availability: options.historyReaderAvailable ? 'available' : 'unavailable',
      detail: options.historyReaderAvailable
        ? 'Public JSONL listSnapshots/inspect reader; read-only and workspace-scoped by default.'
        : 'No read-only history source was attached to this terminal product.',
    },
    {
      id: 'bridge.protocol',
      availability: 'requires-upstream',
      detail: 'Protocol 0.0.1 has a closed request router; dshc does not add private methods or fork the server.',
    },
    {
      id: 'approval.answerer',
      availability: 'requires-upstream',
      detail: 'No server-to-client approval request flow or answerer handshake; policy remains fail-closed.',
    },
    {
      id: 'context.capacity',
      availability: options.contextCapacityObserved === true ? 'available' : 'requires-upstream',
      detail: options.contextCapacityObserved === true
        ? 'Observed from a public request/context session event for this session.'
        : 'Unavailable until a request/context event advertises contextWindow or an upstream capability handshake exists.',
    },
    {
      id: 'prompt.runtime-inspection',
      availability: 'requires-upstream',
      detail: 'The current transport does not publish the final assembled prompt sections/tools metadata.',
    },
  ]
}
