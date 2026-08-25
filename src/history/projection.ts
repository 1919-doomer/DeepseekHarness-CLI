import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type {
  HistoryApprovalAudit,
  HistoryMessage,
  HistorySessionDetail,
  HistorySessionSummary,
  HistoryToolActivity,
} from './types.js'

export const MAX_HISTORY_MESSAGE_CHARS = 16_384
export const MAX_HISTORY_MESSAGES_PER_DETAIL = 500
export const MAX_HISTORY_TOOLS_PER_DETAIL = 200

export function projectHistorySession(
  header: SessionHeader,
  events: readonly SessionEvent[],
): HistorySessionDetail {
  const messages: HistoryMessage[] = []
  const approvals: HistoryApprovalAudit[] = []
  const tools: HistoryToolActivity[] = []
  const openToolIndexes = new Map<string, number>()
  let updatedAt = header.createdAt
  let title = ''
  let provider: string | undefined
  let model: string | undefined
  let contextWindow: number | undefined
  let toolCallCount = 0
  let compactionCount = 0
  let diagnostic: string | undefined

  for (const event of events) {
    updatedAt = Math.max(updatedAt, event.time)
    const data = record(event.data)
    switch (String(event.type)) {
      case 'user/message': {
        const message = messageFromEvent(header.id, event.seq, event.time, 'user', data)
        if (message !== undefined) messages.push(message)
        break
      }
      case 'assistant/message': {
        const message = messageFromEvent(header.id, event.seq, event.time, 'assistant', data)
        if (message !== undefined) {
          messages.push(message)
          provider = message.provider ?? provider
          model = message.model ?? model
        }
        break
      }
      case 'tool/result': {
        const message = toolMessageFromEvent(header.id, event.seq, event.time, data)
        if (message !== undefined) messages.push(message)
        const source = record(record(data?.['message'])?.['source'])
        const callId = stringAt(source, 'callId')
        if (callId !== undefined) {
          const existing = openToolIndexes.get(callId)
          const resultText = message?.text
          const isError = source?.['isError'] === true || data?.['error'] !== undefined
          if (existing === undefined) {
            tools.push({
              sessionId: String(header.id), callId,
              ...(resultText === undefined ? {} : { result: boundToolText(resultText) }),
              isError, resultSeq: event.seq, resultAt: event.time,
            })
          } else {
            const activity = tools[existing]!
            tools[existing] = {
              ...activity,
              ...(resultText === undefined ? {} : { result: boundToolText(resultText) }),
              isError,
              resultSeq: event.seq,
              resultAt: event.time,
            }
            openToolIndexes.delete(callId)
          }
        }
        break
      }
      case 'tool/call': {
        toolCallCount += 1
        const callId = stringAt(data, 'callId')
        if (callId !== undefined) {
          const activity: HistoryToolActivity = {
            sessionId: String(header.id),
            callId,
            ...(stringAt(data, 'name') === undefined ? {} : { name: stringAt(data, 'name') }),
            ...(stringAt(data, 'arguments') === undefined ? {} : { arguments: boundToolText(stringAt(data, 'arguments')!) }),
            calledSeq: event.seq,
            calledAt: event.time,
          }
          tools.push(activity)
          openToolIndexes.set(callId, tools.length - 1)
        }
        break
      }
      case 'session/title': {
        const value = stringAt(data, 'title')
        if (value !== undefined) title = value
        break
      }
      case 'request/context': {
        provider = stringAt(data, 'provider') ?? provider
        model = stringAt(data, 'model') ?? model
        contextWindow = positiveIntegerAt(data, 'contextWindow') ?? contextWindow
        break
      }
      case 'compaction/summary':
      case 'compaction/prune':
        compactionCount += 1
        break
      case 'approval/asked':
      case 'approval/decided':
      case 'approval/policy': {
        const audit = approvalFromEvent(header.id, event.seq, event.time, String(event.type), data)
        if (audit !== undefined) approvals.push(audit)
        break
      }
      case 'turn/end': {
        const reason = record(data?.['reason'])
        if (stringAt(reason, 'kind') === 'interrupted') {
          diagnostic = 'The non-mutating persistence inspection balanced an interrupted turn in memory; the stored artifact was not repaired.'
        }
        break
      }
      default:
        break
    }
  }

  const visibleMessages = messages.slice(-MAX_HISTORY_MESSAGES_PER_DETAIL)
  const fallback = messages.find(message => message.role === 'user' && message.text.trim().length > 0)?.text.trim()
  const summary: HistorySessionSummary = {
    id: String(header.id),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    createdAt: header.createdAt,
    updatedAt,
    title: title.length > 0 ? title : fallbackTitle(fallback, String(header.id)),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    messageCount: messages.length,
    toolCallCount,
    compactionCount,
    approvalCount: approvals.filter(item => item.phase === 'asked').length,
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) }),
    ...(diagnostic === undefined && events.length > 0
      ? {}
      : { diagnostic: diagnostic ?? 'No complete session events were readable; the artifact may have a torn or damaged tail.' }),
  }
  return {
    summary,
    messages: visibleMessages,
    approvals,
    tools: tools.slice(-MAX_HISTORY_TOOLS_PER_DETAIL),
    eventCount: events.length,
    droppedMessageCount: messages.length - visibleMessages.length,
  }
}

