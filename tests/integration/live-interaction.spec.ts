import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'
import { SessionClock } from '../../src/session/session-clock.js'
import { buildPlanHandoff } from '../../src/history/plan-handoff.js'
import type { InteractionRequest } from '../../src/upstream/interaction.js'
describe.skipIf(process.env.DSHC_LIVE_INTERACTION !== '1')('live interaction and automatic compaction', () => {
  it('uses structured questions and presents a plan with a real model', async () => {
    const root = await mkdtemp(resolve('node_modules/dshc-live-interaction-'))
    const runtime = new HarnessRuntime({ workspace: root, preferences: { mode: 'plan', replyLanguage: 'zh-CN' }, maxTokens: 2048, activityTimeoutMs: 90_000,
      env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_SESSION_ROOT: join(root, 'sessions') } })
    runtime.enableInteraction(); const observed: string[] = []
    let approved: (InteractionRequest & { kind: 'plan' }) | undefined
    let coding: HarnessRuntime | undefined
    runtime.interaction!.subscribe(() => {
      const request = runtime.interaction!.current
      if (!request) return
      observed.push(request.kind)
      if (request.kind === 'plan') approved = request
      runtime.interaction!.answer(request.id, request.kind === 'questions' ? { action: 'submit', answers: request.questions.map(q => ({ id: q.id, option: 0, text: '中文说明，保持简洁' })) } : { action: 'implement' })
    })
    try {
      const result = await runtime.run('这是交互工具验证。先调用 request_user_input，只问一个有关界面语言的问题并提供中文/英文两个选项。收到答案后调用 present_plan，计划在下一编码会话中创建 greeting.txt，内容精确为 hello，然后读文件验证。现在不读写文件，不调用其他工具。收到计划选择后用一句中文结束。', { sessionId: 'live-plan-source' })
      expect(result.projection.lastTurnError).toBeUndefined()
      expect(observed).toContain('questions'); expect(observed).toContain('plan')
      expect(result.events.some(e => e.kind === 'tool-result' && e.isError)).toBe(false)
      expect(approved).toBeDefined()
      coding = new HarnessRuntime({ workspace: root, preferences: { mode: 'code' }, maxTokens: 2048, activityTimeoutMs: 90_000,
        env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_SESSION_ROOT: join(root, 'sessions') } })
      const executed = await coding.run(buildPlanHandoff('live-plan-source', approved!.title, approved!.text, [{ language: 'zh-CN' }]), { sessionId: 'live-code-target' })
      expect(executed.projection.lastTurnError).toBeUndefined()
      expect((await readFile(join(root, 'greeting.txt'), 'utf8')).trim()).toBe('hello')
      console.log(JSON.stringify({ live: 'questions-plan', observed, events: result.eventCount, usage: result.metrics?.usage }))
    } finally { await coding?.close(); await runtime.close(); await rm(root, { recursive: true, force: true }) }
  }, 120_000)
  it('observes automatic compaction in an isolated lower-threshold configuration', async () => {
    const root = await mkdtemp(resolve('node_modules/dshc-live-compact-'))
    const patch = join(root, 'compact.patch.yml')
    await writeFile(patch, '- id: compaction-basic\n  config:\n    thresholdRatio: 0.02\n    retainRatio: 0.000001\n    maxTokens: 2048\n    compactionRetries: 1\n')
    const runtime = new HarnessRuntime({ workspace: root, maxTokens: 256, patchPaths: [patch], activityTimeoutMs: 90_000,
      env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_SESSION_ROOT: join(root, 'sessions') } })
    const sessionId = 'live-compact'; const clock = new SessionClock(); clock.reset(sessionId)
    const observe = { sessionId, onEvent: (event: Parameters<SessionClock['observe']>[0]) => clock.observe(event) }
    try {
      const reference = Array.from({ length: 1800 }, (_, i) => `Record ${i}: terminal width 120 columns, language Chinese, task display and scroll regression fixture.`).join('\n')
      const first = await runtime.run(`Memorize only the topic of this reference data; exact record numbers are unimportant. Reply ACK only, no tools.\n${reference}`, observe)
      expect(first.projection.lastTurnError).toBeUndefined()
      const second = await runtime.run('Reply with the reference topic in one short sentence, no tools.', observe)
      expect(second.projection.lastTurnError).toBeUndefined()
      expect(clock.compaction.count).toBeGreaterThan(0)
      expect(clock.compaction.state).toBe('completed')
      console.log(JSON.stringify({ live: 'automatic-compaction', compaction: clock.compaction }))
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
  }, 120_000)
})
