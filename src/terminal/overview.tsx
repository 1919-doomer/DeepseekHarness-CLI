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
  return [line('模型·已观察', 'Model observed', m?.model), line('模型·请求', 'Model requested', context.runtime.model),
    line('提供商·已观察', 'Provider observed', m?.provider), line('提供商·请求', 'Provider requested', context.runtime.provider),
    line('推理·请求', 'Effort requested', context.runtime.requestedPreferences?.reasoningEffort ?? (zh ? '适配器默认' : 'adapter default')),
    line('后端', 'Backend', context.runtime.backend ?? 'bundled'),
    line('轮次', 'Turns', context.totalTurns),
    line('上下文容量', 'Context capacity', tokens(m?.contextWindow)),
    line('TPS请求均速', 'TPS request average', m?.requestTps?.toFixed(1)),
    zh ? '含等待/传输，非纯生成速度' : 'Includes waiting/transport',
    line('累计输入', 'Input total', tokens(u?.requests ? total : undefined)), line('累计输出', 'Output total', tokens(u?.requests ? u.outputTokens : undefined)),
    line('缓存命中', 'Cache hit', total ? `${Math.round((u?.cacheReadTokens ?? 0) / total * 100)}%` : '—'),
    line('本次非缓存输入', 'Latest uncached', tokens(input?.inputTokens)),
    line('本次缓存读', 'Latest cache read', tokens(input ? input.cacheReadTokens ?? 0 : undefined)),
    line('本次缓存写', 'Latest cache write', tokens(input ? input.cacheWriteTokens ?? 0 : undefined)),
    zh ? '系统/历史/工具构成: 未提供' : 'System/history/tool split: unavailable',
    line('会话总时长', 'Session elapsed', t ? duration(t.elapsedMs) : '—'), line('本轮耗时', 'Turn elapsed', t ? duration(t.turnMs) : '—'),
    line('累计运行', 'Running total', t ? duration(t.runningMs) : '—'), line('等待回答', 'Awaiting input', t ? duration(t.waitingMs) : '—'),
    line('压缩状态', 'Compaction', c ? zh ? { none: '尚未观察', running: '压缩中', completed: '已完成', failed: '失败' }[c.state] : c.state : '—'),
    line('压缩次数', 'Compaction count', c?.count), line('最近压缩耗时', 'Last compact duration', c?.elapsedMs === undefined ? '—' : duration(c.elapsedMs)),
    line('替换事件数', 'Shadowed events', c?.shadowedEvents), line('替换Token', 'Shadowed tokens', tokens(c?.shadowedTokens)),
    line('压缩配置', 'Compaction config', context.runtime.backend === 'dsh-profile' ? zh ? '由 Profile 管理，未确认阈值' : 'Profile-owned, threshold unverified' : zh ? '自带默认 80%；覆盖值待确认' : 'Bundled default 80%; overrides unverified'),
    line('会话', 'Session', context.session.sessionId), line('工作区', 'Workspace', context.runtime.workspace),
  ].join('\n')
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
    <Box flexGrow={1} /><Text dimColor wrap="truncate">{start + 1}–{Math.min(lines.length, start + capacity)}/{lines.length} · ↑↓</Text>
  </Box>
})
