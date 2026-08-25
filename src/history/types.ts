import type { TokenUsage } from '../session/projection.js'

export type ProjectionSource = 'local' | 'runtime'
export type ProjectionAuthority = 'observed' | 'requested' | 'unavailable'

export interface ProjectionFact<T> {
  value?: T
  source: ProjectionSource
  authority: ProjectionAuthority
}

export interface ContextInsightProjection {
  latestInputTokens: ProjectionFact<number>
  latestOutputTokens: ProjectionFact<number>
  latestCacheReadShare: ProjectionFact<number>
  route: ProjectionFact<{ provider: string; model: string }>
  contextWindow: ProjectionFact<number>
  inputCapacityShare: ProjectionFact<number>
  compactionCount: ProjectionFact<number>
}

export interface PromptLayerProjection {
  name: string
  content: ProjectionFact<string>
}

export type HistoryMessageRole = 'user' | 'assistant' | 'tool'

export interface HistoryMessage {
  sessionId: string
  seq: number
  time: number
  role: HistoryMessageRole
  text: string
  truncatedChars: number
  turn?: number
  provider?: string
  model?: string
  usage?: TokenUsage
}

export interface HistoryApprovalAudit {
  sessionId: string
  seq: number
  time: number
  requestId: string
  phase: 'asked' | 'decided' | 'policy'
  toolName?: string
  callId?: string
  reason?: string
  outcome?: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  policy?: 'ask' | 'never'
}

export interface HistoryToolActivity {
  sessionId: string
  callId: string
  name?: string
  arguments?: string
  result?: string
  isError?: boolean
  calledSeq?: number
  resultSeq?: number
  calledAt?: number
  resultAt?: number
}

export interface HistorySessionSummary {
  id: string
  cwd?: string
  createdAt: number
  updatedAt: number
  title: string
  provider?: string
  model?: string
  contextWindow?: number
  messageCount: number
  toolCallCount: number
  compactionCount: number
  approvalCount: number
  origin?: 'subagent'
  parentSession?: string
  diagnostic?: string
}

export interface HistorySessionDetail {
  summary: HistorySessionSummary
  messages: readonly HistoryMessage[]
  approvals: readonly HistoryApprovalAudit[]
  tools?: readonly HistoryToolActivity[]
  eventCount: number
  droppedMessageCount: number
}

export interface HistoryCatalog {
  root: string
  workspace: string
  allWorkspaces: boolean
  totalSnapshots: number
  matchingSnapshots: number
  inspectedSnapshots: number
  omittedSnapshots: number
  sessions: readonly HistorySessionSummary[]
  diagnostics: readonly string[]
}

export interface HistoryListQuery {
  workspace: string
  allWorkspaces?: boolean
  text?: string
  limit?: number
}

export interface HistoryReader {
  readonly root: string
  list(query: HistoryListQuery, signal?: AbortSignal): Promise<HistoryCatalog>
  inspect(sessionId: string, signal?: AbortSignal): Promise<HistorySessionDetail>
}