export function diagnosticHistorySummary(header: SessionHeader, diagnostic: string): HistorySessionSummary {
  return {
    id: String(header.id),
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    createdAt: header.createdAt,
    updatedAt: header.createdAt,
    title: `Session ${shortId(String(header.id))}`,
    messageCount: 0,
    toolCallCount: 0,
    compactionCount: 0,
    approvalCount: 0,
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) }),
    diagnostic,
  }
}

export function historySearchText(summary: HistorySessionSummary, detail?: HistorySessionDetail): string {
  return [
    summary.id,
    summary.cwd ?? '',
    summary.title,
    summary.provider ?? '',
    summary.model ?? '',
    safeIso(summary.createdAt),
    safeIso(summary.updatedAt),
    ...(detail?.messages.map(message => message.text) ?? []),
    ...(detail?.tools?.flatMap(tool => [tool.name ?? '', tool.arguments ?? '', tool.result ?? '']) ?? []),
  ].join('\n').toLocaleLowerCase('en-US')
}

function messageFromEvent(
  sessionId: unknown,
  seq: number,
  time: number,
  role: 'user' | 'assistant',
  data: Record<string, unknown> | undefined,
): HistoryMessage | undefined {
  const source = role === 'assistant' ? record(record(data?.['message'])?.['source']) : undefined
  const message = role === 'assistant' ? record(data?.['message']) : data
  const text = extractContentText(message?.['content'])
  if (text.length === 0) return undefined
  const bounded = boundText(text)
  const usage = role === 'assistant' ? tokenUsage(record(data?.['usage'])) : undefined
  return {
    sessionId: String(sessionId),
    seq,
    time,
    role,
    text: bounded.text,
    truncatedChars: bounded.truncatedChars,
    ...(positiveIntegerAt(data, 'turn') === undefined ? {} : { turn: positiveIntegerAt(data, 'turn') }),
    ...(stringAt(source, 'provider') === undefined ? {} : { provider: stringAt(source, 'provider') }),
    ...(stringAt(source, 'model') === undefined ? {} : { model: stringAt(source, 'model') }),
    ...(usage === undefined ? {} : { usage }),
  }
}

