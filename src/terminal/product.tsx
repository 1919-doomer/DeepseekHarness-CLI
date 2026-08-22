import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import { createSessionId } from '../session/interactive-state.js'
import { classifyRuntimeError } from '../upstream/errors.js'
import { HarnessRuntime, type HarnessRuntimeMetadata } from '../upstream/runtime.js'
import { DSHC_VERSION } from '../version.js'
import type {
  TerminalCommandContext,
  TerminalCommandOutcome,
  TerminalRuntimePhase,
  TerminalStatusSegmentSpec,
  TerminalViewContext,
  TerminalViewSpec,
  TranscriptBlock,
} from '../plugins/api.js'
import { createDefaultTerminalHost } from '../plugins/builtins.js'
import type { TerminalPluginHost } from '../plugins/host.js'
import {
  appendTerminalEventHistory,
  initialAgentTopologyHistory,
  initialTerminalEventHistory,
  reduceAgentTopologyHistory,
  type AgentTopologyHistory,
  type TerminalEventHistory,
} from './history.js'
import {
  appendSystemMessage,
  appendUserPrompt,
  initialTerminalTranscript,
  reduceTerminalEvent,
  type TerminalTranscriptState,
} from './transcript.js'
import { sanitizeTerminalText } from './sanitize.js'
import {
  formatActivityCounts,
  formatActivityRow,
  projectToolActivity,
  type ToolActivityProjection,
  type ToolActivityState,
} from './tool-activity.js'
import {
  cropTerminalText,
  deleteGraphemeBefore,
  graphemeAt,
  graphemeCount,
  insertAtGrapheme,
  prefixByCells,
  sliceByGrapheme,
  suffixByCells,
  terminalCellWidth,
  wrappedTerminalRows,
} from './text-metrics.js'

const ALT_SCREEN_ON = '\u001B[?1049h'
const ALT_SCREEN_OFF = '\u001B[?1049l'
export const DEFAULT_FOLD_LIMIT = 1_200

