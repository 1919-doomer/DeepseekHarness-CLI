import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import { createSessionId } from '../session/interactive-state.js'
import type { NormalizedEvent } from '../session/projection.js'
import { classifyRuntimeError } from '../upstream/errors.js'
import { HarnessRuntime, type HarnessRuntimeMetadata } from '../upstream/runtime.js'
import { DSHC_VERSION } from '../version.js'
import type {
  TerminalCommandContext,
  TerminalCommandOutcome,
  TerminalRuntimePhase,
  TerminalViewContext,
  TranscriptBlock,
} from '../plugins/api.js'
import { createDefaultTerminalHost } from '../plugins/builtins.js'
import type { TerminalPluginHost } from '../plugins/host.js'
import {
  appendSystemMessage,
  appendUserPrompt,
  initialTerminalTranscript,
  reduceTerminalEvent,
  type TerminalTranscriptState,
} from './transcript.js'
import { sanitizeTerminalText } from './sanitize.js'

const ALT_SCREEN_ON = '\u001B[?1049h'
const ALT_SCREEN_OFF = '\u001B[?1049l'
export const DEFAULT_FOLD_LIMIT = 1_200

export interface TerminalProductOptions {
  debug?: boolean
  initialSessionId?: string
  host?: TerminalPluginHost
  useAlternateScreen?: boolean
}

export interface TerminalProductResult {
  exitCode: number
  interrupted: boolean
  totalTurns: number
  sessionId: string
}

interface FinishResult extends TerminalProductResult {}

export async function runTerminalProduct(
  runtime: HarnessRuntime,
  options: TerminalProductOptions = {},
): Promise<TerminalProductResult> {
  const metadata = await runtime.start()
  const host = options.host ?? createDefaultTerminalHost()
  const initialSessionId = options.initialSessionId ?? createSessionId()
  const alternate = options.useAlternateScreen ?? true
  let alternateEntered = false
  let instance: ReturnType<typeof render> | undefined
  let latest = { totalTurns: 0, sessionId: initialSessionId }
  let signalClosing = false

  let finishResolve!: (result: FinishResult) => void
  const finished = new Promise<FinishResult>(resolve => { finishResolve = resolve })
  let finishedOnce = false
  const finish = (result: FinishResult): void => {
    if (finishedOnce) return
    finishedOnce = true
    finishResolve(result)
  }

  const closeForSignal = (exitCode: number): void => {
    if (signalClosing) return
    signalClosing = true
    finish({
      exitCode,
      interrupted: true,
      totalTurns: latest.totalTurns,
      sessionId: latest.sessionId,
    })
    void runtime.close().catch(() => undefined)
  }
  const onInt = (): void => closeForSignal(130)
  const onTerm = (): void => closeForSignal(143)

  try {
    if (alternate) {
      process.stdout.write(ALT_SCREEN_ON)
      alternateEntered = true
    }
    process.once('SIGINT', onInt)
    process.once('SIGTERM', onTerm)

    instance = render(
      <TerminalProductApp
        runtime={runtime}
        metadata={metadata}
        host={host}
        debug={options.debug ?? false}
        initialSessionId={initialSessionId}
        onProgress={(totalTurns, sessionId) => { latest = { totalTurns, sessionId } }}
        onFinish={finish}
      />,
      { exitOnCtrlC: false, patchConsole: false },
    )

    const result = await finished
    const current = instance
    instance = undefined
    current.unmount()
    await current.waitUntilExit().catch(() => undefined)
    return result
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
    instance?.unmount()
    if (alternateEntered) process.stdout.write(ALT_SCREEN_OFF)
  }
}

interface AppProps {
  runtime: HarnessRuntime
  metadata: HarnessRuntimeMetadata
  host: TerminalPluginHost
  debug: boolean
  initialSessionId: string
  onProgress(totalTurns: number, sessionId: string): void
  onFinish(result: FinishResult): void
}

