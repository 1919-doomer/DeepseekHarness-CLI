import type { NormalizedEvent, TokenUsage } from './projection.js'

export interface ModelTelemetry {
  sessionId: string
  provider?: string
  model?: string
  contextWindow?: number
  latestUsage?: TokenUsage
  requestTps?: number
  requestMs?: number
}

/** Observe arrival times before UI batching. Never infer tokens from characters. */
export class ModelTelemetryMeter {
  private value: ModelTelemetry = { sessionId: '' }
  private started?: number
  constructor(private now: () => number = () => performance.now()) {}
  begin(sessionId: string): void {
    this.value = this.value.sessionId === sessionId
      ? { ...this.value, requestTps: undefined, requestMs: undefined }
      : { sessionId }
    this.started = undefined
  }
  observe(event: NormalizedEvent): void {
    if (!('sessionId' in event) || event.sessionId !== this.value.sessionId) return
    if (event.kind === 'internal' && event.type === 'step/start') {
      this.started = this.now()
      this.value = { ...this.value, requestTps: undefined, requestMs: undefined }
    } else if (event.kind === 'request-context') {
      // Upstream emits route metadata only when it changes, not for each call.
      this.value = { ...this.value, provider: event.provider, model: event.model,
        contextWindow: event.contextWindow }
    } else if (event.kind === 'internal' && event.type === 'step/end') {
      this.started = undefined
    } else if (event.kind === 'assistant-message') {
      if (event.usage) {
        const elapsed = this.started === undefined ? undefined : this.now() - this.started
        this.value = { ...this.value, latestUsage: event.usage,
          requestMs: elapsed,
          requestTps: elapsed !== undefined && elapsed >= 1
            ? event.usage.outputTokens * 1000 / elapsed : undefined }
      }
      this.started = undefined
    } else if (event.kind === 'turn-error' || event.kind === 'context-compacted') {
      this.started = undefined
      this.value = { ...this.value, requestTps: undefined, requestMs: undefined,
        ...(event.kind === 'context-compacted' ? { latestUsage: undefined } : {}) }
    }
  }
  snapshot(): ModelTelemetry { return this.value }
}

export function telemetryDetails(value: ModelTelemetry | undefined, zh: boolean): string[] {
  const tps = value?.requestTps?.toFixed(1) ?? '—'
  const usage = value?.latestUsage
  return zh ? [
    `TPS 请求均速：${tps} token/s（最近完成的根会话模型请求；包含准备、等待、重试与传输，不是纯生成速度）`,
    `输入构成（token）：非缓存 ${usage?.inputTokens ?? '—'} / 缓存读取 ${usage ? usage.cacheReadTokens ?? 0 : '—'} / 缓存写入 ${usage ? usage.cacheWriteTokens ?? 0 : '—'}`,
    '语义构成：系统提示词 / 对话历史 / 工具各自的 token 数未由运行时公开。',
  ] : [
    `TPS request average: ${tps} token/s (last completed root-session request; includes waiting/transport, not decode speed)`,
    `Input composition (tokens): uncached ${usage?.inputTokens ?? '—'} / cache read ${usage ? usage.cacheReadTokens ?? 0 : '—'} / cache write ${usage ? usage.cacheWriteTokens ?? 0 : '—'}`,
    'Semantic composition: system/history/tool token contributions are not exposed by the runtime.',
  ]
}