function toolMessageFromEvent(
  sessionId: unknown,
  seq: number,
  time: number,
  data: Record<string, unknown> | undefined,
): HistoryMessage | undefined {
  const message = record(data?.['message'])
  const text = extractContentText(message?.['content'])
  if (text.length === 0) return undefined
  const bounded = boundText(text)
  return {
    sessionId: String(sessionId),
    seq,
    time,
    role: 'tool',
    text: bounded.text,
    truncatedChars: bounded.truncatedChars,
    ...(positiveIntegerAt(data, 'turn') === undefined ? {} : { turn: positiveIntegerAt(data, 'turn') }),
  }
}

function approvalFromEvent(
  sessionId: unknown,
  seq: number,
  time: number,
  type: string,
  data: Record<string, unknown> | undefined,
): HistoryApprovalAudit | undefined {
  if (type === 'approval/policy') {
    const policy = stringAt(data, 'policy')
    if (policy !== 'ask' && policy !== 'never') return undefined
    return { sessionId: String(sessionId), seq, time, requestId: '', phase: 'policy', policy }
  }
  const requestId = stringAt(data, 'id')
  if (requestId === undefined) return undefined
  if (type === 'approval/asked') {
    return {
      sessionId: String(sessionId),
      seq,
      time,
      requestId,
      phase: 'asked',
      ...(stringAt(data, 'toolName') === undefined ? {} : { toolName: stringAt(data, 'toolName') }),
      ...(stringAt(data, 'callId') === undefined ? {} : { callId: stringAt(data, 'callId') }),
      ...(stringAt(data, 'reason') === undefined ? {} : { reason: stringAt(data, 'reason') }),
    }
  }
  const outcome = stringAt(data, 'outcome')
  if (outcome !== 'allowed-once' && outcome !== 'rejected' && outcome !== 'cancelled' && outcome !== 'unavailable') return undefined
  return { sessionId: String(sessionId), seq, time, requestId, phase: 'decided', outcome }
}

function tokenUsage(value: Record<string, unknown> | undefined): HistoryMessage['usage'] | undefined {
  const inputTokens = nonNegativeIntegerAt(value, 'inputTokens')
  const outputTokens = nonNegativeIntegerAt(value, 'outputTokens')
  if (inputTokens === undefined && outputTokens === undefined) return undefined
  const cacheReadTokens = nonNegativeIntegerAt(value, 'cacheReadTokens')
  const cacheWriteTokens = nonNegativeIntegerAt(value, 'cacheWriteTokens')
  const reasoningTokens = nonNegativeIntegerAt(value, 'reasoningTokens')
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

function extractContentText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const text: string[] = []
  for (const candidate of value) {
    const block = record(candidate)
    if (block?.['type'] === 'text' && typeof block['text'] === 'string') text.push(block['text'])
    if (block?.['type'] === 'tool-result') text.push(extractContentText(block['content']))
  }
  return text.join('')
}

function boundText(text: string): { text: string; truncatedChars: number } {
  if (text.length <= MAX_HISTORY_MESSAGE_CHARS) return { text, truncatedChars: 0 }
  const head = Math.floor(MAX_HISTORY_MESSAGE_CHARS * 0.75)
  const tail = MAX_HISTORY_MESSAGE_CHARS - head
  return {
    text: `${text.slice(0, head)}\n… historical message truncated locally …\n${text.slice(-tail)}`,
    truncatedChars: text.length - MAX_HISTORY_MESSAGE_CHARS,
  }
}

function boundToolText(text: string): string {
  return boundText(text).text
}

function fallbackTitle(text: string | undefined, sessionId: string): string {
  if (text === undefined) return `Session ${shortId(sessionId)}`
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 72 ? oneLine : `${oneLine.slice(0, 69)}...`
}

function shortId(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 7)}…${value.slice(-7)}`
}

function safeIso(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringAt(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const candidate = value?.[key]
  return typeof candidate === 'string' ? candidate : undefined
}

function nonNegativeIntegerAt(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const candidate = value?.[key]
  return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined
}

function positiveIntegerAt(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const candidate = nonNegativeIntegerAt(value, key)
  return candidate !== undefined && candidate > 0 ? candidate : undefined
}