export interface TerminalProductOptions {
  debug?: boolean
  initialSessionId?: string
  host?: TerminalPluginHost
  useAlternateScreen?: boolean
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  stderr?: NodeJS.WriteStream
  interactive?: boolean
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
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
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
      stdout.write(ALT_SCREEN_ON)
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
      {
        stdin,
        stdout,
        stderr,
        interactive: options.interactive,
        exitOnCtrlC: false,
        patchConsole: false,
      },
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
    if (alternateEntered) stdout.write(ALT_SCREEN_OFF)
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
  const [eventHistory, setEventHistory] = useState<TerminalEventHistory>(initialTerminalEventHistory)
  const [agentTopology, setAgentTopology] = useState<AgentTopologyHistory>(initialAgentTopologyHistory)
  const [input, setInput] = useState('')
  // `cursor` is a logical grapheme index, never a UTF-16 code-unit offset.
  const [cursor, setCursor] = useState(0)
  const [activeView, setActiveView] = useState<string | undefined>()
  const [showTools, setShowTools] = useState(true)
  const [history, setHistory] = useState<readonly string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | undefined>()
  const [commandBusy, setCommandBusy] = useState(false)
  // `activeView` state only lands on the next render, but one stdin chunk can
  // carry several keystrokes that must observe each other's effect in order.
  const activeViewRef = useRef<string | undefined>(undefined)
  const selectView = useCallback((next: string | undefined): void => {
    activeViewRef.current = next
    setActiveView(next)
  }, [])
  const runningRef = useRef(false)
  const commandRunningRef = useRef(false)
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
    events: eventHistory.items,
    retention: {
      totalEventCount: eventHistory.total,
      droppedEventCount: eventHistory.dropped,
      droppedTranscriptBlockCount: transcript.droppedBlockCount,
      droppedTopologyEntryCount: agentTopology.dropped,
    },
    agentTopology: [...agentTopology.entries.values()],
  }), [agentTopology, commandContext, eventHistory, props.host, transcript.droppedBlockCount])

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
      case 'toggle-tools':
        setShowTools(value => !value)
        return
      case 'view':
        if (props.host.resolveView(outcome.viewId) === undefined) {
          setTranscript(state => appendSystemMessage(
            state,
            `terminal command requested unknown view: ${outcome.viewId}`,
            'terminal plugin error',
            nextId('view-error'),
          ))
          return
        }
        selectView(outcome.viewId)
        return
      case 'new-session': {
        const previous = sessionId
        const next = createSessionId()
        setSessionId(next)
        setGeneration(value => value + 1)
        setSessionTurns(0)
        setAgentTopology(initialAgentTopologyHistory())
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
        selectView(undefined)
        return
      case 'exit':
        setPhase('closing')
        finish(0, false)
        return
    }
  }, [finish, nextId, props.host, props.metadata.protocolVersion, sessionId])

  const runCommand = useCallback(async (raw: string): Promise<boolean> => {
    const parsed = parseTerminalCommand(raw)
    if (parsed === undefined) return false
    const command = props.host.resolveCommand(parsed.name)
    if (command === undefined) {
      setTranscript(state => appendSystemMessage(
        state,
        `unknown or invalid command /${parsed.name}; use /help`,
        'command',
        nextId('command'),
      ))
      return true
    }

    commandRunningRef.current = true
    setCommandBusy(true)
    try {
      const outcome = await command.execute(commandContext(), parsed.args)
      await applyOutcome(outcome)
    } catch (error) {
      setTranscript(state => appendSystemMessage(
        state,
        pluginErrorMessage(error),
        `command error · /${parsed.name}`,
        nextId('command-error'),
      ))
    } finally {
      commandRunningRef.current = false
      setCommandBusy(false)
    }
    return true
  }, [applyOutcome, commandContext, nextId, props.host])

  const submit = useCallback(async (): Promise<void> => {
    if (runningRef.current || commandRunningRef.current) return
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
    const rootSessionId = sessionId
    setHistory(items => [...items.slice(-99), prompt])
    setTranscript(state => appendUserPrompt(state, rootSessionId, prompt, nextId('user')))
    setPhase('running')
    runningRef.current = true

    try {
      const result = await props.runtime.run(prompt, {
        sessionId: rootSessionId,
        onEvent: event => {
          // Complete normalized events feed presentation first. Only the local
          // diagnostic copy is compacted/evicted afterward.
          setTranscript(state => reduceTerminalEvent(
            state,
            event,
            props.host,
            activityId,
            rootSessionId,
            props.debug,
          ))
          setEventHistory(state => appendTerminalEventHistory(state, event))
          setAgentTopology(state => reduceAgentTopologyHistory(state, event))
        },
      })
      setSessionTurns(value => value + 1)
      setTotalTurns(value => value + 1)
      setPhase(result.projection.lastTurnError === undefined ? 'idle' : 'failed')
      if (result.projection.lastTurnError !== undefined) {
        setTranscript(state => appendSystemMessage(
          state,
          'The Harness turn ended with an observable root-session error. The runtime reported idle and remains owned by this terminal process.',
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
    // Ink reports one parsed key per stdin chunk, but a chunk can carry several
    // keystrokes: fast typing coalesces them and pasted text arrives whole. A
    // chunk pairing a submit character with the next keystroke would otherwise
    // fail every `key.*` test and be inserted verbatim, losing the submit and
    // leaving a raw control character in the prompt.
    for (const stroke of splitKeystrokes(keyInput, key)) handleKeystroke(stroke.text, stroke.key)
  })

  function handleKeystroke(keyInput: string, key: InputKey): void {
    if (key.ctrl && keyInput.toLowerCase() === 'c') {
      interrupt()
      return
    }
    if (activeViewRef.current !== undefined) {
      if (key.escape || key.return || keyInput === 'q') selectView(undefined)
      return
    }
    if (runningRef.current || commandRunningRef.current) return

    if (key.return) {
      void submit()
      return
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return
      const edited = deleteGraphemeBefore(input, cursor)
      setInput(edited.value)
      setCursor(edited.cursor)
      return
    }
    if (key.leftArrow) {
      setCursor(value => Math.max(0, value - 1))
      return
    }
    if (key.rightArrow) {
      setCursor(value => Math.min(graphemeCount(input), value + 1))
      return
    }
    if (key.upArrow && history.length > 0) {
      const next = historyIndex === undefined ? history.length - 1 : Math.max(0, historyIndex - 1)
      const value = history[next] ?? ''
      setHistoryIndex(next)
      setInput(value)
      setCursor(graphemeCount(value))
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
        setCursor(graphemeCount(value))
      }
      return
    }
    if ((key.ctrl && keyInput.toLowerCase() === 'j') || (key.meta && key.return)) {
      insertInput('\n')
      return
    }
    if (key.ctrl || key.meta || key.tab || key.escape || keyInput.length === 0) return
    insertInput(keyInput)
  }

  function insertInput(text: string): void {
    const edited = insertAtGrapheme(input, cursor, text)
    setInput(edited.value)
    setCursor(edited.cursor)
  }

  const status = useMemo(() => {
    const context = commandContext()
    return props.host.orderedStatusSegments()
      .map(segment => renderStatusSegmentSafely(segment, context))
      .filter((value): value is string => value !== undefined && value.length > 0)
      .map(sanitizeTerminalText)
      .join(' · ')
  }, [commandContext, props.host])

  const currentView = activeView === undefined ? undefined : props.host.resolveView(activeView)
  const currentViewText = currentView === undefined ? undefined : renderViewSafely(currentView, viewContext())
  const bodyRows = Math.max(4, size.rows - 7)
  // A sidebar takes a fixed column count, never a share of the width, so the
  // transcript rewraps predictably. Below the threshold it collapses rather
  // than squeezing the transcript, per the narrow-terminal invariant.
  const sidebarVisible = showTools && size.columns >= TOOL_SIDEBAR_MIN_COLUMNS && currentView === undefined
  const transcriptWidth = Math.max(20, size.columns - (sidebarVisible ? TOOL_SIDEBAR_WIDTH : 0))
  const visibleBlocks = currentView === undefined
    ? takeVisibleBlocks(transcript.blocks, bodyRows, transcriptWidth)
    : []
  const activity = sidebarVisible
    ? projectToolActivity(eventHistory.items, sessionId)
    : undefined

  return (
    <Box flexDirection="column" width={Math.max(20, size.columns)} height={Math.max(10, size.rows)}>
      <Box justifyContent="space-between">
        <Text bold>DeepSeek Harness Console</Text>
        <Text dimColor>{DSHC_VERSION}</Text>
      </Box>
      <Text dimColor>{sanitizeTerminalText(props.metadata.serverName)}/{sanitizeTerminalText(props.metadata.protocolVersion)}</Text>

      <Box flexDirection="row" flexGrow={1} overflow="hidden" marginTop={1}>
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {currentView === undefined
            ? visibleBlocks.map(block => <TranscriptBlockView key={block.id} block={block} width={transcriptWidth} />)
            : <ViewPanel title={currentView.title} text={currentViewText ?? ''} />}
        </Box>
        {activity !== undefined && (
          <ToolActivitySidebar
            activity={activity}
            rows={bodyRows}
            droppedEvents={eventHistory.dropped}
          />
        )}
      </Box>

      <Box borderStyle="single" borderLeft={false} borderRight={false} paddingX={1}>
        <Text>{cropTerminalText(status, Math.max(10, size.columns - 4))}</Text>
      </Box>

      <Box flexDirection="column" paddingX={1}>
        {currentView !== undefined
          ? <Text dimColor>Esc / Enter / q · return to transcript</Text>
          : <>
              <Text dimColor>{phase === 'running'
                ? 'Harness is running… Ctrl+C closes the whole runtime'
                : commandBusy ? 'Local terminal command is running…'
                  : 'Enter submit · ↑/↓ history · Ctrl+J newline · /help'}</Text>
              <Text>{renderEditor(input, cursor, phase === 'running' || commandBusy)}</Text>
            </>}
      </Box>
    </Box>
  )
}

export interface ParsedTerminalCommand {
  name: string
  args: readonly string[]
}

/** The subset of Ink's parsed key flags this product reacts to. */
export interface InputKey {
  ctrl: boolean
  meta: boolean
  escape: boolean
  tab: boolean
  return: boolean
  backspace: boolean
  delete: boolean
  leftArrow: boolean
  rightArrow: boolean
  upArrow: boolean
  downArrow: boolean
}

export interface Keystroke {
  text: string
  key: InputKey
}

const PLAIN_KEY: InputKey = Object.freeze({
  ctrl: false,
  meta: false,
  escape: false,
  tab: false,
  return: false,
  backspace: false,
  delete: false,
  leftArrow: false,
  rightArrow: false,
  upArrow: false,
  downArrow: false,
})

const RETURN_KEY: InputKey = Object.freeze({ ...PLAIN_KEY, return: true })

/**
 * Split one stdin chunk into the keystrokes it actually represents.
 *
 * Ink parses a chunk into a single `key`, which is correct for an escape
 * sequence (arrows, Ctrl+J, Escape) but wrong when several plain keystrokes
 * coalesce or when the user pastes text. A coalesced chunk carrying a submit
 * character would otherwise fail every `key.*` test and be inserted verbatim,
 * losing the submit and leaving a raw control character in the prompt.
 *
 * Only plain chunks are split, so parsed control sequences keep their existing
 * single-stroke behavior and Ctrl+J still inserts a literal newline rather than
 * submitting. A chunk with no submit character is returned untouched.
 */
export function splitKeystrokes(keyInput: string, key: InputKey): readonly Keystroke[] {
  const parsedSequence = key.ctrl || key.meta || key.escape || key.tab
    || key.backspace || key.delete
    || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow
  if (parsedSequence) return [{ text: keyInput, key }]
  if (!keyInput.includes('\r') && !keyInput.includes('\n')) {
    return [{ text: keyInput, key }]
  }

  const strokes: Keystroke[] = []
  let pending = ''
  for (const char of keyInput) {
    if (char === '\r' || char === '\n') {
      if (pending.length > 0) {
        strokes.push({ text: pending, key: PLAIN_KEY })
        pending = ''
      }
      strokes.push({ text: char, key: RETURN_KEY })
      continue
    }
    pending += char
  }
  if (pending.length > 0) strokes.push({ text: pending, key: PLAIN_KEY })
  return strokes
}

/** Fixed sidebar width; never a share of the terminal. */
export const TOOL_SIDEBAR_WIDTH = 30

/**
 * Below this the sidebar collapses instead of squeezing the transcript, so a
 * narrow terminal keeps the newest useful activity and an intact input area.
 */
export const TOOL_SIDEBAR_MIN_COLUMNS = 100

function ToolActivitySidebar({ activity, rows, droppedEvents }: {
  activity: ToolActivityProjection
  rows: number
  droppedEvents: number
}): React.ReactElement {
  const inner = TOOL_SIDEBAR_WIDTH - 3
  // Reserve the counter line, and the eviction note when there is one.
  const notes = droppedEvents > 0 ? 2 : 1
  const visible = activity.rows.slice(-Math.max(1, rows - notes))
  return (
    <Box flexDirection="column" flexShrink={0} width={TOOL_SIDEBAR_WIDTH} borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} paddingX={1} overflow="hidden">
      {visible.map(row => (
        <Box key={row.key} flexShrink={0}>
          <Text color={activityColor(row.state)} wrap="truncate">{formatActivityRow(row, inner)}</Text>
        </Box>
      ))}
      <Box flexGrow={1} />
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate">{cropTerminalText(formatActivityCounts(activity.counts), inner)}</Text>
      </Box>
      {droppedEvents > 0 && (
        <Box flexShrink={0}>
          <Text dimColor wrap="truncate">{cropTerminalText(`${droppedEvents} older evicted`, inner)}</Text>
        </Box>
      )}
    </Box>
  )
}

function activityColor(state: ToolActivityState): string | undefined {
  switch (state) {
    case 'running': return 'cyan'
    case 'success': return 'green'
    case 'error': return 'red'
  }
}

export function parseTerminalCommand(raw: string): ParsedTerminalCommand | undefined {
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined
  const tokens = raw.trim().slice(1).split(/\s+/).filter(Boolean)
  const name = (tokens.shift() ?? '').toLowerCase()
  return { name, args: tokens }
}

function TranscriptBlockView({ block, width }: { block: TranscriptBlock; width: number }): React.ReactElement {
  const status = blockStatus(block)
  const header = blockHeaderText(block)
  return (
    <Box flexDirection="column" flexShrink={0} marginBottom={1}>
      {/* One Text node, one row. Nesting Text inside Text made Ink lay the
          header and the body on the same row, so the colour applies to the
          whole header line instead. */}
      <Text bold={block.kind === 'user' || block.kind === 'assistant'} color={status.color}>{header}</Text>
      {block.text.length > 0 && <Text wrap="wrap">{foldTerminalText(block.text, block.foldable === true, width)}</Text>}
      {block.detail !== undefined && block.detail.length > 0 && <Text dimColor wrap="wrap">{foldTerminalText(block.detail, true, width)}</Text>}
    </Box>
  )
}

/**
 * Outcome is carried by a glyph *and* a word, never by colour alone: the
 * transcript has to stay correct on a monochrome terminal and for a reader who
 * cannot distinguish the colours.
 */
function blockStatus(block: TranscriptBlock): { marker: string; color?: string } {
  switch (block.state) {
    case 'running': return { marker: '▸', color: 'cyan' }
    case 'success': return { marker: '✓', color: 'green' }
    case 'error': return { marker: '✗', color: 'red' }
    case 'finished': return { marker: '•' }
    default: break
  }
  if (block.kind === 'error') return { marker: '!', color: 'red' }
  return { marker: kindMarker(block.kind) }
}

function kindMarker(kind: TranscriptBlock['kind']): string {
  switch (kind) {
    case 'user': return '›'
    case 'assistant': return '◆'
    case 'tool': return '⚙'
    case 'agent': return '◇'
    case 'error': return '!'
    default: return '·'
  }
}

function blockStatusSuffix(block: TranscriptBlock): string {
  const state = block.state === undefined ? '' : ` · ${block.state}`
  const elapsed = blockElapsedMs(block)
  return elapsed === undefined ? state : `${state} · ${formatElapsedMs(elapsed)}`
}

/**
 * Span between the two upstream timestamps bounding the block. Absent when
 * either end is missing or the pair runs backwards, so an unknown span is never
 * rendered as zero.
 */
export function blockElapsedMs(block: TranscriptBlock): number | undefined {
  const { startedAt, endedAt } = block
  if (startedAt === undefined || endedAt === undefined) return undefined
  const elapsed = endedAt - startedAt
  return elapsed >= 0 ? elapsed : undefined
}

export function formatElapsedMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function ViewPanel({ title, text }: { title: string; text: string }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>{sanitizeTerminalText(title)}</Text>
      <Text wrap="wrap">{sanitizeTerminalText(text)}</Text>
    </Box>
  )
}

