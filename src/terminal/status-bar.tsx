import { memo, useEffect, useState } from 'react'
import { Box, Text, useStdout } from 'ink'
import type { TerminalRuntimePhase } from '../plugins/api.js'
import type { WorkMode } from '../preferences.js'
import type { Locale } from '../i18n.js'
import { StatusLight } from './status-light.js'
import { cropTerminalText, terminalCellWidth } from './text-metrics.js'
import { sanitizeTerminalText } from './sanitize.js'
import type { SessionUsage } from '../session/usage.js'
import type { ModelTelemetry } from '../session/model-telemetry.js'
import { duration, type SessionClock } from '../session/session-clock.js'
export interface StatusSegment { id: string; text: string }
export function statusBarContentRows(_width: number): number { return 1 }
export function useClockTick(): void {
  const [, tick] = useState(0)
  const { stdout } = useStdout()
  useEffect(() => { const timer = setInterval(() => { if (!stdout.writableNeedDrain) tick(n => n + 1) }, 1000); timer.unref(); return () => { clearInterval(timer) } }, [stdout])
}
export const StatusBar = memo(function StatusBar({ width, phase, locale, segments, mode, queued, paused, telemetry, clock, animation, waiting }: {
  width: number; phase: TerminalRuntimePhase; locale: Locale; segments: readonly StatusSegment[]; mode: WorkMode
  queued: number; paused: boolean; usage: SessionUsage; telemetry?: ModelTelemetry; provider: string; effort?: string; backend: string
  clock?: SessionClock; animation?: boolean; waiting?: boolean
}) {
  useClockTick()
  const zh = locale === 'zh-CN'
  const label = zh ? { code: '编码', plan: '规划', review: '审阅', research: '研究' }[mode] : mode
  const input = telemetry?.latestUsage
  const total = input ? input.inputTokens + (input.cacheReadTokens ?? 0) + (input.cacheWriteTokens ?? 0) : undefined
  const ctx = `${zh ? '上下文' : 'ctx'} ${tokens(total)}${total !== undefined && telemetry?.contextWindow ? ` ${(total / telemetry.contextWindow * 100).toFixed(1)}%` : ''}`
  const model = sanitizeTerminalText(telemetry?.model ?? segments.find(s => s.id === 'model')?.text ?? '—')
  const time = `${zh ? '会话' : 'session'} ${duration(clock?.snapshot().elapsedMs ?? 0)}`
  const budget = Math.max(1, width - 6)
  const fields = width >= 80 ? [model, label, time, ctx] : [label, ctx, time, model]
  for (const segment of segments) if (!['phase', 'model', 'session', 'turns', 'workspace', 'usage'].includes(segment.id)) fields.unshift(cropTerminalText(sanitizeTerminalText(segment.text), Math.max(12, budget - 15)))
  if (waiting) fields.unshift(zh ? '待回答' : 'awaiting answer')
  if (queued) fields.push(`${queued} ${zh ? '待发送' : 'queued'}${paused ? zh ? ' 暂停' : ' paused' : ''}`)
  return <Box flexShrink={0} borderStyle="single" borderColor="gray" borderLeft={false} borderRight={false} paddingX={1}>
    <Box width={2} flexShrink={0}><StatusLight phase={phase} locale={locale} animation={animation} waiting={waiting} /></Box>
    <Text wrap="truncate">{fitFields(fields, budget)}</Text>
  </Box>
})
export function tokens(value: number | undefined): string { return value === undefined ? '—' : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value) }
export function fitFields(fields: readonly string[], width: number): string {
  let text = ''
  for (const field of fields) { const next = text ? `${text} · ${field}` : field; if (terminalCellWidth(next) <= width) text = next }
  return text || cropTerminalText(fields[0] ?? '', width)
}
