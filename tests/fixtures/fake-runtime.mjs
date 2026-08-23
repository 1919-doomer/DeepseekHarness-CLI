import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const mode = process.env.DSHC_FAKE_MODE ?? 'success'
const logPath = process.env.DSHC_FAKE_LOG
const lifecycleLogPath = process.env.DSHC_FAKE_LIFECYCLE_LOG
let nextMessageId = 1
let closed = false

function logLifecycle(event) {
  if (!lifecycleLogPath) return
  appendFileSync(lifecycleLogPath, `${JSON.stringify({ event, pid: process.pid })}\n`, 'utf8')
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function response(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

// Upstream increments seq per event and timestamps each one; a derived event
// names the sequences it came from. Emitting a constant seq and no causal link
// would let the pairing logic pass here while failing on the wire.
let nextEventSeq = 0

// A reply long enough to overflow a short frame. Wide characters are included
// because the sessions that exposed the compression were Chinese, where a line
// occupies twice the columns its length suggests.
function verboseAnswer() {
  const lines = []
  for (let index = 0; index < 40; index++) {
    lines.push(`第 ${index} 行：这是一段足够长的中文回答，用来把整帧填满`)
  }
  return lines.join('\n')
}

function finalAnswer() {
  if (mode === 'verbose') return verboseAnswer()
  if (mode === 'markdown') return markdownAnswer()
  return 'hello'
}

// What a model actually emits into a chat reply: emphasis, a list, a fenced
// block whose contents must survive verbatim, and a CJK table whose columns
// only line up if width is measured in cells.
function markdownAnswer() {
  return [
    '## Findings',
    '',
    'The **parser** is fine; the *caller* is not. Run `pnpm check` first.',
    '',
    '- first point',
    '- second point',
    '',
    '```ts',
    'const literal = "**not bold**"',
    '```',
    '',
    '| 文件 | 说明 |',
    '| --- | --- |',
    '| a.ts | 入口 |',
  ].join('\n')
}

function sessionEvent(sessionId, type, data, sourceEventSeqs) {
  const seq = nextEventSeq++
  notify('session.event', {
    sessionId,
    event: {
      type,
      data,
      seq,
      time: Date.now(),
      ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
    },
  })
  return seq
}

function emitReceiptAndStart(sessionId, messageId, contentBlocks, turn) {
  sessionEvent(sessionId, 'agent/inbox/spliced', {
    inserted: [{ id: messageId, role: 'user', content: contentBlocks }],
  })
  notify('session.status', { sessionId, status: 'running' })
  sessionEvent(sessionId, 'turn/start', { turn })
  sessionEvent(sessionId, 'user/message', {
    id: messageId,
    role: 'user',
    content: contentBlocks,
  })
}

function emitCompletedTurn(sessionId, turn) {
  sessionEvent(sessionId, 'step/start', { turn, step: 1 })
  sessionEvent(sessionId, 'assistant/chunk', {
    turn,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: 'working' },
  })
  sessionEvent(sessionId, 'assistant/chunk', {
    turn,
    step: 1,
    chunk: { type: 'reasoning-delta', index: 1, text: 'private-reasoning-must-not-render' },
  })
  sessionEvent(sessionId, 'assistant/message', {
    turn,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'working' },
        { type: 'tool-call', id: `call-${turn}`, name: 'read', arguments: '{"path":"README.md"}' },
      ],
    },
    // Sibling of `message`, matching a payload captured from a live rc.1
    // runtime. A fixture that agreed with a guess is what kept the suite green
    // while every tool result projected as a success (#84).
    usage: { inputTokens: 4267, outputTokens: 2, cacheReadTokens: 384, reasoningTokens: 0 },
  })

  const rootCallSeq = sessionEvent(sessionId, 'tool/call', {
    turn,
    step: 1,
    callId: `call-${turn}`,
    name: 'read',
    arguments: '{"path":"README.md"}',
  })

  const childSessionId = `child-${turn}`
  notify('subagent.started', {
    parentSessionId: sessionId,
    childSessionId,
    providerName: 'spawn',
  })
  notify('session.status', { sessionId: childSessionId, status: 'running' })
  sessionEvent(childSessionId, 'assistant/chunk', {
    turn: 1,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: 'child' },
  })
  sessionEvent(childSessionId, 'assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'child' }],
    },
    usage: { inputTokens: 900, outputTokens: 5 },
  })
  const childCallSeq = sessionEvent(childSessionId, 'tool/call', {
    turn: 1,
    step: 1,
    callId: `call-${turn}`,
    name: 'child-read',
    arguments: '{}',
  })
  sessionEvent(childSessionId, 'tool/result', {
    turn: 1,
    step: 1,
    message: {
      // Mirrors the live DSH payload: the call id and error flag live on the
      // nested tool-result block, not on the message itself.
      source: { kind: 'tool', callId: `call-${turn}` },
      content: [{
        type: 'tool-result',
        toolCallId: `call-${turn}`,
        content: [{ type: 'text', text: 'child result' }],
        isError: false,
      }],
      role: 'user',
      id: 'fixture-child-result',
    },
  }, [childCallSeq])
  notify('session.status', { sessionId: childSessionId, status: 'idle' })
  notify('subagent.finished', {
    parentSessionId: sessionId,
    childSessionId,
  })

  sessionEvent(sessionId, 'tool/result', {
    turn,
    step: 1,
    message: {
      // Mirrors the live DSH payload: the call id and error flag live on the
      // nested tool-result block, not on the message itself.
      source: { kind: 'tool', callId: `call-${turn}` },
      content: [{
        type: 'tool-result',
        toolCallId: `call-${turn}`,
        content: [{ type: 'text', text: 'README content' }],
        isError: false,
      }],
      role: 'user',
      id: 'fixture-root-result',
    },
  }, [rootCallSeq])
  sessionEvent(sessionId, 'step/end', { turn, step: 1 })

  sessionEvent(sessionId, 'step/start', { turn, step: 2 })
  sessionEvent(sessionId, 'assistant/chunk', {
    turn,
    step: 2,
    chunk: { type: 'text-delta', index: 0, text: 'hel' },
  })
  sessionEvent(sessionId, 'assistant/chunk', {
    turn,
    step: 2,
    chunk: { type: 'text-delta', index: 1, text: 'lo' },
  })
  sessionEvent(sessionId, 'assistant/message', {
    turn,
    step: 2,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: finalAnswer() }],
    },
  })
  sessionEvent(sessionId, 'step/end', { turn, step: 2 })
  sessionEvent(sessionId, 'turn/end', { turn, reason: { kind: 'completed' } })
  notify('session.status', { sessionId, status: 'idle' })
}

