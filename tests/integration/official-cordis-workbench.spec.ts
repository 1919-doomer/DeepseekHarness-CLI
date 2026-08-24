import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessRuntime } from '../../src/upstream/runtime.js'
import { defaultRuntimeDevPatchPath } from '../../src/upstream/runtime-launcher.js'
import { CORDIS_TOOL_NAMES } from '../../src/workbench/contract.js'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('official Cordis plugin workbench contract', () => {
  it('runs inspect -> define -> run -> dynamic tool -> update -> stop -> undefine on the real runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m6-cordis-'))
    tempRoots.push(root)
    const requests: Record<string, unknown>[] = []
    const stub = await startCordisLifecycleServer(requests)
    const runtime = new HarnessRuntime({
      workspace: root,
      model: 'deepseek-v4-flash',
      maxTokens: 256,
      patchPaths: [defaultRuntimeDevPatchPath()],
      devMode: true,
      activityTimeoutMs: 30_000,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: 'dshc-m6-local-contract-no-real-call',
        DEEPSEEK_BASE_URL: stub.baseUrl,
        DSH_HOME: join(root, '.dsh-home'),
        DSH_SESSION_ROOT: join(root, '.dsh-sessions'),
      },
    })

    try {
      const result = await runtime.run('Exercise the complete host-only Cordis lifecycle.', {
        sessionId: 'm6-cordis-lifecycle',
      })

      expect(result.finalResponse).toBe('m6-cordis-lifecycle-complete')
      const calls = result.events.filter(event => event.kind === 'tool-call')
      expect(calls.map(event => event.name)).toEqual([
        'cordis_inspect_list',
        'cordis_define',
        'cordis_run',
        'm6_weather',
        'cordis_inspect_self',
        'cordis_define',
        'cordis_run',
        'm6_weather',
        'cordis_stop',
        'cordis_undefine',
      ])

      const lifecycleResults = result.events.filter((event): event is Extract<typeof event, { kind: 'tool-result' }> => (
        event.kind === 'tool-result' && event.name?.startsWith('cordis_') === true
      ))
      expect(lifecycleResults).toHaveLength(8)
      expect(lifecycleResults.every(event => !event.isError)).toBe(true)
      expect(lifecycleResults.find(event => event.name === 'cordis_define')?.metadata).toEqual({
        pluginId: 'wthr-1',
        packageId: 'pkg-1',
      })
      expect(result.events.filter(event => event.kind === 'tool-result' && event.name === 'm6_weather')).toEqual([
        expect.objectContaining({ isError: false, text: expect.stringContaining('sunny:Shanghai:v1') }),
        expect.objectContaining({ isError: false, text: expect.stringContaining('sunny:Shanghai:v2') }),
      ])

      expect(modelToolNames(requests[0])).toEqual(expect.arrayContaining([...CORDIS_TOOL_NAMES]))
      expect(requests.some(request => modelToolNames(request).includes('m6_weather'))).toBe(true)
      expect(modelToolNames(requests.at(-1))).not.toContain('m6_weather')
      expect(rawToolResultCount(result.notifications)).toBe(10)
    } finally {
      await runtime.close()
      await closeServer(stub.server)
    }
  }, 45_000)

  it('promotes a prototype to a normal source plugin + workspace patch and verifies it after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m6-persisted-weather-'))
    tempRoots.push(root)
    const patchPath = await writePersistedWeatherPackage(root)
    const requests: Record<string, unknown>[] = []
    const stub = await startPersistedWeatherServer(requests)

    try {
      for (const sessionId of ['persisted-before-restart', 'persisted-after-restart']) {
        const runtime = new HarnessRuntime({
          workspace: root,
          model: 'deepseek-v4-flash',
          maxTokens: 128,
          patchPaths: [patchPath],
          activityTimeoutMs: 20_000,
          env: {
            ...process.env,
            DEEPSEEK_API_KEY: 'dshc-m6-persisted-local-no-real-call',
            DEEPSEEK_BASE_URL: stub.baseUrl,
            DSH_HOME: join(root, `.dsh-home-${sessionId}`),
            DSH_SESSION_ROOT: join(root, `.dsh-sessions-${sessionId}`),
          },
        })
        try {
          const result = await runtime.run('Call the persisted weather tool.', { sessionId })
          expect(result.finalResponse).toBe('m6-persisted-weather-complete')
          expect(result.events).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'tool-call', name: 'm6_persisted_weather' }),
            expect.objectContaining({ kind: 'tool-result', name: 'm6_persisted_weather', isError: false, text: expect.stringContaining('persisted:Shanghai') }),
          ]))
        } finally {
          await runtime.close()
        }
      }

      expect(requests).toHaveLength(4)
      for (const request of [requests[0], requests[2]]) {
        const names = modelToolNames(request)
        expect(names).toContain('m6_persisted_weather')
        for (const name of CORDIS_TOOL_NAMES) expect(names).not.toContain(name)
      }
    } finally {
      await closeServer(stub.server)
    }
  }, 45_000)

  it('releases an active in-memory definition when the Harness process closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-m6-cordis-dispose-'))
    tempRoots.push(root)
    const requests: Record<string, unknown>[] = []
    const stub = await startActiveDefinitionServer(requests)

    try {
      const activeRuntime = devRuntime(root, stub.baseUrl, 'active')
      try {
        const result = await activeRuntime.run('Define and leave one host-only plugin running.', {
          sessionId: 'm6-active-definition',
        })
        expect(result.finalResponse).toBe('m6-active-definition-ready')
        expect(modelToolNames(requests[2])).toContain('m6_weather')
      } finally {
        // Deliberately omit cordis_stop/cordis_undefine. Whole-process shutdown
        // must still dispose the active run and its memory-only definition.
        await activeRuntime.close()
      }

      const restartedRuntime = devRuntime(root, stub.baseUrl, 'restarted')
      try {
        const result = await restartedRuntime.run('Verify the fresh process tool roster.', {
          sessionId: 'm6-after-active-close',
        })
        expect(result.finalResponse).toBe('m6-fresh-process-complete')
        expect(modelToolNames(requests[3])).not.toContain('m6_weather')
        expect(modelToolNames(requests[3])).toEqual(expect.arrayContaining([...CORDIS_TOOL_NAMES]))
      } finally {
        await restartedRuntime.close()
      }
    } finally {
      await closeServer(stub.server)
    }
  }, 45_000)
})

