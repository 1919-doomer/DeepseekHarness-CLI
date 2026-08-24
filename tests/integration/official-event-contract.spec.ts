import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TESTED_DSH_BASELINE } from '../../src/upstream/compatibility.js'
import { HarnessRuntime } from '../../src/upstream/runtime.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('official DeepSeek Harness rc.2 event contract', () => {
  it('captures successful and failed tool results from the real runtime wire', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-rc2-wire-'))
    tempRoots.push(root)
    await writeFile(join(root, 'wire.txt'), 'rc2-wire-marker\n', 'utf8')
    const stub = await startToolResultServer()
    const notifications: HarnessNotification[] = []
    const runtime = new HarnessRuntime({
      workspace: root,
      model: 'deepseek-v4-flash',
      maxTokens: 128,
      activityTimeoutMs: 20_000,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: 'dshc-rc2-event-contract-no-real-call',
        DEEPSEEK_BASE_URL: stub.baseUrl,
        DSH_HOME: join(root, '.dsh-home'),
        DSH_SESSION_ROOT: join(root, '.dsh-sessions'),
      },
    })

    try {
      const result = await runtime.run('Read wire.txt, then try missing.txt, then report completion.', {
        sessionId: 'rc2-event-contract',
        onNotification: notification => notifications.push(notification),
      })

      const calls = sessionEvents(notifications, 'tool/call')
      const results = sessionEvents(notifications, 'tool/result')
      expect(calls).toHaveLength(2)
      expect(results).toHaveLength(2)

      expect(eventData(calls[0])).toMatchObject({
        callId: 'rc2-read-ok',
        name: 'read',
        arguments: JSON.stringify({ file_path: 'wire.txt' }),
      })
      expect(eventData(calls[1])).toMatchObject({
        callId: 'rc2-read-fail',
        name: 'read',
        arguments: JSON.stringify({ file_path: 'missing.txt' }),
      })

      const successful = toolResultBlock(results[0])
      expect(successful).toMatchObject({
        callId: 'rc2-read-ok',
        toolCallId: 'rc2-read-ok',
        isError: false,
      })
      expect(successful.text).toContain('rc2-wire-marker')

      const failed = toolResultBlock(results[1])
      expect(failed).toMatchObject({
        callId: 'rc2-read-fail',
        toolCallId: 'rc2-read-fail',
        isError: true,
      })
      expect(failed.text).toContain('missing.txt')

      for (let index = 0; index < calls.length; index++) {
        const call = eventEnvelope(calls[index])
        const toolResult = eventEnvelope(results[index])
        expect(call.seq).toEqual(expect.any(Number))
        expect(call.time).toEqual(expect.any(Number))
        expect(toolResult.seq).toEqual(expect.any(Number))
        expect(toolResult.time).toEqual(expect.any(Number))
        expect(toolResult.sourceEventSeqs).toContain(call.seq)
      }

      const assistant = sessionEvents(notifications, 'assistant/message').at(-1)
      expect(assistant).toBeDefined()
      const assistantData = eventData(assistant)
      expect(assistantData.usage).toMatchObject({ inputTokens: expect.any(Number), outputTokens: expect.any(Number) })
      expect(record(assistantData.message)?.usage).toBeUndefined()

      expect(result.finalResponse).toBe('rc2-event-contract-complete')
      expect(runtime.metadata).toMatchObject({
        sdkVersion: TESTED_DSH_BASELINE.sdkVersion,
        runtimePackageVersion: TESTED_DSH_BASELINE.runtimePackageVersion,
      })
      expect(result.events.filter(event => event.kind === 'tool-result')).toEqual(expect.arrayContaining([
        expect.objectContaining({ callId: 'rc2-read-ok', isError: false }),
        expect.objectContaining({ callId: 'rc2-read-fail', isError: true }),
      ]))
      expect(result.events.some(event => event.kind === 'tool-result' && event.callId === 'unknown-call')).toBe(false)
    } finally {
      await runtime.close()
      await closeServer(stub.server)
    }
  }, 30_000)
})

function sessionEvents(notifications: readonly HarnessNotification[], type: string): Record<string, unknown>[] {
  return notifications.flatMap((notification) => {
    if (notification.method !== 'session.event') return []
    const event = record(notification.params.event)
    return event?.type === type ? [event] : []
  })
}

function eventEnvelope(event: Record<string, unknown> | undefined): {
  seq: number
  time: number
  sourceEventSeqs: number[]
} {
  return {
    seq: typeof event?.seq === 'number' ? event.seq : Number.NaN,
    time: typeof event?.time === 'number' ? event.time : Number.NaN,
    sourceEventSeqs: Array.isArray(event?.sourceEventSeqs)
      ? event.sourceEventSeqs.filter((value): value is number => typeof value === 'number')
      : [],
  }
}

function eventData(event: Record<string, unknown> | undefined): Record<string, unknown> {
  return record(event?.data) ?? {}
}

function toolResultBlock(event: Record<string, unknown> | undefined): {
  callId?: unknown
  toolCallId?: unknown
  isError?: unknown
  text: string
} {
  const message = record(eventData(event).message)
  const source = record(message?.source)
  const content = Array.isArray(message?.content) ? message.content : []
  const block = content.find(item => record(item)?.type === 'tool-result')
  const result = record(block)
  const nested = Array.isArray(result?.content) ? result.content : []
  return {
    callId: source?.callId,
    toolCallId: result?.toolCallId,
    isError: result?.isError,
    text: nested.flatMap(item => typeof record(item)?.text === 'string' ? [String(record(item)?.text)] : []).join(''),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function startToolResultServer(): Promise<{ server: Server; baseUrl: string }> {
  let requestIndex = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      if (requestIndex === 0) {
        respondWithToolCall(response, 'rc2-read-ok', { file_path: 'wire.txt' })
      } else if (requestIndex === 1) {
        respondWithToolCall(response, 'rc2-read-fail', { file_path: 'missing.txt' })
      } else {
        respondWithText(response, 'rc2-event-contract-complete')
      }
      requestIndex += 1
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('rc.2 event-contract server did not bind')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

function respondWithToolCall(response: ServerResponse, id: string, args: Record<string, unknown>): void {
  openSse(response)
  writeSse(response, {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name: 'read', arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  })
  writeSse(response, terminalChunk('tool_calls'))
  response.end('data: [DONE]\n\n')
}

function respondWithText(response: ServerResponse, text: string): void {
  openSse(response)
  writeSse(response, { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
  writeSse(response, terminalChunk('stop'))
  response.end('data: [DONE]\n\n')
}

function terminalChunk(reason: string): unknown {
  return {
    choices: [{ index: 0, delta: { content: '' }, finish_reason: reason }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  }
}

function openSse(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  response.flushHeaders()
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}
