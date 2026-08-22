import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import { createSessionId } from '../session/interactive-state.js'
import { classifyRuntimeError } from '../upstream/errors.js'
import { HarnessRuntime, type HarnessRuntimeMetadata } from '../upstream/runtime.js'
import type { CompositionForkResult, CompositionSummary } from '../upstream/composition.js'
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

/** The initialize parameters a restart may change, plus the composition file. */
export interface RuntimeSelection {
  provider?: string
  model?: string
  maxTokens?: number
  /** Composition file to launch with; absent keeps the current one. */
  runtimeConfig?: string
}

export interface RuntimeRestart {
  runtime: HarnessRuntime
  metadata: HarnessRuntimeMetadata
}

export interface TerminalProductOptions {
  debug?: boolean
  /** Composition summary for `/config`; display only. */
  composition?: CompositionSummary
  /** Copies the composition into the workspace so it can be edited. */
  forkComposition?: (from: string) => Promise<CompositionForkResult>
  /**
   * Starts a fresh runtime with the given selection. Protocol 0.0.1 has no way
   * to reconfigure a live runtime, so every configuration change is a restart,
   * and a restart starts a new session.
   */
  restart?: (selection: RuntimeSelection) => Promise<RuntimeRestart>
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
  // Held mutably so a configuration restart can swap it without tearing the UI
  // down. The new runtime is started before the old one closes, so a rejected
  // composition leaves the session working rather than stranded.
  const runtimeRef = { current: runtime }
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
    void runtimeRef.current.close().catch(() => undefined)
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
        runtimeRef={runtimeRef}
        metadata={metadata}
        {...(options.restart === undefined ? {} : { restart: options.restart })}
        {...(options.composition === undefined ? {} : { composition: options.composition })}
        {...(options.forkComposition === undefined ? {} : { forkComposition: options.forkComposition })}
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
  /** Mutable so a configuration restart can swap the runtime under the UI. */
  runtimeRef: { current: HarnessRuntime }
  metadata: HarnessRuntimeMetadata
  restart?: (selection: RuntimeSelection) => Promise<RuntimeRestart>
  composition?: CompositionSummary
  forkComposition?: (from: string) => Promise<CompositionForkResult>
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
  const [metadata, setMetadata] = useState(props.metadata)
  const [showTools, setShowTools] = useState(true)
  // Scroll position in blocks from the newest, mirrored in a ref for the same
  // within-chunk ordering reason focus needs one.
  const [scrollBack, setScrollBack] = useState(0)
  const scrollBackRef = useRef(0)
  const transcriptDepthRef = useRef(0)

  const jumpToNewest = useCallback((): void => {
    scrollBackRef.current = 0
    setScrollBack(0)
  }, [])

  const scrollTranscript = useCallback((delta: number): void => {
    const next = Math.max(0, Math.min(transcriptDepthRef.current, scrollBackRef.current + delta))
    scrollBackRef.current = next
    setScrollBack(next)
  }, [])
  // Focus and selection are mirrored in refs because one stdin chunk can carry
  // several keystrokes that must observe each other's effect, not a value that
  // only lands on the next render.
  const [toolFocus, setToolFocus] = useState(false)
  const toolFocusRef = useRef(false)
  const [selectedToolKey, setSelectedToolKey] = useState<string | undefined>()
  const selectedToolKeyRef = useRef<string | undefined>(undefined)
  const activityRowKeysRef = useRef<readonly string[]>([])

  const focusTools = useCallback((next: boolean): void => {
    toolFocusRef.current = next
    setToolFocus(next)
  }, [])

