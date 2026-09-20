import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'
import { buildHistoryContinuePrompt, selectHistoryEvidence } from '../../src/history/ask.js'
import type { HistorySessionDetail } from '../../src/history/types.js'

// Explicit opt-in: one real model request sequence against disposable evidence.
describe.skipIf(process.env.DSHC_LIVE_HISTORY !== '1')('live compact history reuse', () => {
  it('carries source labels to a fresh read-only session and re-checks current files', async () => {
    const root = await mkdtemp(resolve('node_modules/dshc-live-history-'))
    const path = join(root, 'fixture.txt')
    await writeFile(path, 'CURRENT-HISTORY-7391\n')
    const source: HistorySessionDetail = {
      summary: { id: 'historical-source', cwd: root, title: 'Read-only file check', createdAt: 1, updatedAt: 2,
        messageCount: 2, toolCallCount: 0, compactionCount: 0, approvalCount: 0 },
      messages: [
        { sessionId: 'historical-source', seq: 1, time: 1, role: 'user', text: '只读检查 fixture.txt 的内容。', truncatedChars: 0 },
        { sessionId: 'historical-source', seq: 2, time: 2, role: 'assistant', text: '旧文件内容是 STALE-OLD-0000，后续需要重新读取确认。', truncatedChars: 0 },
      ], approvals: [], eventCount: 2, droppedMessageCount: 0,
    }
    const prompt = buildHistoryContinuePrompt(selectHistoryEvidence(source, undefined,
      '继续只读检查。使用 read 工具重新读取 fixture.txt，回复当前内容，并引用历史里要求重新检查的来源标签。不要写入文件，不需要其他工具，回复不超过三句话。', 'continue', true))
    const runtime = new HarnessRuntime({ workspace: root, model: 'deepseek-flash', maxTokens: 2048,
      activityTimeoutMs: 90_000, preferences: { mode: 'review', replyLanguage: 'zh-CN' },
      env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_SESSION_ROOT: join(root, 'sessions') } })
    try {
      const result = await runtime.run(prompt, { sessionId: 'new-history-recipient' })
      expect(result.projection.lastTurnError).toBeUndefined()
      expect(result.events.some(event => event.kind === 'tool-call' && event.name === 'read')).toBe(true)
      expect(result.finalResponse).toContain('CURRENT-HISTORY-7391')
      expect(result.finalResponse).toContain('[session:historical-source#seq:2]')
      expect(await readFile(path, 'utf8')).toBe('CURRENT-HISTORY-7391\n')
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
  }, 120_000)
})
