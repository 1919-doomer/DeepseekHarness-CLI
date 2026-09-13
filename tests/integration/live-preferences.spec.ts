import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

const executable = process.env.DSHC_TEST_DSH ?? resolve('node_modules/.dshc-profile-validation/node_modules/@deepseek-ai/dsh/lib/bin.js')
describe.skipIf(process.env.DSHC_LIVE_V41 !== '1')('live composed preferences', () => {
  it.each(['bundled', 'dsh-profile'] as const)('uses %s read-only mode, reply language and style with a real model', async backend => {
    if (backend === 'dsh-profile' && !existsSync(executable)) return
    const root = await mkdtemp(resolve('node_modules/dshc-live-mode-'))
    await writeFile(join(root, 'fixture.txt'), 'READONLY-314159\n')
    const runtime = new HarnessRuntime({ workspace: root, model: 'deepseek-flash', maxTokens: 2048, activityTimeoutMs: 90_000,
      preferences: { runtime: backend, mode: 'review', style: 'explanatory', replyLanguage: 'zh-CN' },
      env: { ...process.env, DSH_HOME: join(root, 'home'), DSHC_DSH_EXECUTABLE: executable } })
    try {
      const result = await runtime.run('Read fixture.txt using the read tool. Explain what the marker means for this validation. Keep the answer to two short sentences. Do not modify any files.')
      expect(result.projection.lastTurnError).toBeUndefined()
      expect(result.finalResponse).toContain('READONLY-314159')
      expect(result.finalResponse).toMatch(/[\u4e00-\u9fff]/)
      expect(result.events.some(event => event.kind === 'tool-call' && event.name === 'read')).toBe(true)
      expect(await readFile(join(root, 'fixture.txt'), 'utf8')).toBe('READONLY-314159\n')
      console.log(JSON.stringify({ backend, mode: 'review', replyLanguage: 'zh-CN', style: 'explanatory', elapsedMs: result.metrics?.elapsedMs, events: result.eventCount }))
    } finally { await runtime.close(); await rm(root, { recursive: true, force: true }) }
  }, 120_000)
})
