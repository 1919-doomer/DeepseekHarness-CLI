import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput, useStdout } from 'ink'
import { createSessionId } from '../session/interactive-state.js'
import { accumulateUsage, initialSessionUsage } from '../session/usage.js'
import { classifyRuntimeError } from '../upstream/errors.js'
import { HarnessRuntime, type HarnessRuntimeMetadata } from '../upstream/runtime.js'
import type { CompositionForkResult, CompositionSummary } from '../upstream/composition.js'
import type { PluginSearchResult, ResolvedPluginSpec } from '../upstream/plugin-management.js'
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
import type { HistoryWorkbench } from '../plugins/history.js'
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
import { RuntimeCloseTracker } from './runtime-ownership.js'
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
import {
  looksLikeMarkdown,
  parseMarkdown,
  spanText,
  tableColumnWidths,
  type MarkdownLine,
  type MarkdownSpan,
} from './markdown.js'

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
  composition?: CompositionSummary
}

export interface PluginInstallRestart extends RuntimeRestart {
  message: string
}

export interface TerminalProductOptions {
  debug?: boolean
  devMode?: boolean
  /** Trusted-mode warning inserted into the initial transcript and after /clear. */
  startupNotice?: string
  /** Composition summary for `/config`; display only. */
  composition?: CompositionSummary
  /** Creates the workspace patch layer without overwriting an existing one. */
  forkComposition?: (from: string, signal?: AbortSignal) => Promise<CompositionForkResult>
  /**
   * Starts a fresh runtime with the given selection. Protocol 0.0.1 has no way
   * to reconfigure a live runtime, so every configuration change is a restart,
   * and a restart starts a new session.
   */
  restart?: (selection: RuntimeSelection, signal?: AbortSignal) => Promise<RuntimeRestart>
  searchPlugins?: (query: string, signal?: AbortSignal) => Promise<readonly PluginSearchResult[]>
  resolvePlugin?: (spec: string, signal?: AbortSignal) => Promise<ResolvedPluginSpec>
  installPlugin?: (exactSpec: string, signal?: AbortSignal) => Promise<PluginInstallRestart>
  /** First-party read-only history controller; not part of terminal plugin API v1. */
  history?: HistoryWorkbench
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
  const runtimeClosures = new RuntimeCloseTracker<HarnessRuntime>()
  const host = options.host ?? createDefaultTerminalHost({
    devMode: options.devMode,
    history: options.history,
    env: process.env,
  })
  const initialSessionId = options.initialSessionId ?? createSessionId()
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const alternate = options.useAlternateScreen ?? true
  let alternateEntered = false
  let instance: ReturnType<typeof render> | undefined
  let latest = { totalTurns: 0, sessionId: initialSessionId }
  let signalClosing = false
  const shutdown = new AbortController()
  const localTasks = new Set<Promise<void>>()

  const trackLocalTask = (task: Promise<void>): void => {
    localTasks.add(task)
    void task.finally(() => { localTasks.delete(task) }).catch(() => undefined)
  }
  const drainLocalTasks = async (): Promise<void> => {
    while (localTasks.size > 0) await Promise.allSettled(localTasks)
  }

  let finishResolve!: (result: FinishResult) => void
  const finished = new Promise<FinishResult>(resolve => { finishResolve = resolve })
  let finishedOnce = false
  const finish = (result: FinishResult): void => {
    if (finishedOnce) return
    finishedOnce = true
    shutdown.abort(new Error('terminal product is closing'))
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
    void runtimeClosures.track(runtimeRef.current)
  }
  const onInt = (): void => closeForSignal(130)
  const onTerm = (): void => closeForSignal(143)
  // Ink does not turn a closed injected/stdin stream into an application
  // result by itself. Treat terminal EOF as the same clean whole-runtime exit
  // as `/exit`; the protocol has no smaller session or plugin disposal scope.
  const onEof = (): void => finish({
    exitCode: 0,
    interrupted: false,
    totalTurns: latest.totalTurns,
    sessionId: latest.sessionId,
  })