function devRuntime(root: string, baseUrl: string, suffix: string): HarnessRuntime {
  return new HarnessRuntime({
    workspace: root,
    model: 'deepseek-v4-flash',
    maxTokens: 128,
    patchPaths: [defaultRuntimeDevPatchPath()],
    devMode: true,
    activityTimeoutMs: 20_000,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'dshc-m6-dispose-local-no-real-call',
      DEEPSEEK_BASE_URL: baseUrl,
      DSH_HOME: join(root, `.dsh-home-${suffix}`),
      DSH_SESSION_ROOT: join(root, `.dsh-sessions-${suffix}`),
    },
  })
}

async function writePersistedWeatherPackage(root: string): Promise<string> {
  const sourceDir = join(root, 'packages', 'weather')
  const dshcDir = join(root, '.dshc')
  await mkdir(sourceDir, { recursive: true })
  await mkdir(dshcDir, { recursive: true })
  const sourcePath = join(sourceDir, 'index.mjs')
  const toolsUrl = import.meta.resolve('@deepseek-ai/dsh-tools')
  await writeFile(sourcePath, [
    `import { defineTool } from ${JSON.stringify(toolsUrl)}`,
    "export const name = 'm6-persisted-weather'",
    "export const inject = ['tools']",
    'export function apply(ctx) {',
    '  return ctx.tools.register(defineTool({',
    "    name: 'm6_persisted_weather',",
    "    description: 'Return a deterministic persisted weather marker.',",
    "    parameters: { city: { type: 'string', required: true } },",
    '    output: {',
    "      schema: { type: 'object', additionalProperties: false, properties: { forecast: { type: 'string', required: true } } },",
    "      render: (_args, value) => [{ type: 'text', text: value.forecast }],",
    '    },',
    "    async execute(args) { return { forecast: 'persisted:' + args.city } },",
    '  }))',
    '}',
    '',
  ].join('\n'), 'utf8')
  await writeFile(join(sourceDir, 'package.json'), `${JSON.stringify({
    name: '@dshc-test/m6-weather',
    version: '1.0.0',
    type: 'module',
    exports: './index.mjs',
  }, null, 2)}\n`, 'utf8')
  const patchPath = join(dshcDir, 'cordis.patch.yml')
  await writeFile(patchPath, [
    '- insert:',
    '    - id: m6-persisted-weather',
    `      name: ${JSON.stringify(pathToFileURL(sourcePath).href)}`,
    '',
  ].join('\n'), 'utf8')
  return patchPath
}