export function takeVisibleBlocks(
  blocks: readonly TranscriptBlock[],
  rows: number,
  width = 72,
): readonly TranscriptBlock[] {
  const result: TranscriptBlock[] = []
  let budget = rows
  for (let index = blocks.length - 1; index >= 0 && budget > 0; index--) {
    const block = blocks[index]!
    const needed = estimateRows(block, width)
    // Admitting a block before checking that it fits lets the selection
    // overshoot the frame by almost a whole block. Ink then compresses the
    // children instead of clipping them, and body text lands on top of the
    // header row. The newest block is still always shown, because an oversized
    // latest activity must not vanish.
    if (result.length > 0 && needed > budget) break
    result.unshift(block)
    budget -= needed
  }
  return result
}

function estimateRows(block: TranscriptBlock, width: number): number {
  const contentWidth = Math.max(10, width - 2)
  const text = foldTerminalText(block.text, block.foldable === true, contentWidth)
  const detail = block.detail === undefined ? '' : foldTerminalText(block.detail, true, contentWidth)
  const textRows = block.text.length === 0 ? 0 : wrappedTerminalRows(text, contentWidth)
  const detailRows = detail.length === 0 ? 0 : wrappedTerminalRows(detail, contentWidth)
  // The header wraps like any other line; budgeting it as exactly one row
  // under-counts a long title and overflows the frame.
  const headerRows = wrappedTerminalRows(blockHeaderText(block), contentWidth)
  return headerRows + 1 + Math.max(1, textRows + detailRows)
}