function TerminalProductApp(props: AppProps): React.ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [size, setSize] = useState(() => ({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 }))
  const [sessionId, setSessionId] = useState(props.initialSessionId)
  const [generation, setGeneration] = useState(1)
  const [sessionTurns, setSessionTurns] = useState(0)
  const [totalTurns, setTotalTurns] = useState(0)
  const [phase, setPhase] = useState<TerminalRuntimePhase>('idle')
  const [transcript, setTranscript] = useState<TerminalTranscriptState>(initialTerminalTranscript)
  const [events, setEvents] = useState<readonly NormalizedEvent[]>([])
  const [input, setInput] = useState('')
  const [cursor, setCursor] = useState(0)
  const [activeView, setActiveView] = useState<string | undefined>()
  const [history, setHistory] = useState<readonly string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | undefined>()
  const runningRef = useRef(false)
  const interruptingRef = useRef(false)
  const totalTurnsRef = useRef(0)
  const sessionRef = useRef(sessionId)
  const idRef = useRef(0)

  sessionRef.current = sessionId
  totalTurnsRef.current = totalTurns

  useEffect(() => {
    props.onProgress(totalTurns, sessionId)
  }, [props.onProgress, sessionId, totalTurns])

  useEffect(() => {
    const onResize = (): void => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout])

  const nextId = useCallback((prefix: string): string => `${prefix}-${++idRef.current}`, [])

  const commandContext = useCallback((): TerminalCommandContext => ({
    runtime: props.metadata,
    session: { sessionId, turnCount: sessionTurns, generation },
    phase,
    totalTurns,
  }), [generation, phase, props.metadata, sessionId, sessionTurns, totalTurns])

  const viewContext = useCallback((): TerminalViewContext => ({
    ...commandContext(),
    commands: props.host.listCommands(),
    renderers: props.host.listRenderers(),
    plugins: props.host.listPlugins(),
    events,
  }), [commandContext, events, props.host])

  const finish = useCallback((exitCode: number, interrupted: boolean): void => {
    props.onFinish({
      exitCode,
      interrupted,
      totalTurns: totalTurnsRef.current,
      sessionId: sessionRef.current,
    })
    exit()
  }, [exit, props])

  const interrupt = useCallback((): void => {
    if (interruptingRef.current) return
    interruptingRef.current = true
    if (runningRef.current) {
      setTranscript(state => appendSystemMessage(
        state,
        `Ctrl+C closes the entire Harness runtime; protocol ${props.metadata.protocolVersion} has no prompt-level cancel.`,
        'interrupt',
        nextId('interrupt'),
      ))
    }
    setPhase('closing')
    void props.runtime.close().finally(() => finish(130, true))
  }, [finish, nextId, props.metadata.protocolVersion, props.runtime])

  const applyOutcome = useCallback(async (outcome: TerminalCommandOutcome): Promise<void> => {
    switch (outcome.kind) {
      case 'message':
        setTranscript(state => appendSystemMessage(state, outcome.text, outcome.title ?? 'dshc', nextId('message')))
        return
      case 'view':
        setActiveView(outcome.viewId)
        return
      case 'new-session': {
        const previous = sessionId
        const next = createSessionId()
        setSessionId(next)
        setGeneration(value => value + 1)
        setSessionTurns(0)
        setTranscript(state => appendSystemMessage(
          state,
          `new ${next}\nprevious ${previous} remains runtime-owned until exit; protocol ${props.metadata.protocolVersion} has no session-close request.`,
          'session',
          nextId('session'),
        ))
        return
      }
      case 'clear':
        setTranscript(initialTerminalTranscript())
        setActiveView(undefined)
        return
      case 'exit':
        setPhase('closing')
        finish(0, false)
        return
    }
  }, [finish, nextId, props.metadata.protocolVersion, sessionId])

  const runCommand = useCallback(async (raw: string): Promise<boolean> => {
    const parsed = parseTerminalCommand(raw)
    if (parsed === undefined) return false
    const command = props.host.resolveCommand(parsed.name)
    if (command === undefined) {
      setTranscript(state => appendSystemMessage(state, `unknown command /${parsed.name}; use /help`, 'command', nextId('command')))
      return true
    }
    const outcome = await command.execute(commandContext(), parsed.args)
    await applyOutcome(outcome)
    return true
  }, [applyOutcome, commandContext, nextId, props.host])

  const submit = useCallback(async (): Promise<void> => {
    if (runningRef.current) return
    const raw = input
    if (raw.trim().length === 0) return
    setInput('')
    setCursor(0)
    setHistoryIndex(undefined)

    if (raw.startsWith('/') && !raw.startsWith('//')) {
      await runCommand(raw)
      return
    }

    const prompt = raw.startsWith('//') ? raw.slice(1) : raw
    const activityId = nextId('activity')
    setHistory(items => [...items.slice(-99), prompt])
    setTranscript(state => appendUserPrompt(state, sessionId, prompt, nextId('user')))
    setPhase('running')
    runningRef.current = true

    try {
      const result = await props.runtime.run(prompt, {
        sessionId,
        onEvent: event => {
          setEvents(items => [...items, event])
          setTranscript(state => reduceTerminalEvent(state, event, props.host, activityId, props.debug))
        },
      })
      setSessionTurns(value => value + 1)
      setTotalTurns(value => value + 1)
      setPhase(result.projection.lastTurnError === undefined ? 'idle' : 'failed')
      if (result.projection.lastTurnError !== undefined) {
        setTranscript(state => appendSystemMessage(
          state,
          'The Harness turn ended with an observable error. The runtime reported idle and remains owned by this terminal process.',
          'turn',
          nextId('turn-error'),
        ))
      }
    } catch (error) {
      if (interruptingRef.current) return
      const failure = classifyRuntimeError(error)
      setPhase('failed')
      setTranscript(state => appendSystemMessage(state, failure.message, `runtime error · ${failure.code}`, nextId('runtime-error')))
      await props.runtime.close().catch(() => undefined)
      finish(1, false)
    } finally {
      runningRef.current = false
    }
  }, [finish, input, nextId, props.debug, props.host, props.runtime, runCommand, sessionId])

  useInput((keyInput, key) => {
    if (key.ctrl && keyInput.toLowerCase() === 'c') {
      interrupt()
      return
    }
    if (activeView !== undefined) {
      if (key.escape || key.return || keyInput === 'q') setActiveView(undefined)
      return
    }
    if (runningRef.current) return

    if (key.return) {
      void submit()
      return
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return
      setInput(value => value.slice(0, cursor - 1) + value.slice(cursor))
      setCursor(value => Math.max(0, value - 1))
      return
    }
    if (key.leftArrow) {
      setCursor(value => Math.max(0, value - 1))
      return
    }
    if (key.rightArrow) {
      setCursor(value => Math.min(input.length, value + 1))
      return
    }
    if (key.upArrow && history.length > 0) {
      const next = historyIndex === undefined ? history.length - 1 : Math.max(0, historyIndex - 1)
      const value = history[next] ?? ''
      setHistoryIndex(next)
      setInput(value)
      setCursor(value.length)
      return
    }
    if (key.downArrow && historyIndex !== undefined) {
      const next = historyIndex + 1
      if (next >= history.length) {
        setHistoryIndex(undefined)
        setInput('')
        setCursor(0)
      } else {
        const value = history[next] ?? ''
        setHistoryIndex(next)
        setInput(value)
        setCursor(value.length)
      }
      return
    }
    if ((key.ctrl && keyInput.toLowerCase() === 'j') || (key.meta && key.return)) {
      insertInput('\n')
      return
    }
    if (key.ctrl || key.meta || key.tab || key.escape || keyInput.length === 0) return
    insertInput(keyInput)
  })

  function insertInput(text: string): void {
    setInput(value => value.slice(0, cursor) + text + value.slice(cursor))
    setCursor(value => value + text.length)
  }

  const status = useMemo(() => {
    const context = commandContext()
    return props.host.orderedStatusSegments()
      .map(segment => segment.render(context))
      .filter((value): value is string => value !== undefined && value.length > 0)
      .map(sanitizeTerminalText)
      .join(' · ')
  }, [commandContext, props.host])

  const currentView = activeView === undefined ? undefined : props.host.resolveView(activeView)
  const bodyRows = Math.max(4, size.rows - 7)
  const visibleBlocks = currentView === undefined ? takeVisibleBlocks(transcript.blocks, bodyRows) : []

  return (
    <Box flexDirection="column" width={Math.max(20, size.columns)} height={Math.max(10, size.rows)}>
      <Box justifyContent="space-between">
        <Text bold>DeepSeek Harness Console</Text>
        <Text dimColor>M3 · {DSHC_VERSION}</Text>
      </Box>
      <Text dimColor>{sanitizeTerminalText(props.metadata.serverName)}/{sanitizeTerminalText(props.metadata.protocolVersion)}</Text>

      <Box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
        {currentView === undefined
          ? visibleBlocks.map(block => <TranscriptBlockView key={block.id} block={block} width={size.columns} />)
          : <ViewPanel title={currentView.title} text={currentView.render(viewContext())} />}
      </Box>

      <Box borderStyle="single" borderLeft={false} borderRight={false} paddingX={1}>
        <Text>{crop(status, Math.max(10, size.columns - 4))}</Text>
      </Box>

      <Box flexDirection="column" paddingX={1}>
        {currentView !== undefined
          ? <Text dimColor>Esc / Enter / q · return to transcript</Text>
          : <>
              <Text dimColor>{phase === 'running' ? 'Harness is running… Ctrl+C closes the whole runtime' : 'Enter submit · ↑/↓ history · Ctrl+J newline · /help'}</Text>
              <Text>{renderEditor(input, cursor, phase === 'running')}</Text>
            </>}
      </Box>
    </Box>
  )
}