  const selectTool = useCallback((key: string | undefined): void => {
    selectedToolKeyRef.current = key
    setSelectedToolKey(key)
  }, [])
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
    runtime: metadata,
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
    ...(props.composition === undefined ? {} : { composition: props.composition }),
    ...(selectedToolKeyRef.current === undefined ? {} : { selectedToolKey: selectedToolKeyRef.current }),
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
        `Ctrl+C closes the entire Harness runtime; protocol ${metadata.protocolVersion} has no prompt-level cancel.`,
        'interrupt',
        nextId('interrupt'),
      ))
    }
    setPhase('closing')
    void props.runtimeRef.current.close().finally(() => finish(130, true))
  }, [finish, nextId, metadata.protocolVersion, props.runtimeRef])

  const applyOutcome = useCallback(async (outcome: TerminalCommandOutcome): Promise<void> => {
    switch (outcome.kind) {
      case 'message':
        setTranscript(state => appendSystemMessage(state, outcome.text, outcome.title ?? 'dshc', nextId('message')))
        return
      case 'fork-composition': {
        const source = props.composition
        const fork = props.forkComposition
        if (source === undefined || fork === undefined) {
          setTranscript(state => appendSystemMessage(
            state,
            'No composition file is available to fork in this session.',
            'configuration',
            nextId('fork'),
          ))
          return
        }
        try {
          const result = await fork(source.path)
          setTranscript(state => appendSystemMessage(
            state,
            result.created
              ? [
                  `Copied the composition to ${result.path}.`,
                  '',
                  'Edit it, then run  /reload ' + result.path + ' --yes  to start a runtime',
                  'with it. dshc does not interpret the file; run dshc doctor afterwards to',
                  'see what Harness reports about the result.',
                ].join('\n')
              : [
                  `${result.path} already exists, so nothing was written.`,
                  '',
                  'Overwriting would discard edits with no way back. Move or delete it first',
                  'if you want a fresh copy.',
                ].join('\n'),
            'configuration',
            nextId('fork'),
          ))
        } catch (error) {
          const failure = classifyRuntimeError(error)
          setTranscript(state => appendSystemMessage(
            state,
            `Could not copy the composition: ${failure.message}`,
            `configuration error · ${failure.code}`,
            nextId('fork-error'),
          ))
        }
        return
      }
      case 'restart-runtime': {
        const restart = props.restart
        if (restart === undefined) {
          setTranscript(state => appendSystemMessage(
            state,
            'This session cannot restart its runtime: no restart was supplied to the terminal product.',
            'configuration',
            nextId('restart'),
          ))
          return
        }
        setTranscript(state => appendSystemMessage(
          state,
          `Restarting with ${outcome.summary}. The current session ends here.`,
          'configuration',
          nextId('restart'),
        ))
        try {
          // Start the replacement before closing the old one, so a rejected
          // composition leaves the session working instead of stranded.
          const next = await restart(outcome.selection)
          const previous = props.runtimeRef.current
          props.runtimeRef.current = next.runtime
          setMetadata(next.metadata)
          void previous.close().catch(() => undefined)
          const fresh = createSessionId()
          setSessionId(fresh)
          setGeneration(value => value + 1)
          setSessionTurns(0)
          setAgentTopology(initialAgentTopologyHistory())
          jumpToNewest()
          setTranscript(state => appendSystemMessage(
            state,
            `Runtime restarted with ${outcome.summary}. New session ${fresh}; run /config to see what it launched with.`,
            'configuration',
            nextId('restart'),
          ))
        } catch (error) {
          const failure = classifyRuntimeError(error)
          setTranscript(state => appendSystemMessage(
            state,
            `Restart failed, so the previous runtime is still serving this session: ${failure.message}`,
            `configuration error · ${failure.code}`,
            nextId('restart-error'),
          ))
        }
        return
      }
      case 'toggle-tools':
        setShowTools(value => {
          if (value) {
            focusTools(false)
            selectTool(undefined)
          }
          return !value
        })
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
          `new ${next}\nprevious ${previous} remains runtime-owned until exit; protocol ${metadata.protocolVersion} has no session-close request.`,
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
  }, [finish, nextId, props.host, metadata.protocolVersion, sessionId])

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
      const result = await props.runtimeRef.current.run(prompt, {
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
      await props.runtimeRef.current.close().catch(() => undefined)
      finish(1, false)
    } finally {
      runningRef.current = false
    }
  }, [finish, input, nextId, props.debug, props.host, props.runtimeRef, runCommand, sessionId])

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
    // Tab moves focus between the prompt and the sidebar. It is the only key
    // that changes focus, and the current focus is always stated on screen, so
    // the arrow keys never mean two things at once.
    if (key.tab) {
      if (!toolFocusRef.current && activityRowKeysRef.current.length === 0) return
      const next = !toolFocusRef.current
      focusTools(next)
      if (next && selectedToolKeyRef.current === undefined) {
        selectTool(activityRowKeysRef.current.at(-1))
      }
      return
    }

    if (toolFocusRef.current) {
      if (key.escape) {
        focusTools(false)
        return
      }
      if (key.upArrow || key.downArrow) {
        moveToolSelection(key.downArrow ? 1 : -1)
        return
      }
      if (key.return) {
        if (selectedToolKeyRef.current !== undefined) selectView('tool-detail')
        return
      }
      // Anything else is swallowed rather than leaking into the prompt.
      return
    }

    // Scrolling is available whatever has focus, because it is navigation
    // rather than editing, and it never changes what is submitted.
    if (key.pageUp || key.pageDown) {
      scrollTranscript(key.pageUp ? 1 : -1)
      return
    }

    if (runningRef.current || commandRunningRef.current) return

    if (key.return) {
      // Submitting returns to the newest activity: a reply arriving off-screen
      // while the transcript is scrolled back would look like nothing happened.
      jumpToNewest()
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

  function moveToolSelection(delta: number): void {
    const keys = activityRowKeysRef.current
    if (keys.length === 0) return
    const current = selectedToolKeyRef.current
    const index = current === undefined ? keys.length - 1 : keys.indexOf(current)
    const next = index < 0
      ? keys.length - 1
      : Math.min(keys.length - 1, Math.max(0, index + delta))
    selectTool(keys[next])
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
  const suggestions = currentView === undefined && !toolFocus
    ? commandSuggestions(input, props.host.listCommands())
    : []
  // The menu competes with the transcript for rows, so it takes only what is
  // left after the chrome and a usable body. On a short terminal it shows
  // fewer entries rather than being clipped by the frame.
  const menuCapacity = Math.max(0, Math.min(8, size.rows - 7 - MIN_BODY_ROWS))
  const menuShown = Math.min(suggestions.length, menuCapacity)
  const menuRows = menuShown === 0 ? 0 : menuShown + (suggestions.length > menuShown ? 1 : 0)
  const bodyRows = Math.max(MIN_BODY_ROWS, size.rows - 7 - menuRows)
  // A sidebar takes a fixed column count, never a share of the width, so the
  // transcript rewraps predictably. Below the threshold it collapses rather
  // than squeezing the transcript, per the narrow-terminal invariant.
  const sidebarVisible = showTools && size.columns >= TOOL_SIDEBAR_MIN_COLUMNS && currentView === undefined
  const transcriptWidth = Math.max(20, size.columns - (sidebarVisible ? TOOL_SIDEBAR_WIDTH : 0))
  const visible = currentView === undefined
    ? selectVisibleBlocks(transcript.blocks, bodyRows, transcriptWidth, scrollBack)
    : { blocks: [], below: 0, above: 0 }
  const visibleBlocks = visible.blocks
  transcriptDepthRef.current = Math.max(0, transcript.blocks.length - 1)
  const activity = sidebarVisible
    ? projectToolActivity(eventHistory.items, sessionId)
    : undefined
  activityRowKeysRef.current = activity?.rows.map(row => row.key) ?? []

  return (
    <Box flexDirection="column" width={Math.max(20, size.columns)} height={Math.max(10, size.rows)}>
      {/* The chrome is fixed height and must never be compressed: when Yoga
          shrinks a column it lays children on top of each other, which is how
          the prompt used to overwrite its own hint. Only the body row absorbs
          the constraint. */}
      <Box flexShrink={0} justifyContent="space-between">
        <Text bold>DeepSeek Harness Console</Text>
        <Text dimColor>{DSHC_VERSION}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text dimColor>{sanitizeTerminalText(metadata.serverName)}/{sanitizeTerminalText(metadata.protocolVersion)}</Text>
      </Box>

      <Box flexDirection="row" flexGrow={1} overflow="hidden" marginTop={1}>
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {currentView === undefined && (visible.above > 0 || visible.below > 0) && (
            <Box flexShrink={0}>
              <Text dimColor wrap="truncate">{scrollNotice(visible)}</Text>
            </Box>
          )}
          {currentView === undefined
            ? visibleBlocks.map(block => (
                <TranscriptBlockView
                  key={block.id}
                  block={block}
                  width={transcriptWidth}
                  condensed={scrollBack > 0}
                />
              ))
            : <ViewPanel title={currentView.title} text={currentViewText ?? ''} />}
        </Box>
        {activity !== undefined && (
          <ToolActivitySidebar
            activity={activity}
            rows={bodyRows}
            droppedEvents={eventHistory.dropped}
            focused={toolFocus}
            selectedKey={selectedToolKey}
          />
        )}
      </Box>

      <Box flexShrink={0} borderStyle="single" borderLeft={false} borderRight={false} paddingX={1}>
        <Text>{cropTerminalText(status, Math.max(10, size.columns - 4))}</Text>
      </Box>

      {menuShown > 0 && (
        <CommandMenu suggestions={suggestions} shown={menuShown} width={size.columns} />
      )}

      <Box flexDirection="column" flexShrink={0} paddingX={1}>
        {currentView !== undefined
          ? <Text dimColor>Esc / Enter / q · return to transcript</Text>
          : <>
              <Text dimColor>{toolFocus
                ? 'tools focused · ↑/↓ select · Enter details · Tab or Esc back to prompt'
                : phase === 'running'
                  ? 'Harness is running… Ctrl+C closes the whole runtime'
                  : commandBusy ? 'Local terminal command is running…'
                    : 'Enter submit · ↑/↓ history · PgUp/PgDn scroll · Tab tools · /help'}</Text>
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
  pageUp?: boolean
  pageDown?: boolean
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
    || key.pageUp === true || key.pageDown === true
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
/** Rows the transcript keeps whatever else wants space. */
const MIN_BODY_ROWS = 4

export const TOOL_SIDEBAR_WIDTH = 30

/**
 * Below this the sidebar collapses instead of squeezing the transcript, so a
 * narrow terminal keeps the newest useful activity and an intact input area.
 */
export const TOOL_SIDEBAR_MIN_COLUMNS = 100

/**
 * States how much is out of sight in both directions. A scrolled-back view that
 * looked like the newest one would be worse than no scrolling at all.
 */
function scrollNotice(visible: VisibleTranscript): string {
  const parts: string[] = []
  if (visible.above > 0) parts.push(`${visible.above} older above`)
  if (visible.below > 0) parts.push(`${visible.below} newer below · PageDown to catch up`)
  else if (visible.above > 0) parts.push('PageUp for older')
  return parts.join(' · ')
}

export interface CommandSuggestion {
  name: string
  summary: string
}

/**
 * Commands matching what has been typed so far.
 *
 * Built from the plugin host's registry rather than a list kept alongside it,
 * so a command cannot exist without appearing here — the drift that made
 * `dshc --help` under-report the product for two milestones.
 *
 * Only a lone `/…` token qualifies: `//literal` is an escaped prompt, and once
 * an argument is typed the user is past choosing a command.
 */
export function commandSuggestions(
  input: string,
  commands: readonly { name: string; aliases: readonly string[]; summary: string }[],
): readonly CommandSuggestion[] {
  if (!input.startsWith('/') || input.startsWith('//')) return []
  if (/\s/.test(input)) return []
  const prefix = input.slice(1).toLowerCase()
  return commands
    .filter(command => command.name.startsWith(prefix))
    .map(command => ({ name: command.name, summary: command.summary }))
}

function CommandMenu({ suggestions, shown, width }: {
  suggestions: readonly CommandSuggestion[]
  shown: number
  width: number
}): React.ReactElement {
  const nameWidth = Math.max(...suggestions.map(item => item.name.length + 1))
  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1}>
      {suggestions.slice(0, shown).map(item => (
        <Box key={item.name} flexShrink={0}>
          <Text wrap="truncate">{cropTerminalText(
            `/${item.name.padEnd(nameWidth)} ${item.summary}`,
            Math.max(10, width - 2),
          )}</Text>
        </Box>
      ))}
      {suggestions.length > shown && (
        <Box flexShrink={0}>
          <Text dimColor>{`… ${suggestions.length - shown} more`}</Text>
        </Box>
      )}
    </Box>
  )
}

function ToolActivitySidebar({ activity, rows, droppedEvents, focused, selectedKey }: {
  activity: ToolActivityProjection
  rows: number
  droppedEvents: number
  focused: boolean
  selectedKey?: string
}): React.ReactElement {
  const inner = TOOL_SIDEBAR_WIDTH - 3
  // Reserve the header, the counter line, and the eviction note when present.
  const notes = droppedEvents > 0 ? 3 : 2
  const selectedIndex = selectedKey === undefined
    ? -1
    : activity.rows.findIndex(row => row.key === selectedKey)
  // Which entry is selected is stated in words, not carried by highlight alone.
  const heading = focused
    ? `tools · focus ${selectedIndex < 0 ? '-' : selectedIndex + 1}/${activity.rows.length}`
    : 'tools'
  const visible = activity.rows.slice(-Math.max(1, rows - notes))
  return (
    <Box flexDirection="column" flexShrink={0} width={TOOL_SIDEBAR_WIDTH} borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} paddingX={1} overflow="hidden">
      <Box flexShrink={0}>
        <Text bold={focused} color={focused ? 'cyan' : undefined} wrap="truncate">{cropTerminalText(heading, inner)}</Text>
      </Box>
      {visible.map(row => (
        <Box key={row.key} flexShrink={0}>
          <Text
            color={activityColor(row.state)}
            inverse={row.key === selectedKey}
            wrap="truncate"
          >{formatActivityRow(row, inner)}</Text>
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

function TranscriptBlockView({ block, width, condensed = false }: {
  block: TranscriptBlock
  width: number
  condensed?: boolean
}): React.ReactElement {
  const status = blockStatus(block)
  const header = blockHeaderText(block)
  // While reviewing older context, a tool call collapses to its header: the
  // outcome is what you are scanning for, and its arguments and output would
  // push the prose you are actually looking for off the screen.
  const collapsed = condensed && isActivityBlock(block)
  // Tool and subagent activity is framed so a call is a distinct object on the
  // screen rather than another paragraph. Prose keeps flowing unframed: boxing
  // an assistant answer would cost two columns and gain nothing.
  const framed = isActivityBlock(block) && !collapsed
  const bodyWidth = framed ? Math.max(10, width - 4) : width
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      marginBottom={1}
      {...(framed
        ? { borderStyle: 'round' as const, borderColor: status.color, paddingX: 1 }
        : {})}
    >
      {/* One Text node, one row. Nesting Text inside Text made Ink lay the
          header and the body on the same row, so the colour applies to the
          whole header line instead. */}
      <Text bold={block.kind === 'user' || block.kind === 'assistant'} color={status.color}>{header}</Text>
      {!collapsed && block.text.length > 0 && <Text wrap="wrap">{foldTerminalText(block.text, block.foldable === true, bodyWidth)}</Text>}
      {!collapsed && block.detail !== undefined && block.detail.length > 0 && <Text dimColor wrap="wrap">{foldTerminalText(block.detail, true, bodyWidth)}</Text>}
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

export interface VisibleTranscript {
  blocks: readonly TranscriptBlock[]
  /** Blocks below the viewport; zero means the newest activity is shown. */
  below: number
  /** Blocks above the viewport, so the view can say how much is out of sight. */
  above: number
}

/**
 * Choose the blocks that fit, ending `offset` blocks before the newest.
 *
 * `offset` is the scroll position, counted in blocks from the tail rather than
 * in rows, so a scroll step never lands halfway through a block and never
 * depends on the width the last render happened to use.
 */
export function selectVisibleBlocks(
  blocks: readonly TranscriptBlock[],
  rows: number,
  width = 72,
  offset = 0,
  condensed = offset > 0,
): VisibleTranscript {
  const below = Math.max(0, Math.min(offset, Math.max(0, blocks.length - 1)))
  const end = blocks.length - below
  const result: TranscriptBlock[] = []
  let budget = rows
  for (let index = end - 1; index >= 0 && budget > 0; index--) {
    const block = blocks[index]!
    const needed = estimateRows(block, width, condensed)
    // Admitting a block before checking that it fits lets the selection
    // overshoot the frame by almost a whole block. Ink then compresses the
    // children instead of clipping them, and body text lands on top of the
    // header row. The newest visible block is still always shown, because an
    // oversized latest activity must not vanish.
    if (result.length > 0 && needed > budget) break
    result.unshift(block)
    budget -= needed
  }
  return { blocks: result, below, above: Math.max(0, end - result.length) }
}

/** Back-compatible view of {@link selectVisibleBlocks} for the tail. */
export function takeVisibleBlocks(
  blocks: readonly TranscriptBlock[],
  rows: number,
  width = 72,
): readonly TranscriptBlock[] {
  return selectVisibleBlocks(blocks, rows, width).blocks
}

/** Tool and subagent activity, the blocks that collapse while reviewing. */
function isActivityBlock(block: TranscriptBlock): boolean {
  return block.kind === 'tool' || block.kind === 'agent'
}

function estimateRows(block: TranscriptBlock, width: number, condensed = false): number {
  const collapsed = condensed && isActivityBlock(block)
  // A framed block spends two rows on its border and two columns on padding.
  const framed = isActivityBlock(block) && !collapsed
  const frameRows = framed ? 2 : 0
  const contentWidth = Math.max(10, width - (framed ? 6 : 2))
  if (collapsed) return wrappedTerminalRows(blockHeaderText(block), contentWidth) + 1
  const text = foldTerminalText(block.text, block.foldable === true, contentWidth)
  const detail = block.detail === undefined ? '' : foldTerminalText(block.detail, true, contentWidth)
  const textRows = block.text.length === 0 ? 0 : wrappedTerminalRows(text, contentWidth)
  const detailRows = detail.length === 0 ? 0 : wrappedTerminalRows(detail, contentWidth)
  // The header wraps like any other line; budgeting it as exactly one row
  // under-counts a long title and overflows the frame.
  const headerRows = wrappedTerminalRows(blockHeaderText(block), contentWidth)
  return frameRows + headerRows + 1 + Math.max(1, textRows + detailRows)
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
