import { memo } from 'react'
import { Box, Text } from 'ink'
import type { TerminalCommandContext } from '../plugins/api.js'
import { duration, type SessionClock } from '../session/session-clock.js'
import { tokens, useClockTick } from './status-bar.js'
import { wrapTerminalLines } from './text-metrics.js'
import { sanitizeTerminalText } from './sanitize.js'

export function overviewText(context: TerminalCommandContext): string {
  const zh = context.locale === 'zh-CN', m = context.modelTelemetry, u = context.usage, t = context.sessionTiming, c = context.compaction
  const line = (cn: string, en: string, value: unknown) => `${zh ? cn : en}: ${value ?? '—'}`
  const input = m?.latestUsage
  const total = u ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens : undefined
  const latestTotal = input ? input.inputTokens + (input.cacheReadTokens ?? 0) + (input.cacheWriteTokens ?? 0) : undefined
  const observed = m?.model !== undefined
  const lines = [
    zh ? observed ? '模型 · 已观察' : '模型 · 配置' : observed ? 'Model · observed' : 'Model · configured',
    m?.model ?? context.runtime.model,
    line('提供商', 'Provider', m?.provider ?? context.runtime.provider),
    line('推理·请求', 'Effort requested', context.runtime.requestedPreferences?.reasoningEffort ?? (zh ? '默认' : 'default')),
  ]
  // Only repeat requested values when the observed route actually differs.
  if (observed && m.model !== context.runtime.model) lines.push(line('请求模型', 'Requested model', context.runtime.model))
  if (m?.provider && m.provider !== context.runtime.provider) lines.push(line('请求提供商', 'Requested provider', context.runtime.provider))
  lines.push('', line('上下文', 'Context', `${tokens(latestTotal)} / ${tokens(m?.contextWindow)}`),
    `${zh ? '累计入' : 'Total in'} ${tokens(u?.requests ? total : undefined)} · ${zh ? '出' : 'out'} ${tokens(u?.requests ? u.outputTokens : undefined)}`,
    line('TPS请求均速', 'TPS request average', m?.requestTps?.toFixed(1)),
    line('缓存命中', 'Cache hit', total ? `${Math.round((u?.cacheReadTokens ?? 0) / total * 100)}%` : '—'),
    '', line('本轮耗时', 'Turn elapsed', t ? duration(t.turnMs) : '—'))
  if (t && t.waitingMs > 0) lines.push(line('等待回答', 'Awaiting input', duration(t.waitingMs)))
  if (c && c.state !== 'none') lines.push(line('压缩', 'Compaction',
    `${zh ? { running: '压缩中', completed: '已完成', failed: '失败' }[c.state] : c.state} · ${c.count}${zh ? '次' : ' times'}`))
  return lines.join('\n')
}
export const OverviewSidebar = memo(function OverviewSidebar({ context, clock, width, rows, focused, offset }: {
  context: TerminalCommandContext; clock: SessionClock; width: number; rows: number; focused: boolean; offset: number
}) {
  useClockTick()
  const lines = wrapTerminalLines(sanitizeTerminalText(overviewText({ ...context, sessionTiming: clock.snapshot(), compaction: clock.compaction })), width - 3)
  const capacity = Math.max(1, rows - 2), start = Math.min(offset, Math.max(0, lines.length - capacity))
  return <Box flexDirection="column" flexShrink={0} width={width} borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} paddingX={1} overflow="hidden">
    <Text bold={focused} wrap="truncate">{context.locale === 'zh-CN' ? '概览 / 工具 →' : 'Overview / Tools →'}</Text>
    {lines.slice(start, start + capacity).map((line, i) => <Text key={i} wrap="truncate">{line}</Text>)}
    <Box flexGrow={1} /><Text dimColor wrap="truncate">{lines.length > capacity ? `${start + 1}–${Math.min(lines.length, start + capacity)}/${lines.length} · ↑↓` : '/status · /context'}</Text>
  </Box>
})

/** Keep the same observed usage values on the tools page without its model details. */
export const ToolSidebarStats = memo(function ToolSidebarStats({ context, clock, rows }: {
  context: TerminalCommandContext; clock: SessionClock; rows: number
}) {
  useClockTick()
  const zh = context.locale === 'zh-CN', m = context.modelTelemetry, u = context.usage
  const input = m?.latestUsage
  const latest = input ? input.inputTokens + (input.cacheReadTokens ?? 0) + (input.cacheWriteTokens ?? 0) : undefined
  const total = u?.requests ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens : undefined
  const lines = [
    `${zh ? '上下文' : 'Context'}: ${tokens(latest)} / ${tokens(m?.contextWindow)}`,
    `${zh ? '累计入' : 'Total in'} ${tokens(total)} · ${zh ? '出' : 'out'} ${tokens(u?.requests ? u.outputTokens : undefined)}`,
    `${zh ? 'TPS请求均速' : 'TPS request average'}: ${m?.requestTps?.toFixed(1) ?? '—'}`,
    `${zh ? '缓存命中' : 'Cache hit'}: ${total ? `${Math.round((u?.cacheReadTokens ?? 0) / total * 100)}%` : '—'}`,
    `${zh ? '本轮耗时' : 'Turn elapsed'}: ${duration(clock.snapshot().turnMs)}`,
  ]
  return <Box flexDirection="column" flexShrink={0}>
    {lines.slice(0, rows).map((line, i) => <Text key={i} wrap="truncate">{line}</Text>)}
  </Box>
})
