import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { AgentWindows, agentWindowEnvironment, type AgentWindowLaunch } from '../../src/terminal/agent-windows.js'
import type { TranscriptBlock } from '../../src/plugins/api.js'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
interface WindowSnapshot { entries: { sequence: number; text: string }[]; ended: boolean; truncated: boolean }
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await delay(30) }; throw new Error('Window condition timed out') }
const blocks: TranscriptBlock[] = [
  { id: 'root', kind: 'assistant', sessionId: 'root', text: 'root text' },
  { id: 'child', kind: 'assistant', sessionId: 'child', text: 'child text' },
  { id: 'marker', kind: 'agent', sessionId: 'root', text: 'child' },
]

it('enables color in the new console without changing the parent environment', () => {
  const parent = { NO_COLOR: '1', TERM: 'dumb', INK_SCREEN_READER: 'true' }
  const env = agentWindowEnvironment({ url: 'http://127.0.0.1:1234/events', token: 'fixture', sessionId: 'child', locale: 'zh-CN' }, parent)
  expect(env.NO_COLOR).toBeUndefined()
  expect(env.TERM).toBe('xterm-256color')
  expect(env.DSHC_AGENT_COLOR).toBe('1')
  expect(env.INK_SCREEN_READER).toBe('true')
  expect(parent).toEqual({ NO_COLOR: '1', TERM: 'dumb', INK_SCREEN_READER: 'true' })
})

it('authenticates each window, separates child output only after connection and bounds retained output', async () => {
  const launches: AgentWindowLaunch[] = []
  const windows = new AgentWindows('root', 'zh-CN', async value => { launches.push(value) })
  try {
    windows.observe({ sequence: 1, kind: 'subagent-started', parentSessionId: 'root', childSessionId: 'child' })
    windows.observe({ sequence: 2, kind: 'subagent-started', parentSessionId: 'child', childSessionId: 'nested' })
    windows.observe({ sequence: 3, kind: 'assistant-delta', sessionId: 'child', text: '中文\x1b[31m' })
    windows.observe({ sequence: 4, kind: 'assistant-message', sessionId: 'nested', text: 'nested-only' })
    await until(() => launches.length === 2)
    expect(windows.transcript(blocks)).toHaveLength(3)
    const first = launches[0]!
    expect((await fetch(first.url)).status).toBe(403)
    const headers = { authorization: `Bearer ${first.token}` }
    expect((await fetch(first.url, { headers: { ...headers, origin: 'https://example.com' } })).status).toBe(403)
    const response = await (await fetch(first.url, { headers })).json() as WindowSnapshot
    expect(JSON.stringify(response)).toContain('中文')
    expect(JSON.stringify(response)).not.toContain('nested-only')
    expect(response.entries.map((entry: { text: string }) => entry.text).join('')).not.toContain('\x1b')
    expect(windows.transcript(blocks).map(block => block.id)).toEqual(['root', 'marker'])
    const hidden = new Set<string>(); windows.syncSeparated(hidden)
    expect(hidden.has('child')).toBe(true)
    expect(windows.separated('nested')).toBe(false)
    for (let i = 0; i < 700; i++) windows.observe({ sequence: i + 5, kind: 'assistant-delta', sessionId: 'child', text: 'x'.repeat(1000) })
    const tail = await (await fetch(first.url, { headers })).json() as WindowSnapshot
    expect(tail.truncated).toBe(true)
    expect(tail.entries.length).toBeLessThanOrEqual(256)
    windows.observe({ sequence: 999, kind: 'subagent-finished', parentSessionId: 'root', childSessionId: 'child' })
    expect((await (await fetch(first.url, { headers })).json() as WindowSnapshot).ended).toBe(true)
    windows.close()
    await expect(fetch(first.url, { headers })).rejects.toThrow()
  } finally { windows.close() }
})

it('keeps inline output on launch failure and restores it when a connected reader disappears', async () => {
  let launch: AgentWindowLaunch | undefined
  const failed = new AgentWindows('root', 'en', async () => { throw new Error('No desktop') })
  const windows = new AgentWindows('root', 'en', async value => { launch = value })
  try {
    failed.observe({ sequence: 1, kind: 'subagent-started', parentSessionId: 'root', childSessionId: 'child' })
    await until(() => failed.transcript(blocks).some(block => block.detail?.includes('unavailable')))
    expect(failed.transcript(blocks)).toHaveLength(3)
    windows.observe({ sequence: 1, kind: 'subagent-started', parentSessionId: 'root', childSessionId: 'child' })
    await until(() => launch !== undefined)
    await fetch(launch!.url, { headers: { authorization: `Bearer ${launch!.token}` } })
    expect(windows.separated('child')).toBe(true)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_000)
    try { await until(() => !windows.separated('child')) } finally { clock.mockRestore() }
    expect(windows.transcript(blocks)).toHaveLength(3)
  } finally { windows.close(); failed.close() }
})

it('streams to the real read-only viewer and closing it leaves the owner usable', async () => {
  let launch: AgentWindowLaunch | undefined
  const windows = new AgentWindows('root', 'zh-CN', async value => { launch = value })
  windows.observe({ sequence: 1, kind: 'subagent-started', parentSessionId: 'root', childSessionId: 'child' })
  await until(() => launch !== undefined)
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../runtime/agent-window.mjs', import.meta.url))], {
    env: agentWindowEnvironment(launch!, { ...process.env, NO_COLOR: '1', TERM: 'dumb', INK_SCREEN_READER: 'false' }),
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { output += text }); child.stderr.resume()
  try {
    windows.observe({ sequence: 2, kind: 'assistant-message', sessionId: 'child', text: '正在检查项目' })
    await until(() => output.includes('正在检查项目'))
    expect(output).toContain('\x1b[38;2;217;119;87m')
    expect(output).toContain('╭')
    windows.observe({ sequence: 3, kind: 'subagent-finished', parentSessionId: 'root', childSessionId: 'child' })
    await until(() => output.includes('Enter 关闭窗口'))
    expect((await fetch(launch!.url, { headers: { authorization: `Bearer ${launch!.token}` } })).status).toBe(200)
    windows.close()
    await delay(400)
    expect(output).not.toContain('主窗口已结束或连接断开')
    const exited = once(child, 'exit'); child.stdin.write('\n'); expect((await exited)[0]).toBe(0)
  } finally { child.kill(); windows.close() }
})