export interface ParsedTerminalCommand {
  name: string
  args: readonly string[]
}

export function parseTerminalCommand(raw: string): ParsedTerminalCommand | undefined {
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined
  const tokens = raw.trim().slice(1).split(/\s+/).filter(Boolean)
  const name = (tokens.shift() ?? '').toLowerCase()
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return { name, args: tokens }
  return { name, args: tokens }
}

function TranscriptBlockView({ block, width }: { block: TranscriptBlock; width: number }): React.ReactElement {
  const marker = block.kind === 'user' ? '›' : block.kind === 'assistant' ? '◆' : block.kind === 'tool' ? '⚙' : block.kind === 'agent' ? '◇' : block.kind === 'error' ? '!' : '·'
  const state = block.state === undefined ? '' : ` · ${block.state}`
  const title = sanitizeTerminalText(block.title ?? block.kind)
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold={block.kind === 'user' || block.kind === 'assistant'}>{marker} {title}{state}</Text>
      {block.text.length > 0 && <Text wrap="wrap">{foldTerminalText(block.text, block.foldable === true, width)}</Text>}
      {block.detail !== undefined && block.detail.length > 0 && <Text dimColor wrap="wrap">{foldTerminalText(block.detail, true, width)}</Text>}
    </Box>
  )
}

