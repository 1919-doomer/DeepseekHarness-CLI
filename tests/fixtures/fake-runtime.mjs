import readline from 'node:readline'

const mode = process.env.DSHC_FAKE_MODE ?? 'success'
let nextMessageId = 1
let closed = false

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function response(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sessionEvent(sessionId, type, data) {
  notify('session.event', {
    sessionId,
    event: {
      type,
      data,
      seq: 0,
      time: Date.now(),
    },
  })
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }

  if (request.method === 'initialize') {
    if (mode === 'malformed-initialize') {
      response(request.id, {})
      return
    }
    response(request.id, {
      serverInfo: {
        name: 'deepseek-harness-sdk-runtime',
        version: mode === 'bad-version' ? '0.0.2' : '0.0.1',
      },
    })
    return
  }

  if (request.method === 'session/prompt') {
    const sessionId = request.params?.sessionId ?? 'main'
    const messageId = `msg-${nextMessageId++}`

    if (mode === 'early-exit') {
      process.stderr.write(`fatal provider failure: ${process.env.DEEPSEEK_API_KEY ?? 'no-secret'}\n`)
      process.exitCode = 7
      rl.close()
      return
    }

    response(request.id, { messageId })

    // Unrelated global traffic must not leak into subscribeSessionTree(sessionId).
    notify('session.status', { sessionId: 'unrelated-session', status: 'running' })

    sessionEvent(sessionId, 'agent/inbox/spliced', {
      inserted: [{ id: messageId, role: 'user', content: request.params?.contentBlocks ?? [] }],
    })
    notify('session.status', { sessionId, status: 'running' })
    sessionEvent(sessionId, 'turn/start', { turn: 1 })
    sessionEvent(sessionId, 'user/message', {
      id: messageId,
      role: 'user',
      content: request.params?.contentBlocks ?? [],
    })

    if (mode === 'hang-activity') return

    sessionEvent(sessionId, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'hel' },
    })
    sessionEvent(sessionId, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 1, text: 'private-reasoning-must-not-render' },
    })
    sessionEvent(sessionId, 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'read',
      arguments: '{"path":"README.md"}',
    })
    sessionEvent(sessionId, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'README content' }],
      },
    })
    notify('subagent.started', {
      parentSessionId: sessionId,
      childSessionId: 'child-1',
      providerName: 'spawn',
    })
    notify('subagent.finished', {
      parentSessionId: sessionId,
      childSessionId: 'child-1',
    })
    sessionEvent(sessionId, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'lo' },
    })
    sessionEvent(sessionId, 'assistant/message', {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
    })
    sessionEvent(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    notify('session.status', { sessionId, status: 'idle' })
    return
  }

  if (request.method === 'shutdown') {
    if (mode === 'hang-shutdown') return
    response(request.id, {})
    closed = true
    rl.close()
  }
})

rl.on('close', () => {
  if (!closed && mode === 'early-exit') {
    process.exit(7)
    return
  }
  process.exit(0)
})

process.on('SIGTERM', () => process.exit(0))