function emitTurn(sessionId, messageId, contentBlocks, turn) {
  emitReceiptAndStart(sessionId, messageId, contentBlocks, turn)
  if (mode === 'hang-activity') return

  if (mode === 'slow-receipt-turn') {
    setTimeout(() => emitCompletedTurn(sessionId, turn), 40)
    return
  }

  emitCompletedTurn(sessionId, turn)
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
    logLifecycle('initialize-request')
    if (mode === 'malformed-initialize') {
      response(request.id, {})
      return
    }
    const reply = () => {
      if (closed) return
      response(request.id, {
        serverInfo: {
          name: 'deepseek-harness-sdk-runtime',
          version: mode === 'bad-version' ? '0.0.2' : '0.0.1',
        },
      })
      logLifecycle('initialize-response')
    }
    if (mode === 'slow-initialize') {
      setTimeout(reply, 300)
      return
    }
    reply()
    return
  }

  if (request.method === 'session/prompt') {
    const sessionId = request.params?.sessionId ?? 'main'
    const messageId = `msg-${nextMessageId++}`
    const turn = nextMessageId - 1
    const contentBlocks = request.params?.contentBlocks ?? []

    if (logPath) {
      appendFileSync(logPath, `${JSON.stringify({
        sessionId,
        messageId,
        contentBlocks,
      })}\n`, 'utf8')
    }

    if (mode === 'early-exit') {
      process.stderr.write(`fatal provider failure: ${process.env.DEEPSEEK_API_KEY ?? 'no-secret'}\n`)
      process.exitCode = 7
      rl.close()
      return
    }

    response(request.id, { messageId })

    // Unrelated global traffic must not leak into subscribeSessionTree(sessionId).
    notify('session.status', { sessionId: 'unrelated-session', status: 'running' })

    if (mode === 'slow-receipt-turn') {
      setTimeout(() => emitTurn(sessionId, messageId, contentBlocks, turn), 60)
      return
    }

    emitTurn(sessionId, messageId, contentBlocks, turn)
    return
  }

  if (request.method === 'shutdown') {
    logLifecycle('shutdown-request')
    if (mode === 'hang-shutdown') return
    response(request.id, {})
    closed = true
    rl.close()
  }
})

rl.on('close', () => {
  logLifecycle('process-exit')
  if (!closed && mode === 'early-exit') {
    process.exit(7)
    return
  }
  process.exit(0)
})

process.on('SIGTERM', () => {
  logLifecycle('sigterm')
  process.exit(0)
})