function ViewPanel({ title, text }: { title: string; text: string }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{sanitizeTerminalText(title)}</Text>
      <Text wrap="wrap">{sanitizeTerminalText(text)}</Text>
    </Box>
  )
}

export function takeVisibleBlocks(blocks: readonly TranscriptBlock[], rows: number): readonly TranscriptBlock[] {
  const result: TranscriptBlock[] = []
  let budget = rows
  for (let index = blocks.length - 1; index >= 0 && budget > 0; index--) {
    const block = blocks[index]!
    result.unshift(block)
    budget -= estimateRows(block)
  }
  return result
}

function estimateRows(block: TranscriptBlock): number {
  const content = Math.min(DEFAULT_FOLD_LIMIT, block.text.length + (block.detail?.length ?? 0))
  return 2 + Math.max(1, Math.ceil(content / 72))
}

export function foldTerminalText(
  text: string,
  foldable: boolean,
  width: number,
  limit = DEFAULT_FOLD_LIMIT,
): string {
  const safe = sanitizeTerminalText(text)
  if (!foldable || safe.length <= limit) return safe
  const head = Math.max(240, Math.min(limit - 160, Math.max(20, width) * 8))
  const tail = Math.min(120, Math.max(40, Math.floor(limit / 5)))
  const hidden = Math.max(0, safe.length - head - tail)
  return `${safe.slice(0, head)}\n… ${hidden} characters folded; content retained in this terminal process …\n${safe.slice(-tail)}`
}

function renderEditor(value: string, cursor: number, disabled: boolean): string {
  if (disabled) return '…'
  const before = sanitizeTerminalText(value.slice(0, cursor))
  const current = value[cursor] === undefined ? ' ' : sanitizeTerminalText(value[cursor]!)
  const after = sanitizeTerminalText(value.slice(cursor + (value[cursor] === undefined ? 0 : 1)))
  return `❯ ${before}▌${current}${after}`
}

function crop(value: string, width: number): string {
  if (value.length <= width) return value
  if (width <= 3) return value.slice(0, width)
  return `${value.slice(0, width - 1)}…`
}