  try {
    if (alternate) {
      stdout.write(ALT_SCREEN_ON)
      alternateEntered = true
    }
    process.once('SIGINT', onInt)
    process.once('SIGTERM', onTerm)
    stdin.once('end', onEof)

    const current = render(
      <TerminalProductApp
        runtimeRef={runtimeRef}
        trackRuntimeClose={runtime => runtimeClosures.track(runtime)}
        shutdownSignal={shutdown.signal}
        requestShutdown={() => shutdown.abort(new Error('terminal product is closing'))}
        trackLocalTask={trackLocalTask}
        metadata={metadata}
        {...(options.restart === undefined ? {} : { restart: options.restart })}
        {...(options.composition === undefined ? {} : { composition: options.composition })}
        {...(options.forkComposition === undefined ? {} : { forkComposition: options.forkComposition })}
        {...(options.searchPlugins === undefined ? {} : { searchPlugins: options.searchPlugins })}
        {...(options.resolvePlugin === undefined ? {} : { resolvePlugin: options.resolvePlugin })}
        {...(options.installPlugin === undefined ? {} : { installPlugin: options.installPlugin })}
        {...(options.history === undefined ? {} : { history: options.history })}
        host={host}
        debug={options.debug ?? false}
        {...(options.startupNotice === undefined ? {} : { startupNotice: options.startupNotice })}
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
    instance = current
    // Register Ink's exit promise while the instance is definitely mounted.
    // Waiting until after the UI invokes exit() causes Ink to attach a new
    // beforeExit listener to an already-unmounted instance, where it can never
    // be removed.
    const exited = current.waitUntilExit().catch(() => undefined)

    const result = await finished
    await drainLocalTasks()
    instance = undefined
    current.unmount()
    await exited
    return result
  } finally {
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
    stdin.off('end', onEof)
    instance?.unmount()
    if (alternateEntered) stdout.write(ALT_SCREEN_OFF)
    shutdown.abort(new Error('terminal product is closing'))
    await drainLocalTasks()
    await runtimeClosures.drain(runtimeRef.current)
  }
}

interface AppProps {
  /** Mutable so a configuration restart can swap the runtime under the UI. */
  runtimeRef: { current: HarnessRuntime }
  /** Starts a close and retains its result until the product's final drain. */
  trackRuntimeClose(runtime: HarnessRuntime): Promise<void>
  /** Aborted before terminal teardown so local commands cannot commit after exit. */
  shutdownSignal: AbortSignal
  /** Abort local work as soon as an exit decision is made, before runtime close waits. */
  requestShutdown(): void
  /** Retains local command work until it has observed shutdown and released resources. */
  trackLocalTask(task: Promise<void>): void
  metadata: HarnessRuntimeMetadata
  restart?: (selection: RuntimeSelection, signal?: AbortSignal) => Promise<RuntimeRestart>
  composition?: CompositionSummary
  forkComposition?: (from: string, signal?: AbortSignal) => Promise<CompositionForkResult>
  searchPlugins?: (query: string, signal?: AbortSignal) => Promise<readonly PluginSearchResult[]>
  resolvePlugin?: (spec: string, signal?: AbortSignal) => Promise<ResolvedPluginSpec>
  installPlugin?: (exactSpec: string, signal?: AbortSignal) => Promise<PluginInstallRestart>
  history?: HistoryWorkbench
  host: TerminalPluginHost
  debug: boolean
  startupNotice?: string
  initialSessionId: string
  onProgress(totalTurns: number, sessionId: string): void
  onFinish(result: FinishResult): void
}

function initialProductTranscript(startupNotice: string | undefined): TerminalTranscriptState {
  const initial = initialTerminalTranscript()
  return startupNotice === undefined
    ? initial
    : appendSystemMessage(initial, startupNotice, 'developer mode', 'developer-mode-warning')
}

function TerminalProductApp(props: AppProps): React.ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [size, setSize] = useState(() => ({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 }))
  const [sessionId, setSessionId] = useState(props.initialSessionId)
  const [generation, setGeneration] = useState(1)
  const [sessionTurns, setSessionTurns] = useState(0)
  const [totalTurns, setTotalTurns] = useState(0)
  // Which suggestion the slash menu has highlighted, and whether Escape has
  // dismissed it for the current input. Both reset whenever the input changes,
  // because the list they refer to has changed with it.
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  // Usage is per runtime: a restart genuinely starts new accounting, but /clear
  // only drops local blocks and must not pretend the tokens were not spent.
  const [usage, setUsage] = useState(initialSessionUsage)
  const [phase, setPhase] = useState<TerminalRuntimePhase>('idle')
  const [transcript, setTranscript] = useState<TerminalTranscriptState>(() => initialProductTranscript(props.startupNotice))
  const [eventHistory, setEventHistory] = useState<TerminalEventHistory>(initialTerminalEventHistory)
  const [agentTopology, setAgentTopology] = useState<AgentTopologyHistory>(initialAgentTopologyHistory)
  const [input, setInput] = useState('')
  const inputRef = useRef('')
  // `cursor` is a logical grapheme index, never a UTF-16 code-unit offset.
  const [cursor, setCursor] = useState(0)
  const cursorRef = useRef(0)
  const [activeView, setActiveView] = useState<string | undefined>()
  const [, setFirstPartyViewRevision] = useState(0)
  const [metadata, setMetadata] = useState(props.metadata)
  const [composition, setComposition] = useState(props.composition)
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
  const suggestionsRef = useRef<readonly CommandSuggestion[]>([])
  const menuIndexRef = useRef(0)
  const menuDismissedRef = useRef(false)
  const sessionRef = useRef(sessionId)
  const idRef = useRef(0)
  const mountedRef = useRef(true)
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve())

  sessionRef.current = sessionId
  inputRef.current = input
  cursorRef.current = cursor
  totalTurnsRef.current = totalTurns
  menuIndexRef.current = menuIndex
  menuDismissedRef.current = menuDismissed

  useEffect(() => {
    props.onProgress(totalTurns, sessionId)
  }, [props.onProgress, sessionId, totalTurns])

  useEffect(() => () => { mountedRef.current = false }, [])

  useEffect(() => {
    const onResize = (): void => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout])

  const nextId = useCallback((prefix: string): string => `${prefix}-${++idRef.current}`, [])

  // The suggestion list is derived from the input, so any edit invalidates both
  // the highlight and an earlier dismissal. Resetting here rather than at each
  // setInput site means a new edit path cannot forget to.
  useEffect(() => {
    setMenuIndex(0)
    setMenuDismissed(false)
  }, [input])

  const commandContext = useCallback((): TerminalCommandContext => ({
    runtime: metadata,
    session: { sessionId, turnCount: sessionTurns, generation },
    phase,
    totalTurns,
    usage,
  }), [generation, phase, props.metadata, sessionId, sessionTurns, totalTurns, usage])

  const viewContext = useCallback((): TerminalViewContext => ({
    ...commandContext(),
    commands: props.host.listCommands(),
    renderers: props.host.listRenderers(),
    plugins: props.host.listPlugins(),
    events: eventHistory.items,
    ...(composition === undefined ? {} : { composition }),
    ...(selectedToolKeyRef.current === undefined ? {} : { selectedToolKey: selectedToolKeyRef.current }),
    retention: {
      totalEventCount: eventHistory.total,
      droppedEventCount: eventHistory.dropped,
      droppedTranscriptBlockCount: transcript.droppedBlockCount,
      droppedTopologyEntryCount: agentTopology.dropped,
    },
    agentTopology: [...agentTopology.entries.values()],
  }), [agentTopology, commandContext, composition, eventHistory, props.host, transcript.droppedBlockCount])

  const finish = useCallback((exitCode: number, interrupted: boolean): void => {
    props.requestShutdown()
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
    const running = runningRef.current
    const restart = props.restart
    if (!running || restart === undefined) {
      props.requestShutdown()
      if (running) {
        setTranscript(state => appendSystemMessage(
          state,
          `Ctrl+C closes the entire Harness runtime; protocol ${metadata.protocolVersion} has no prompt-level cancel and this client has no restart provider.`,
          'interrupt',
          nextId('interrupt'),
        ))
      }
      setPhase('closing')
      void props.trackRuntimeClose(props.runtimeRef.current).then(
        () => finish(130, true),
        () => finish(130, true),
      )
      return
    }

    const previousRuntime = props.runtimeRef.current
    const previousSession = sessionRef.current
    setPhase('closing')
    setTranscript(state => appendSystemMessage(
      state,
      `Interrupt requested. Protocol ${metadata.protocolVersion} has no prompt-level cancel, so dshc is stopping the whole Harness runtime. Session ${previousSession} ends here and cannot be resumed.`,
      'interrupt',
      nextId('interrupt'),
    ))
    void props.trackRuntimeClose(previousRuntime)
      .then(async () => {
        if (!mountedRef.current) return
        setPhase('starting')
        const next = await restart({})
        if (!mountedRef.current) {
          await props.trackRuntimeClose(next.runtime).catch(() => undefined)
          return
        }
        props.runtimeRef.current = next.runtime
        setMetadata(next.metadata)
        setComposition(next.composition)
        const fresh = createSessionId()
        setSessionId(fresh)
        setGeneration(value => value + 1)
        setSessionTurns(0)
        setUsage(initialSessionUsage)
        setEventHistory(initialTerminalEventHistory())
        setAgentTopology(initialAgentTopologyHistory())
        jumpToNewest()
        runningRef.current = false
        interruptingRef.current = false
        setPhase('idle')
        setTranscript(state => appendSystemMessage(
          state,
          `Interrupt completed by replacing the whole Harness runtime. New session ${fresh}; the interrupted session was not resumed.`,
          'interrupt',
          nextId('interrupt-restarted'),
        ))
      })
      .catch((error) => {
        if (!mountedRef.current) return
        const failure = classifyRuntimeError(error)
        setTranscript(state => appendSystemMessage(
          state,
          `Interrupt could not establish a clean replacement runtime, so the terminal is closing: ${failure.message}`,
          `interrupt error · ${failure.code}`,
          nextId('interrupt-error'),
        ))
        setPhase('failed')
        // Let Ink commit the diagnostic frame before unmounting. An immediate
        // replacement rejection otherwise exits on the same microtask and the
        // person sees only the preceding "stopping" message.
        setTimeout(() => {
          if (mountedRef.current) finish(130, true)
        }, 25)
      })
  }, [finish, jumpToNewest, nextId, metadata.protocolVersion, props.restart, props.runtimeRef, props.trackRuntimeClose])

  const runHarnessPrompt = useCallback(async (
    prompt: string,
    displayText: string,
    freshSession = false,
    sourceSummary?: string,
  ): Promise<void> => {
    if (runningRef.current) return
    let rootSessionId = sessionId
    if (freshSession) {
      const previous = sessionId
      rootSessionId = createSessionId()
      setSessionId(rootSessionId)
      setGeneration(value => value + 1)
      setSessionTurns(0)
      setAgentTopology(initialAgentTopologyHistory())
      setTranscript(state => appendSystemMessage(
        state,
        `History handoff starts a new analysis session ${rootSessionId}; the source session remains read-only and unchanged.${sourceSummary === undefined ? '' : `\nSelected evidence: ${sourceSummary}.`}\nPrevious live session ${previous} remains runtime-owned until exit.`,
        'history',
        nextId('history-session'),
      ))
    }

    const activityId = nextId('activity')
    setHistory(items => [...items.slice(-99), displayText])
    setTranscript(state => appendUserPrompt(state, rootSessionId, displayText, nextId('user')))
    setPhase('running')
    runningRef.current = true

    try {
      const result = await props.runtimeRef.current.run(prompt, {
        sessionId: rootSessionId,
        onEvent: event => {
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
          setUsage(state => accumulateUsage(state, event, rootSessionId))
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
      await props.trackRuntimeClose(props.runtimeRef.current).catch(() => undefined)
      finish(1, false)
    } finally {
      runningRef.current = false
    }
  }, [finish, nextId, props.debug, props.host, props.runtimeRef, props.trackRuntimeClose, sessionId])

  const retireRuntime = useCallback((previous: HarnessRuntime): void => {
    void props.trackRuntimeClose(previous).catch((error) => {
      if (!mountedRef.current) return
      const failure = classifyRuntimeError(error)
      setTranscript(state => appendSystemMessage(
        state,
        `The replacement runtime is active, but its predecessor failed to close: ${failure.message}\nThe predecessor remains tracked and shutdown will report this failure again on exit.`,
        `runtime cleanup error · ${failure.code}`,
        nextId('runtime-close-error'),
      ))
    })
  }, [nextId, props.trackRuntimeClose])

  const applyOutcome = useCallback(async (
    outcome: TerminalCommandOutcome,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (isAborted(signal)) return
    switch (outcome.kind) {
      case 'message':
        setTranscript(state => appendSystemMessage(state, outcome.text, outcome.title ?? 'dshc', nextId('message')))
        return
      case 'fork-composition': {
        const source = composition
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
          const result = await fork(source.path, signal)
          if (isAborted(signal)) return
          setTranscript(state => appendSystemMessage(
            state,
            result.created
              ? [
                  `Created the workspace patch layer at ${result.path}.`,
                  '',
                  'The shipped composition remains authoritative; this file only contains',
                  'Cordis Include patches applied on top of it.',
                  '',
                  'Edit it, then run  /reload --yes  to apply it in a new session.',
                ].join('\n')
              : [
                  `${result.path} already exists, so nothing was written.`,
                  '',
                  'Overwriting would discard edits with no way back. Move or delete it first',
                  'if you want a fresh patch layer.',
                ].join('\n'),
            'configuration',
            nextId('fork'),
          ))
        } catch (error) {
          if (isAborted(signal)) return
          const failure = classifyRuntimeError(error)
          setTranscript(state => appendSystemMessage(
            state,
            `Could not create the composition patch: ${failure.message}`,
            `configuration error · ${failure.code}`,
            nextId('fork-error'),
          ))
        }
        return
      }
      case 'plugin-search': {
        if (props.searchPlugins === undefined) {
          setTranscript(state => appendSystemMessage(state, 'Plugin search is unavailable in this session.', 'plugin', nextId('plugin')))
          return
        }
        try {
          const results = await props.searchPlugins(outcome.query, signal)
          if (isAborted(signal)) return
          const text = results.length === 0
            ? `No @deepseek-ai packages matched ${sanitizeTerminalText(outcome.query)}.`
            : results.map(result => [
                `${sanitizeTerminalText(result.name)}@${sanitizeTerminalText(result.version)}`,
                result.description.length === 0 ? '' : `  ${sanitizeTerminalText(result.description)}`,
              ].filter(Boolean).join('\n')).join('\n')
          setTranscript(state => appendSystemMessage(state, text, 'plugin search', nextId('plugin-search')))
        } catch (error) {
          if (isAborted(signal)) return
          const failure = classifyRuntimeError(error)
          setTranscript(state => appendSystemMessage(state, failure.message, `plugin search error · ${failure.code}`, nextId('plugin-error')))
        }
        return
      }
      case 'plugin-install': {
        if (!outcome.confirmed) {
          if (props.resolvePlugin === undefined) {
            setTranscript(state => appendSystemMessage(state, 'Plugin resolution is unavailable in this session.', 'plugin', nextId('plugin')))
            return
          }
          try {
            const candidate = await props.resolvePlugin(outcome.spec, signal)
            if (isAborted(signal)) return
            setTranscript(state => appendSystemMessage(
              state,
              [
                `Install ${sanitizeTerminalText(candidate.exactSpec)} into this workspace.`,
                '',
                'This downloads executable plugin code into an immutable candidate profile',
                'and trial-starts a replacement runtime with a private patch. The active',
                'workspace patch and live runtime change only after initialization succeeds.',
                '',
                `Run  /plugin install ${sanitizeTerminalText(candidate.exactSpec)} --yes  to proceed.`,
              ].join('\n'),
              'plugin confirmation',
              nextId('plugin-confirm'),
            ))
          } catch (error) {
            if (isAborted(signal)) return
            const failure = classifyRuntimeError(error)
            setTranscript(state => appendSystemMessage(state, failure.message, `plugin error · ${failure.code}`, nextId('plugin-error')))
          }
          return
        }
        if (props.installPlugin === undefined) {
          setTranscript(state => appendSystemMessage(state, 'Plugin installation is unavailable in this session.', 'plugin', nextId('plugin')))
          return
        }
        try {
          const next = await props.installPlugin(outcome.spec, signal)
          if (isAborted(signal) || !mountedRef.current) {
            await props.trackRuntimeClose(next.runtime).catch(() => undefined)
            return
          }
          const previous = props.runtimeRef.current
          props.runtimeRef.current = next.runtime
          setMetadata(next.metadata)
          setComposition(next.composition)
          retireRuntime(previous)
          const fresh = createSessionId()
          setSessionId(fresh)
          setGeneration(value => value + 1)
          setSessionTurns(0)
          setAgentTopology(initialAgentTopologyHistory())
          jumpToNewest()
          setTranscript(state => appendSystemMessage(state, `${next.message}\nNew session ${fresh}.`, 'plugin installed', nextId('plugin-install')))
        } catch (error) {
          if (isAborted(signal)) return
          const failure = classifyRuntimeError(error)
          setTranscript(state => appendSystemMessage(state, failure.message, `plugin install error · ${failure.code}`, nextId('plugin-error')))
        }
        return
      }
      case 'submit-prompt':
        if (isAborted(signal)) return
        selectView(undefined)
        jumpToNewest()
        await runHarnessPrompt(outcome.prompt, outcome.displayText, outcome.newSession, outcome.sourceSummary)
        return
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
          const next = await restart(outcome.selection, signal)
          if (isAborted(signal) || !mountedRef.current) {
            await props.trackRuntimeClose(next.runtime).catch(() => undefined)
            return
          }
          const previous = props.runtimeRef.current
          props.runtimeRef.current = next.runtime
          setMetadata(next.metadata)
          setComposition(next.composition)
          retireRuntime(previous)
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
          if (isAborted(signal)) return
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
        setTranscript(initialProductTranscript(props.startupNotice))
        selectView(undefined)
        return
      case 'exit':
        setPhase('closing')
        finish(0, false)
        return
    }
  }, [finish, jumpToNewest, nextId, props.host, metadata.protocolVersion, retireRuntime, runHarnessPrompt, selectView, sessionId])

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

    const operation = (async (): Promise<void> => {
      commandRunningRef.current = true
      setCommandBusy(true)
      try {
        const outcome = await command.execute(commandContext(), parsed.args, props.shutdownSignal)
        if (props.shutdownSignal.aborted) return
        await applyOutcome(outcome, props.shutdownSignal)
      } catch (error) {
        if (props.shutdownSignal.aborted) return
        setTranscript(state => appendSystemMessage(
          state,
          pluginErrorMessage(error),
          `command error · /${parsed.name}`,
          nextId('command-error'),
        ))
      } finally {
        commandRunningRef.current = false
        if (mountedRef.current) setCommandBusy(false)
      }
    })()
    props.trackLocalTask(operation)
    await operation
    return true
  }, [applyOutcome, commandContext, nextId, props.host, props.shutdownSignal, props.trackLocalTask])

  const submit = useCallback(async (): Promise<void> => {
    if (runningRef.current || commandRunningRef.current) return
    const raw = inputRef.current
    if (raw.trim().length === 0) return
    setEditor('', 0)
    setHistoryIndex(undefined)

    if (raw.startsWith('/') && !raw.startsWith('//')) {
      await runCommand(raw)
      return
    }

    const prompt = raw.startsWith('//') ? raw.slice(1) : raw
    jumpToNewest()
    await runHarnessPrompt(prompt, prompt)
  }, [jumpToNewest, runCommand, runHarnessPrompt])

  useInput((keyInput, key) => {
    // Ink reports one parsed key per stdin chunk, but a chunk can carry several
    // keystrokes: fast typing coalesces them and pasted text arrives whole. A
    // chunk pairing a submit character with the next keystroke would otherwise
    // fail every `key.*` test and be inserted verbatim, losing the submit and
    // leaving a raw control character in the prompt.
    const strokes = splitKeystrokes(keyInput, key)
    if (strokes.length === 1) {
      const stroke = strokes[0]!
      handleKeystroke(stroke.text, stroke.key)
      return
    }
    const task = chunkQueueRef.current.then(() => processKeystrokeChunk(strokes))
    chunkQueueRef.current = task.catch(() => undefined)
    props.trackLocalTask(task)
  })

  async function processKeystrokeChunk(strokes: readonly Keystroke[]): Promise<void> {
    for (const stroke of strokes) {
      if (props.shutdownSignal.aborted) return
      if (
        stroke.key.return
        && activeViewRef.current === undefined
        && !toolFocusRef.current
        && !runningRef.current
        && !commandRunningRef.current
      ) {
        jumpToNewest()
        await submit()
      } else {
        handleKeystroke(stroke.text, stroke.key)
      }
    }
  }

  function handleKeystroke(keyInput: string, key: InputKey): void {
    if (key.ctrl && keyInput.toLowerCase() === 'c') {
      interrupt()
      return
    }
    if (activeViewRef.current !== undefined) {
      if (activeViewRef.current === 'history' && props.history !== undefined) {
        if (key.escape) {
          if (props.history.isSearchFocused()) {
            if (props.history.toggleFocus()) setFirstPartyViewRevision(value => value + 1)
          } else if (props.history.back()) {
            setFirstPartyViewRevision(value => value + 1)
          } else {
            selectView(undefined)
          }
          return
        }
        if (key.tab) {
          if (props.history.toggleFocus()) setFirstPartyViewRevision(value => value + 1)
          return
        }
        if (props.history.isSearchFocused()) {
          if (key.ctrl && keyInput.toLowerCase() === 'u') {
            if (props.history.clearSearch()) setFirstPartyViewRevision(value => value + 1)
            return
          }
          if (key.backspace || key.delete) {
            if (props.history.deleteSearch()) setFirstPartyViewRevision(value => value + 1)
            return
          }
          if (key.return && !commandRunningRef.current) {
            commandRunningRef.current = true
            setCommandBusy(true)
            const task = props.history.commitSearch(props.shutdownSignal)
              .then(changed => {
                if (changed && !props.shutdownSignal.aborted) setFirstPartyViewRevision(value => value + 1)
              })
              .catch(error => {
                if (props.shutdownSignal.aborted) return
                setTranscript(state => appendSystemMessage(
                  state,
                  pluginErrorMessage(error),
                  'history search error',
                  nextId('history-search-error'),
                ))
              })
              .finally(() => {
                commandRunningRef.current = false
                if (mountedRef.current) setCommandBusy(false)
              })
            props.trackLocalTask(task)
            return
          }
          if (!key.ctrl && !key.meta && keyInput.length > 0) {
            if (props.history.insertSearch(keyInput)) setFirstPartyViewRevision(value => value + 1)
          }
          return
        }
        if (keyInput === 'q') {
          if (props.history.back()) setFirstPartyViewRevision(value => value + 1)
          else selectView(undefined)
          return
        }
        if (keyInput.toLowerCase() === 'c') {
          const command = props.history.continuationCommand()
          if (command !== undefined) {
            selectView(undefined)
            setEditor(command, graphemeCount(command))
            setHistoryIndex(undefined)
          }
          return
        }
        if (key.upArrow || key.downArrow) {
          if (props.history.move(key.downArrow ? 1 : -1)) setFirstPartyViewRevision(value => value + 1)
          return
        }
        if (key.return && !commandRunningRef.current) {
          commandRunningRef.current = true
          setCommandBusy(true)
          const task = props.history.openSelected(props.shutdownSignal)
            .then(changed => {
              if (changed && !props.shutdownSignal.aborted) setFirstPartyViewRevision(value => value + 1)
            })
            .catch(error => {
              if (props.shutdownSignal.aborted) return
              setTranscript(state => appendSystemMessage(
                state,
                pluginErrorMessage(error),
                'history error',
                nextId('history-error'),
              ))
              selectView(undefined)
            })
            .finally(() => {
              commandRunningRef.current = false
              if (mountedRef.current) setCommandBusy(false)
            })
          props.trackLocalTask(task)
          return
        }
        return
      }
      if (key.escape || key.return || keyInput === 'q') selectView(undefined)
      return
    }
    // Tab moves focus between the prompt and the sidebar. It is the only key
    // that changes focus, and the current focus is always stated on screen, so
    // the arrow keys never mean two things at once.
    if (key.tab) {
      // The menu is transient and explicitly open, so it takes Tab from the
      // focus switch for as long as it is showing.
      if (completeFromMenu()) return
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

    if (menuOpen()) {
      if (key.escape) {
        setMenuDismissed(true)
        return
      }
      if (key.upArrow || key.downArrow) {
        // While the menu is open the arrows belong to it. History is reachable
        // again the moment the menu closes, and the menu is always on screen
        // when this applies, so the keys never silently mean two things.
        const count = suggestionsRef.current.length
        setMenuIndex(value => (value + (key.downArrow ? 1 : count - 1)) % count)
        return
      }
      // Enter completes an unfinished command and submits a finished one, so
      // muscle memory for `/help<enter>` still submits in one keystroke.
      if (key.return && completeFromMenu()) return
    }

    if (key.return) {
      // Submitting returns to the newest activity: a reply arriving off-screen
      // while the transcript is scrolled back would look like nothing happened.
      jumpToNewest()
      void submit()
      return
    }
    if (key.backspace || key.delete) {
      if (cursorRef.current === 0) return
      const edited = deleteGraphemeBefore(inputRef.current, cursorRef.current)
      setEditor(edited.value, edited.cursor)
      return
    }
    if (key.leftArrow) {
      setEditor(inputRef.current, Math.max(0, cursorRef.current - 1))
      return
    }
    if (key.rightArrow) {
      setEditor(inputRef.current, Math.min(graphemeCount(inputRef.current), cursorRef.current + 1))
      return
    }
    if (key.upArrow && history.length > 0) {
      const next = historyIndex === undefined ? history.length - 1 : Math.max(0, historyIndex - 1)
      const value = history[next] ?? ''
      setHistoryIndex(next)
      setEditor(value, graphemeCount(value))
      return
    }
    if (key.downArrow && historyIndex !== undefined) {
      const next = historyIndex + 1
      if (next >= history.length) {
        setHistoryIndex(undefined)
        setEditor('', 0)
      } else {
        const value = history[next] ?? ''
        setHistoryIndex(next)
        setEditor(value, graphemeCount(value))
      }
      return
    }
    if (key.ctrl && keyInput.toLowerCase() === 'u') {
      setEditor('', 0)
      setHistoryIndex(undefined)
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

  function menuOpen(): boolean {
    return !menuDismissedRef.current && suggestionsRef.current.length > 0
  }

  /**
   * Put the highlighted command in the prompt. Returns false when there is
   * nothing to complete — either the menu is closed, or the input already is
   * exactly that command, in which case the keystroke belongs to submitting.
   */
  function completeFromMenu(): boolean {
    if (!menuOpen()) return false
    const selected = suggestionsRef.current[menuIndexRef.current]
    if (selected === undefined) return false
    const completed = `/${selected.name} `
    if (inputRef.current === completed || inputRef.current === `/${selected.name}`) return false
    setEditor(completed, graphemeCount(completed))
    return true
  }

  function setEditor(value: string, nextCursor: number): void {
    inputRef.current = value
    cursorRef.current = nextCursor
    setInput(value)
    setCursor(nextCursor)
  }

  function insertInput(text: string): void {
    const edited = insertAtGrapheme(inputRef.current, cursorRef.current, text)
    setEditor(edited.value, edited.cursor)
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
  const suggestions = currentView === undefined && !toolFocus && !menuDismissed
    ? commandSuggestions(input, props.host.listCommands())
    : []
  suggestionsRef.current = suggestions
  // The menu competes with the transcript for rows, so it takes only what is
  // left after the chrome and a usable body. On a short terminal it shows
  // fewer entries rather than being clipped by the frame.
  const menuCapacity = Math.max(0, Math.min(8, size.rows - 7 - MIN_BODY_ROWS))
  const menuView = menuWindow(suggestions.length, menuCapacity, menuIndex)
  const menuRows = menuView.shown === 0
    ? 0
    : menuView.shown + (menuView.above > 0 ? 1 : 0) + (menuView.below > 0 ? 1 : 0)
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

      {menuView.shown > 0 && (
        <CommandMenu
          suggestions={suggestions}
          view={menuView}
          selected={menuIndex}
          width={size.columns}
        />
      )}

      <Box flexDirection="column" flexShrink={0} paddingX={1}>
        {currentView !== undefined
          ? <Text dimColor>{activeView === 'history'
              ? 'History · Enter inspect · c continue in NEW session · Esc/q back'
              : 'Esc / Enter / q · return to transcript'}</Text>
          : <>
              <Text dimColor>{toolFocus
                ? 'tools focused · ↑/↓ select · Enter details · Tab or Esc back to prompt'
                : phase === 'running'
                  ? props.restart === undefined
                    ? 'Harness is running… Ctrl+C closes the whole runtime'
                    : 'Harness is running… Ctrl+C interrupts via a fresh runtime and session'
                  : commandBusy ? 'Local terminal command is running…'
                    // The arrows and Tab mean something different while the
                    // menu is open, so the line says which meaning is live
                    // rather than leaving the reader to discover it.
                    : menuView.shown > 0
                      ? '↑/↓ choose · Tab complete · Enter run · Esc close'
                      : 'Enter submit · /history past conversations · PgUp/PgDn scroll · Tab tools · /help'}</Text>
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

/**
 * Which slice of the suggestion list is on screen, and how much is out of sight
 * on each side. The window follows the selection rather than truncating at the
 * capacity, so an entry below the fold is reachable instead of merely counted.
 */
export function menuWindow(count: number, capacity: number, index: number): {
  offset: number
  shown: number
  above: number
  below: number
} {
  const shown = Math.max(0, Math.min(count, capacity))
  if (shown === 0) return { offset: 0, shown: 0, above: 0, below: 0 }
  const clamped = Math.max(0, Math.min(count - 1, index))
  const offset = Math.max(0, Math.min(count - shown, clamped - shown + 1))
  return { offset, shown, above: offset, below: Math.max(0, count - offset - shown) }
}

function CommandMenu({ suggestions, view, selected, width }: {
  suggestions: readonly CommandSuggestion[]
  view: { offset: number; shown: number; above: number; below: number }
  selected: number
  width: number
}): React.ReactElement {
  const nameWidth = Math.max(...suggestions.map(item => item.name.length + 1))
  const visible = suggestions.slice(view.offset, view.offset + view.shown)
  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1}>
      {view.above > 0 && (
        <Box flexShrink={0}>
          <Text dimColor>{`↑ ${view.above} more`}</Text>
        </Box>
      )}
      {visible.map((item, position) => {
        const active = view.offset + position === selected
        return (
          <Box key={item.name} flexShrink={0}>
            {/* Selection is carried by the marker as well as by colour, so it
                survives a monochrome terminal and a colour-blind reader. */}
            <Text color={active ? 'cyan' : undefined} bold={active} wrap="truncate">{cropTerminalText(
              `${active ? '›' : ' '} /${item.name.padEnd(nameWidth)} ${item.summary}`,
              Math.max(10, width - 2),
            )}</Text>
          </Box>
        )
      })}
      {view.below > 0 && (
        <Box flexShrink={0}>
          <Text dimColor>{`↓ ${view.below} more`}</Text>
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
  const tokens = terminalCommandTokens(raw.trim().slice(1))
  const name = (tokens.shift() ?? '').toLowerCase()
  return { name, args: tokens }
}

/** Minimal quoting for paths/arguments; backslashes remain ordinary Windows path characters. */
function terminalCommandTokens(value: string): string[] {
  const tokens: string[] = []
  let token = ''
  let started = false
  let quote: '"' | "'" | undefined
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else if (quote === '"' && char === '\\' && value[index + 1] === '"') {
        token += '"'
        index += 1
      } else {
        token += char
      }
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(token)
        token = ''
        started = false
      }
      continue
    }
    token += char
    started = true
  }
  if (started) tokens.push(token)
  return tokens
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
      {!collapsed && block.text.length > 0 && (
        // Prose is rendered as markdown; tool output is not. A tool result is
        // program output, and a log line containing an asterisk must survive
        // exactly as the program wrote it.
        block.kind === 'assistant' && looksLikeMarkdown(block.text)
          ? <MarkdownBody text={foldTerminalText(block.text, block.foldable === true, bodyWidth)} width={bodyWidth} />
          : <Text wrap="wrap">{foldTerminalText(block.text, block.foldable === true, bodyWidth)}</Text>
      )}
      {!collapsed && block.detail !== undefined && block.detail.length > 0 && <Text dimColor wrap="wrap">{foldTerminalText(block.detail, true, bodyWidth)}</Text>}
    </Box>
  )
}

/**
 * Draw parsed markdown with Ink props only.
 *
 * Every style here is a prop on a `<Text>` element. Nothing in this component,
 * or in the parser behind it, may emit an escape sequence: the sanitizer strips
 * those out of upstream text precisely so they cannot reach the terminal, and
 * re-introducing them on the rendering side would reopen that hole.
 */
function MarkdownBody({ text, width }: { text: string; width: number }): React.ReactElement {
  const lines = parseMarkdown(text)
  return (
    <Box flexDirection="column" flexShrink={0}>
      {lines.map((line, index) => (
        <Box key={index} flexShrink={0}>
          <MarkdownLineView line={line} width={width} />
        </Box>
      ))}
    </Box>
  )
}

function MarkdownLineView({ line, width }: { line: MarkdownLine; width: number }): React.ReactElement {
  switch (line.kind) {
    case 'blank':
      return <Text> </Text>
    case 'rule':
      return <Text dimColor>{'─'.repeat(Math.max(1, Math.min(width, 80)))}</Text>
    case 'heading':
      // Level is carried by the prefix as well as the weight, so the structure
      // survives a monochrome terminal.
      return (
        <Text bold color="cyan" wrap="wrap">
          {`${'#'.repeat(line.level)} `}
          <Spans spans={line.spans} />
        </Text>
      )
    case 'quote':
      return (
        <Text dimColor wrap="wrap">
          {'│ '}
          <Spans spans={line.spans} />
        </Text>
      )
    case 'bullet':
      return (
        <Text wrap="wrap">
          {`${' '.repeat(Math.min(line.indent, 8))}${line.marker} `}
          <Spans spans={line.spans} />
        </Text>
      )
    case 'code':
      return (
        <Box flexDirection="column" flexShrink={0} paddingLeft={2}>
          {line.text.split('\n').map((row, index) => (
            <Text key={index} color="yellow" dimColor wrap="wrap">{row.length === 0 ? ' ' : row}</Text>
          ))}
        </Box>
      )
    case 'table':
      return <MarkdownTable rows={line.rows} headerRows={line.headerRows} width={width} />
    case 'text':
      return (
        <Text wrap="wrap">
          {' '.repeat(Math.min(line.indent, 8))}
          <Spans spans={line.spans} />
        </Text>
      )
  }
}

function MarkdownTable({ rows, headerRows, width }: {
  rows: readonly (readonly (readonly MarkdownSpan[])[])[]
  headerRows: number
  width: number
}): React.ReactElement {
  const widths = tableColumnWidths(rows)
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((row, rowIndex) => (
        <Text key={rowIndex} bold={rowIndex < headerRows} wrap="truncate">
          {cropTerminalText(
            row
              .map((cell, column) => padToCells(spanText(cell), widths[column] ?? 0))
              .join('  '),
            Math.max(10, width),
          )}
        </Text>
      ))}
    </Box>
  )
}

/**
 * Inline spans inside one parent Text. Emphasis inside a table cell is dropped
 * rather than rendered, because a cell has to be padded to a measured width and
 * a nested element cannot be padded without guessing where it breaks.
 */
function Spans({ spans }: { spans: readonly MarkdownSpan[] }): React.ReactElement {
  return (
    <>
      {spans.map((span, index) => (
        <Text
          key={index}
          bold={span.bold === true}
          italic={span.italic === true}
          {...(span.code === true ? { color: 'yellow' as const } : {})}
        >{span.text}</Text>
      ))}
    </>
  )
}

/** Pad to a cell count rather than a character count, so CJK columns line up. */
function padToCells(value: string, cells: number): string {
  const missing = Math.max(0, cells - terminalCellWidth(value))
  return `${value}${' '.repeat(missing)}`
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
  return classifyRuntimeError(error).message
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}
