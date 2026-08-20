import { appendFileSync } from 'node:fs'
import readline from 'node:readline'

const mode = process.env.DSHC_DOCTOR_FAKE_MODE ?? 'success'
const logPath = process.env.DSHC_DOCTOR_FAKE_LOG
let closed = false

function log(method) {
  if (!logPath) return
  appendFileSync(logPath, `${method}\n`, 'utf8')
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function response(id, result) {
  send({ jsonrpc: '2.0', id, result })
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

  log(String(request.method ?? 'unknown'))

  if (request.method === 'initialize') {
    if (mode === 'malformed') {
      response(request.id, {})
      return
    }
    response(request.id, {
      serverInfo: {
        name: mode === 'bad-server' ? 'unexpected-runtime' : 'deepseek-harness-sdk-runtime',
        version: mode === 'bad-version' ? '9.9.9' : '0.0.1',
      },
    })
    return
  }

  if (request.method === 'shutdown') {
    response(request.id, {})
    closed = true
    rl.close()
    return
  }

  response(request.id, {})
})

rl.on('close', () => {
  if (!closed) process.exitCode = 0
})