async function startPersistedWeatherServer(
  requests: Record<string, unknown>[],
): Promise<{ server: Server; baseUrl: string }> {
  let callIndex = 0
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>
      requests.push(parsed)
      if (JSON.stringify(parsed['messages']).includes('persisted:Shanghai')) {
        respondWithText(response, 'm6-persisted-weather-complete')
      } else {
        respondWithToolCall(response, `m6-persisted-weather-${++callIndex}`, 'm6_persisted_weather', { city: 'Shanghai' })
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('M6 persisted weather server did not bind')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function startCordisLifecycleServer(
  requests: Record<string, unknown>[],
): Promise<{ server: Server; baseUrl: string }> {
  let requestIndex = 0
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>
      requests.push(parsed)
      const ids = definedIds(parsed)
      switch (requestIndex) {
        case 0:
          respondWithToolCall(response, 'm6-inspect-list', 'cordis_inspect_list', {})
          break
        case 1:
          respondWithToolCall(response, 'm6-define-v1', 'cordis_define', {
            plugin: { kind: 'new', idPrefix: 'wthr' },
            name: 'M6 Weather v1',
            purpose: 'Return a deterministic weather marker for workbench acceptance.',
            code: { host: weatherHostCode('v1') },
          })
          break
        case 2:
          respondWithToolCall(response, 'm6-run-v1', 'cordis_run', {
            pluginId: required(ids.at(-1)?.pluginId, 'first plugin id'),
            packageId: required(ids.at(-1)?.packageId, 'first package id'),
            mode: 'run',
          })
          break
        case 3:
          respondWithToolCall(response, 'm6-weather-v1', 'm6_weather', { city: 'Shanghai' })
          break
        case 4:
          respondWithToolCall(response, 'm6-inspect-self', 'cordis_inspect_self', {
            pluginId: required(ids.at(-1)?.pluginId, 'inspect plugin id'),
            packageId: required(ids.at(-1)?.packageId, 'inspect package id'),
          })
          break
        case 5:
          respondWithToolCall(response, 'm6-define-v2', 'cordis_define', {
            plugin: { kind: 'existing', pluginId: required(ids.at(-1)?.pluginId, 'update plugin id') },
            name: 'M6 Weather v2',
            purpose: 'Return the updated deterministic weather marker.',
            code: { host: weatherHostCode('v2') },
          })
          break
        case 6:
          respondWithToolCall(response, 'm6-run-v2', 'cordis_run', {
            pluginId: required(ids.at(-1)?.pluginId, 'second plugin id'),
            packageId: required(ids.at(-1)?.packageId, 'second package id'),
            mode: 'update',
          })
          break
        case 7:
          respondWithToolCall(response, 'm6-weather-v2', 'm6_weather', { city: 'Shanghai' })
          break
        case 8:
          respondWithToolCall(response, 'm6-stop', 'cordis_stop', {
            pluginId: required(ids.at(-1)?.pluginId, 'stop plugin id'),
          })
          break
        case 9:
          respondWithToolCall(response, 'm6-undefine', 'cordis_undefine', {
            pluginId: required(ids.at(-1)?.pluginId, 'undefine plugin id'),
          })
          break
        default:
          respondWithText(response, 'm6-cordis-lifecycle-complete')
      }
      requestIndex += 1
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('M6 Cordis server did not bind')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function startActiveDefinitionServer(
  requests: Record<string, unknown>[],
): Promise<{ server: Server; baseUrl: string }> {
  let requestIndex = 0
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>
      requests.push(parsed)
      const ids = definedIds(parsed)
      if (requestIndex === 0) {
        respondWithToolCall(response, 'm6-dispose-define', 'cordis_define', {
          plugin: { kind: 'new', idPrefix: 'disp' },
          name: 'M6 disposable weather',
          purpose: 'Prove active dynamic definitions are process-memory only.',
          code: { host: weatherHostCode('disposable') },
        })
      } else if (requestIndex === 1) {
        respondWithToolCall(response, 'm6-dispose-run', 'cordis_run', {
          pluginId: required(ids.at(-1)?.pluginId, 'disposable plugin id'),
          packageId: required(ids.at(-1)?.packageId, 'disposable package id'),
          mode: 'run',
        })
      } else if (requestIndex === 2) {
        respondWithText(response, 'm6-active-definition-ready')
      } else {
        respondWithText(response, 'm6-fresh-process-complete')
      }
      requestIndex += 1
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('M6 active-definition server did not bind')
  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

function weatherHostCode(version: string): string {
  return [
    'return {',
    '  inject: ["tools"],',
    '  apply(ctx) {',
    '    const tool = harness.defineTool({',
    '      name: "m6_weather",',
    '      description: "Return a deterministic local weather marker.",',
    '      parameters: { city: { type: "string", required: true } },',
    '      output: {',
    '        schema: { type: "object", additionalProperties: false, properties: { forecast: { type: "string", required: true } } },',
    '        render: (_args, value) => [{ type: "text", text: value.forecast }]',
    '      },',
    `      execute: async (args) => ({ forecast: "sunny:" + args.city + ":${version}" })`,
    '    });',
    '    return harness.registerTool(ctx, tool);',
    '  }',
    '};',
  ].join('\n')
}

function definedIds(request: Record<string, unknown>): { pluginId: string; packageId: string }[] {
  const messages = request['messages']
  const text = JSON.stringify(messages)
  return [...text.matchAll(/Defined ([a-z]{3,6}-\d+)\/(pkg-\d+)/g)].map(match => ({
    pluginId: match[1]!,
    packageId: match[2]!,
  }))
}

function required(value: string | undefined, label: string): string {
  if (value === undefined) throw new Error(`Model stub could not recover ${label} from the structured conversation result`)
  return value
}

function modelToolNames(request: Record<string, unknown> | undefined): string[] {
  const tools = request?.['tools']
  if (!Array.isArray(tools)) return []
  return tools.flatMap(tool => {
    const record = isRecord(tool) ? tool : undefined
    const fn = isRecord(record?.function) ? record.function : undefined
    const name = fn?.name ?? record?.name
    return typeof name === 'string' ? [name] : []
  })
}

function rawToolResultCount(notifications: readonly HarnessNotification[]): number {
  return notifications.filter(notification => {
    if (notification.method !== 'session.event') return false
    const event = notification.params.event
    return isRecord(event) && event.type === 'tool/result'
  }).length
}

function respondWithToolCall(
  response: ServerResponse,
  id: string,
  name: string,
  args: Record<string, unknown>,
): void {
  openSse(response)
  writeSse(response, {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: null,
    }],
  })
  writeSse(response, terminalChunk('tool_calls'))
  response.end('data: [DONE]\n\n')
}

function respondWithText(response: ServerResponse, content: string): void {
  openSse(response)
  writeSse(response, { choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}