/** The rendered header line, shared by the view and the row estimate. */
export function blockHeaderText(block: TranscriptBlock): string {
  const status = blockStatus(block)
  return `${status.marker} ${sanitizeTerminalText(block.title ?? block.kind)}${blockStatusSuffix(block)}`
}

export function foldTerminalText(
  text: string,
  foldable: boolean,
  width: number,
  limit = DEFAULT_FOLD_LIMIT,
): string {
  const safe = sanitizeTerminalText(text)
  const displayUnits = Math.max(terminalCellWidth(safe), graphemeCount(safe))
  if (!foldable || displayUnits <= limit) return safe
  const head = Math.max(240, Math.min(limit - 160, Math.max(20, width) * 8))
  const tail = Math.min(120, Math.max(40, Math.floor(limit / 5)))
  const headText = prefixByCells(safe, head)
  const tailText = suffixByCells(safe, tail)
  const hidden = Math.max(0, graphemeCount(safe) - graphemeCount(headText) - graphemeCount(tailText))
  return `${headText}\n… ${hidden} characters folded; content retained in this terminal process …\n${tailText}`
}

function renderEditor(value: string, cursor: number, disabled: boolean): string {
  if (disabled) return '…'
  const before = sanitizeTerminalText(sliceByGrapheme(value, 0, cursor))
  const currentGrapheme = graphemeAt(value, cursor)
  const current = currentGrapheme === undefined ? ' ' : sanitizeTerminalText(currentGrapheme)
  const after = sanitizeTerminalText(sliceByGrapheme(value, cursor + (currentGrapheme === undefined ? 0 : 1)))
  return `❯ ${before}▌${current}${after}`
}

function renderViewSafely(view: TerminalViewSpec, context: TerminalViewContext): string {
  try {
    return view.render(context)
  } catch (error) {
    return `Terminal view ${view.id} failed locally: ${pluginErrorMessage(error)}`
  }
}

function renderStatusSegmentSafely(
  segment: TerminalStatusSegmentSpec,
  context: TerminalCommandContext,
): string | undefined {
  try {
    return segment.render(context)
  } catch {
    return `status:${segment.id}:error`
  }
}

function pluginErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
