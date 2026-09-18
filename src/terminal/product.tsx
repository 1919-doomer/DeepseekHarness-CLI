import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TerminalEventBatch, coalesceTranscriptDeltas } from './event-batch.js'
import { StatusBar, statusBarContentRows } from './status-bar.js'
import { OverviewSidebar, ToolSidebarStats } from './overview.js'
import { AgentWindows } from './agent-windows.js'
import { startWithSplash } from './splash.js'
import { installCrashGuard } from './crash-guard.js'
import { defaultSessionRoot } from '../upstream/session-log.js'
import { SessionClock } from '../session/session-clock.js'
import { InteractionCard, createInteractionDraft, type InteractionCardHandle } from './interaction-card.js'
import type { InteractionRequest, InteractionAnswer } from '../upstream/interaction.js'
import { buildPlanHandoff } from '../history/plan-handoff.js'
import { ModelTelemetryMeter, type ModelTelemetry } from '../session/model-telemetry.js'
import { commandArgumentChoices } from './command-choices.js'
import { TranscriptLayoutCache, TranscriptRows, selectTranscriptPage, transcriptAnchor, type TranscriptAnchor, type TranscriptLayout, type TranscriptPage } from './transcript-viewport.js'
import { DEFAULT_PREFERENCES, pickPreferences, preferencePaths, savePreferences, type Preferences, type WorkMode } from '../preferences.js'
import { resolveLocale, translate, uiLabel, type Locale } from '../i18n.js'
import { PromptQueue } from './prompt-queue.js'
import { useSnapshotState } from './snapshot-store.js'
import { completeFileReference, editExternally, keyMatches, MAX_INPUT_CHARS } from './input-actions.js'
import { Box, Text, render, useApp, useInput, usePaste, useStdout } from 'ink'
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
} from '../plugins/api.js'
import { createDefaultTerminalHost } from '../plugins/builtins.js'
import type { TerminalPluginHost } from '../plugins/host.js'
import type { HistoryWorkbench } from '../plugins/history.js'
import {
  appendTerminalEventBatch,
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
  sliceByGrapheme,
  suffixByCells,
  terminalCellWidth,
} from './text-metrics.js'

const ALT_SCREEN_ON = '\u001B[?1049h'
const ALT_SCREEN_OFF = '\u001B[?1049l'
export { DEFAULT_FOLD_LIMIT, blockElapsedMs, formatElapsedMs, selectVisibleBlocks, takeVisibleBlocks, blockHeaderText, foldTerminalText } from './transcript-view.js'
import { ViewPanel } from './transcript-view.js'
import type { NormalizedEvent } from '../session/projection.js'

/** The initialize parameters a restart may change, plus the composition file. */
export interface RuntimeSelection extends Partial<Preferences> {
  provider?: string
  model?: string
  maxTokens?: number
  /** Composition file to launch with; absent keeps the current one. */
  runtimeConfig?: string
  /** Steps already approved, carried into the session that implements them. */
  approvedPlan?: readonly string[]
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
  profileOperation?: (args: readonly string[], signal?: AbortSignal, preferences?: Partial<Preferences>) => Promise<{ message: string; replacement?: RuntimeRestart }>
  preferences?: Partial<Preferences>
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
  runtime.enableInteraction()
  const { metadata, draft: startupDraft, instance: startupInstance } = await startWithSplash(runtime, options.stdin ?? process.stdin, options.stdout ?? process.stdout, options.stderr ?? process.stderr, options.preferences?.animation, options.interactive, resolveLocale(options.preferences?.locale))
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
  let exitReason: string | undefined
  let instance: ReturnType<typeof render> | undefined = startupInstance
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
  const onEof = (): void => {
    // Reported after the alternate screen is restored, below: anything written
    // while it is still on goes into a buffer the terminal discards.
    exitReason = resolveLocale(options.preferences?.locale) === 'zh-CN'
      ? 'dshc: 标准输入已关闭，会话随之结束。\n'
      : 'dshc: standard input closed, so the session ended with it.\n'
    finish({
      exitCode: 0,
      interrupted: false,
      totalTurns: latest.totalTurns,
      sessionId: latest.sessionId,
    })
  }

  // Installed before the alternate screen is entered and removed in the finally
  // below, so it can never outlive the terminal state it knows how to restore.
  const disposeCrashGuard = installCrashGuard({
    terminal: () => ({ stdout, alternateEntered, stdin }),
    stderr,
    locale: resolveLocale(options.preferences?.locale),
    // Beside the session logs, because that is where someone already looks
    // when they want to know what happened.
    report: { directory: defaultSessionRoot(process.env) },
  })

  try {
    startupInstance?.clear()
    if (alternate) {
      stdout.write(ALT_SCREEN_ON)
      alternateEntered = true
    }
    process.once('SIGINT', onInt)
    process.once('SIGTERM', onTerm)
    stdin.once('end', onEof)

    const app = (
      <TerminalProductApp
        startupDraft={startupDraft}
        agentWindowsEnabled={process.platform === 'win32' && stdin === process.stdin && stdout === process.stdout && options.interactive !== false && !process.env.CI}
        preferences={options.preferences}
        profileOperation={options.profileOperation}
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
      />
    )
    const current = startupInstance ?? render(app, {
        stdin,
        stdout,
        stderr,
        interactive: options.interactive,
        exitOnCtrlC: false,
        patchConsole: false,
      })
    if (startupInstance) startupInstance.rerender(app)
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
    disposeCrashGuard()
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
    stdin.off('end', onEof)
    instance?.unmount()
    if (alternateEntered) stdout.write(ALT_SCREEN_OFF)
    // Only now is stderr visible to the reader again.
    if (exitReason !== undefined) stderr.write(exitReason)
    shutdown.abort(new Error('terminal product is closing'))
    await drainLocalTasks()
    await runtimeClosures.drain(runtimeRef.current)
  }
}

interface AppProps {
  startupDraft?: string
  agentWindowsEnabled?: boolean
  profileOperation?: TerminalProductOptions['profileOperation']
  preferences?: Partial<Preferences>
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
  const [preferences, setPreferences] = useState<Preferences>(() => ({ ...DEFAULT_PREFERENCES, ...props.preferences }))
  const locale = resolveLocale(preferences.locale)
  const [queue] = useState(() => new PromptQueue())
  const [, setQueueRevision] = useState(0)
  const nextQueuedRef = useRef<() => void>(() => undefined)
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp()
  const { stdout } = useStdout()
  const [size, setSize] = useState(() => ({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 }))
  const [sessionId, setSessionId] = useState(props.initialSessionId)
  const [clock] = useState(() => { const value = new SessionClock(); value.reset(props.initialSessionId); return value })
  const [interaction, setInteraction] = useState<InteractionRequest | undefined>()
  // Steps the model committed to before starting. Shown beside the work rather
  // than scrolling away with the rest of the transcript.
  const [plan, setPlan] = useState<readonly string[] | undefined>()
  const interactionDraft = useMemo(() => interaction ? createInteractionDraft(interaction) : undefined, [interaction])
  const clarificationRef = useRef<unknown[]>([])
  const [interactionHidden, setInteractionHidden] = useState(false)
  const interactionHiddenRef = useRef(false)
  const cardRef = useRef<InteractionCardHandle>(null)
  const confirmedPlan = useRef<{ request: InteractionRequest & { kind: 'plan' }; runtime: HarnessRuntime } | undefined>(undefined)
  const handoffRef = useRef<() => Promise<void>>(async () => undefined)
  const [sidebarPage, setSidebarPage] = useState<'overview' | 'tools'>('tools')
  const sidebarPageRef = useRef<'overview' | 'tools'>('tools')
  const [overviewOffset, setOverviewOffset] = useState(0)
  const [generation, setGeneration] = useState(1)
  const agentWindows = useMemo(() => props.agentWindowsEnabled && preferences.subagentWindows !== false
    ? new AgentWindows(sessionId, locale) : undefined, [sessionId, generation, props.agentWindowsEnabled, preferences.subagentWindows])
  const [agentWindowRevision, setAgentWindowRevision] = useState(0)
  const externalSessions = useRef(new Set<string>())
  useEffect(() => {
    const unsubscribe = agentWindows?.subscribe(() => { agentWindows.syncSeparated(externalSessions.current); setAgentWindowRevision(value => value + 1) })
    const close = () => agentWindows?.close()
    props.shutdownSignal.addEventListener('abort', close, { once: true })
    return () => { unsubscribe?.(); props.shutdownSignal.removeEventListener('abort', close); close() }
  }, [agentWindows, props.shutdownSignal])
  const [sessionTurns, setSessionTurns] = useState(0)
  const [totalTurns, setTotalTurns] = useState(0)
  // Which suggestion the slash menu has highlighted, and whether Escape has
  // dismissed it for the current input. Both reset whenever the input changes,
  // because the list they refer to has changed with it.
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuDismissed, setMenuDismissed] = useState(false)
  // Usage is per runtime: a restart genuinely starts new accounting, but /clear
  // only drops local blocks and must not pretend the tokens were not spent.
  const [usage, setUsage] = useSnapshotState(initialSessionUsage, stdout)
  const [telemetryMeter] = useState(() => new ModelTelemetryMeter())
  const [telemetry, setTelemetry] = useSnapshotState<ModelTelemetry | undefined>(undefined, stdout)
  const [phase, setPhase] = useState<TerminalRuntimePhase>('idle')
  const [transcript, setTranscript] = useSnapshotState<TerminalTranscriptState>(() => initialProductTranscript(props.startupNotice), stdout)
  const [eventHistory, setEventHistory] = useSnapshotState<TerminalEventHistory>(initialTerminalEventHistory, stdout)
  const [agentTopology, setAgentTopology] = useSnapshotState<AgentTopologyHistory>(initialAgentTopologyHistory, stdout)
  const [input, setInput] = useState(props.startupDraft ?? '')
  const inputRef = useRef(props.startupDraft ?? '')
  // `cursor` is a logical grapheme index, never a UTF-16 code-unit offset.
  const [cursor, setCursor] = useState(graphemeCount(props.startupDraft ?? ''))
  const cursorRef = useRef(graphemeCount(props.startupDraft ?? ''))
  const [activeView, setActiveView] = useState<string | undefined>()
  const [fileChoices, setFileChoices] = useState<readonly string[]>([])
  const fileChoicesRef = useRef<readonly string[]>([])
  const [fileIndex, setFileIndex] = useState(0)
  const fileIndexRef = useRef(0)
  const [localReport, setLocalReport] = useState<TerminalViewSpec | undefined>()
  const [firstPartyViewRevision, setFirstPartyViewRevision] = useState(0)
  const eventKindRevisions = useRef(new Map<NormalizedEvent['kind'], number>())
  const [metadata, setMetadata] = useState(props.metadata)
  const [composition, setComposition] = useState(props.composition)
  const [showTools, setShowTools] = useState(true)
  // An anchored row keeps the reading position when a reply grows below it.
  // Undefined follows the live tail; navigation can stop within any message.
  const [scrollAnchor, setScrollAnchor] = useState<TranscriptAnchor | undefined>()
  const [transcriptLayoutCache] = useState(() => new TranscriptLayoutCache())
  const scrollNavigationRef = useRef<{ layout: TranscriptLayout; page: TranscriptPage } | undefined>(undefined)

  const jumpToNewest = useCallback((): void => {
    setScrollAnchor(undefined)
  }, [])

  const scrollTranscript = useCallback((delta: number): void => {
    const navigation = scrollNavigationRef.current
    if (!navigation) return
    const { layout, page } = navigation
    const next = Math.max(0, Math.min(page.maximum, page.start - delta * Math.max(1, page.capacity - 2)))
    const anchor = next === page.maximum ? undefined : transcriptAnchor(layout, next)
    setScrollAnchor(anchor)
    scrollNavigationRef.current = { layout, page: { ...page, start: next } }
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
  const historyIndexRef = useRef<number | undefined>(undefined)
  const historyDraftRef = useRef({ value: '', cursor: 0 })
  const setHistoryIndex = (index: number | undefined): void => { historyIndexRef.current = index }
  const [commandBusy, setCommandBusy] = useState(false)
  // `activeView` state only lands on the next render, but one stdin chunk can
  // carry several keystrokes that must observe each other's effect in order.
  const activeViewRef = useRef<string | undefined>(undefined)
  const selectView = useCallback((next: string | undefined): void => {
    activeViewRef.current = next
    setActiveView(next)
  }, [])
  const runningRef = useRef(false)
  const eventBatchRef = useRef<TerminalEventBatch | undefined>(undefined)
  const commandRunningRef = useRef(false)
  const interruptingRef = useRef(false)
  const totalTurnsRef = useRef(0)
  const menuIndexRef = useRef(0)
  const menuDismissedRef = useRef(false)
  const sessionRef = useRef(sessionId)
  const idRef = useRef(0)
  const mountedRef = useRef(true)
  const finishingRef = useRef(false)
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

  useEffect(() => { clock.reset(sessionId); confirmedPlan.current = undefined; clarificationRef.current = [] }, [clock, sessionId])
  useEffect(() => {
    const bridge = props.runtimeRef.current.interaction
    const changed = (): void => {
      const request = bridge?.current
      if (request) { confirmedPlan.current = undefined; interactionHiddenRef.current = false; setInteractionHidden(false) }
      setInteraction(request); setPlan(bridge?.plan); clock.wait(request !== undefined)
    }
    changed()
    return bridge?.subscribe(changed)
  }, [metadata, clock, props.runtimeRef])

  useEffect(() => () => { mountedRef.current = false; eventBatchRef.current?.close() }, [])

  useEffect(() => {
    const onResize = (): void => setSize({ columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout])

  const nextId = useCallback((prefix: string): string => `${prefix}-${++idRef.current}`, [])

  const commandContext = useCallback((): TerminalCommandContext => ({
    sessionTiming: clock.snapshot(), compaction: clock.compaction,
    locale,
    preferences,
    runtime: metadata,
    session: { sessionId, turnCount: sessionTurns, generation },
    phase,
    totalTurns,
    usage,
    modelTelemetry: telemetry?.sessionId === sessionId ? telemetry : undefined,
  }), [generation, phase, metadata, locale, preferences, sessionId, sessionTurns, totalTurns, usage, telemetry])

  const viewContext = useCallback((): TerminalViewContext => ({
    ...commandContext(),
    commands: props.host.listCommands(locale),
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
    if (finishingRef.current) return
    finishingRef.current = true
    eventBatchRef.current?.close()
    props.requestShutdown()
    const task = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([waitUntilRenderFlush(), new Promise<void>(resolve => { timeout = setTimeout(resolve, 5_000) })])
      } finally {
        if (timeout) clearTimeout(timeout)
        props.onFinish({ exitCode, interrupted, totalTurns: totalTurnsRef.current, sessionId: sessionRef.current })
        exit()
      }
    })()
    props.trackLocalTask(task)
  }, [exit, props, waitUntilRenderFlush])

  const interrupt = useCallback((): void => {
    agentWindows?.close()
    confirmedPlan.current = undefined
    props.runtimeRef.current.interaction?.cancel()
    clock.stop()
    queue.pause()
    setQueueRevision(value => value + 1)
    eventBatchRef.current?.close()
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
        const next = await restart(preferences)
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
  }, [finish, jumpToNewest, nextId, metadata.protocolVersion, props.restart, props.runtimeRef, props.trackRuntimeClose, preferences, queue, agentWindows])

  const runHarnessPrompt = useCallback(async (
    prompt: string,
    displayText: string,
    freshSession = false,
    sourceSummary?: string,
  ): Promise<void> => {
    if (runningRef.current) return
    let rootSessionId = sessionRef.current
    if (freshSession) {
      queue.pause()
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
    clock.reset(rootSessionId)
    clock.start()
    setHistory(items => [...items.slice(-99), displayText])
    setTranscript(state => appendUserPrompt(state, rootSessionId, displayText, nextId('user')))
    setPhase('running')
    runningRef.current = true
    telemetryMeter.begin(rootSessionId)
    setTelemetry(telemetryMeter.snapshot())

    let succeeded = false
    const batch = new TerminalEventBatch(events => {
      if (!mountedRef.current || props.shutdownSignal.aborted) return
      for (const event of events) agentWindows?.observe(event)
      setTelemetry(telemetryMeter.snapshot())
      for (const kind of new Set(events.map(event => event.kind))) eventKindRevisions.current.set(kind, (eventKindRevisions.current.get(kind) ?? 0) + 1)
      const display = coalesceTranscriptDeltas(events, event => props.host.matchingRenderer(event) !== undefined)
      setTranscript(state => display.reduce((next, event) => reduceTerminalEvent(
        next, event, props.host, activityId, rootSessionId, props.debug), state))
      setEventHistory(state => appendTerminalEventBatch(state, events))
      const topology = events.filter(event => event.kind === 'subagent-started' || event.kind === 'subagent-finished')
      if (topology.length > 0) setAgentTopology(state => topology.reduce(reduceAgentTopologyHistory, state))
      const usageEvents = events.filter(event => event.kind === 'assistant-message' || event.kind === 'context-compacted')
      if (usageEvents.length > 0) setUsage(state => usageEvents.reduce((next, event) => accumulateUsage(next, event, rootSessionId), state))
    }, undefined, error => {
      // Publication runs plugin renderers, transcript reducers and a React
      // render. Any of those can throw on one malformed event; none of them is
      // worth the session. Report it where the reader is already looking and
      // keep streaming — the runtime still has every original event.
      const detail = error instanceof Error ? error.message : String(error)
      setTranscript(state => appendSystemMessage(
        state,
        locale === 'zh-CN'
          ? `本次输出有一段没能渲染，会话继续。/trace 可以查看原始事件。\n${detail}`
          : `A piece of this reply could not be rendered; the session continues. /trace has the original events.\n${detail}`,
        locale === 'zh-CN' ? '渲染失败' : 'render failed',
        nextId('render-error'),
      ))
    })
    eventBatchRef.current = batch
    try {
      const result = await props.runtimeRef.current.run(prompt, {
        sessionId: rootSessionId,
        onEvent: event => {
          if (batch.closed) return
          telemetryMeter.observe(event)
          clock.observe(event)
          if (event.kind === 'tool-result' && event.callId === confirmedPlan.current?.request.callId && event.isError) confirmedPlan.current = undefined
          batch.push(event)
        },
      })
      if (batch.closed) return
      batch.flush()
      if (props.runtimeRef.current.metadata) setMetadata(props.runtimeRef.current.metadata)
      succeeded = result.projection.lastTurnError === undefined
      if (!succeeded) queue.pause()
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
      queue.pause()
      if (interruptingRef.current || batch.closed) return
      const failure = classifyRuntimeError(error)
      setPhase('failed')
      setTranscript(state => appendSystemMessage(state, failure.message, `runtime error · ${failure.code}`, nextId('runtime-error')))
      await props.trackRuntimeClose(props.runtimeRef.current).catch(() => undefined)
      finish(1, false)
    } finally {
      batch.close()
      if (eventBatchRef.current === batch) {
        clock.stop()
        runningRef.current = false
        if (!succeeded) confirmedPlan.current = undefined
        if (succeeded && !props.shutdownSignal.aborted) queueMicrotask(() => {
          if (confirmedPlan.current) props.trackLocalTask(handoffRef.current())
          else nextQueuedRef.current()
        })
      }
    }
  }, [finish, nextId, props.debug, props.host, props.runtimeRef, props.shutdownSignal, props.trackRuntimeClose, sessionId, queue, agentWindows])

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

  function answerInteraction(answer: InteractionAnswer): void {
    const runtime = props.runtimeRef.current, request = runtime.interaction?.current
    if (!request || request.sessionId !== sessionRef.current) return
    if (!runtime.interaction?.answer(request.id, answer)) return
    if (request.kind === 'questions') {
      clarificationRef.current = [...clarificationRef.current.slice(-5), { questions: request.questions, answer }]
    }
    if (request.kind === 'plan') {
      setTranscript(state => appendSystemMessage(state, `${request.title}\n${request.text}`, 'plan', nextId('plan')))
      if (answer.action === 'implement') { queue.pause(); confirmedPlan.current = { request, runtime } }
    }
  }
  handoffRef.current = async () => {
    const approved = confirmedPlan.current
    confirmedPlan.current = undefined
    if (!approved || approved.runtime !== props.runtimeRef.current || approved.request.sessionId !== sessionRef.current || props.shutdownSignal.aborted) return
    queue.pause()
    commandRunningRef.current = true; setCommandBusy(true)
    const label = `${locale === 'zh-CN' ? '实施已确认计划，来源会话' : 'Implement confirmed plan from'} ${approved.request.sessionId}\n${approved.request.title}`
    // Same session when the runtime can switch in place: the model that wrote
    // the plan keeps everything it read and was told while writing it. A new
    // session only remains as the fallback, because protocol 0.0.1 cannot
    // carry a conversation across a restart.
    const bridge = props.runtimeRef.current.interaction
    if (bridge?.canSteer === true) {
      try {
        await bridge.setMode('code', { seedPlanFor: sessionRef.current })
        setPreferences(value => ({ ...value, mode: 'code' }))
        setMetadata(value => ({ ...value, requestedPreferences: { ...value.requestedPreferences, mode: 'code' } }))
        const prompt = buildPlanHandoff(approved.request.sessionId, approved.request.title, approved.request.text, clarificationRef.current)
        commandRunningRef.current = false; setCommandBusy(false)
        await runHarnessPrompt(prompt, label)
        return
      } catch {
        // Fall back to the restart below, which says what is being lost.
      }
    }
    try {
      if (!props.restart) throw new Error('Runtime restart is unavailable')
      const next = await props.restart({
        ...preferences,
        mode: 'code',
        // The plan was just reviewed and approved through present_plan; asking
        // the implementing session to declare one again would put the same
        // question twice. outline_plan is not registered in plan mode, so this
        // comes from the approved request rather than from the sidebar state.
        approvedPlan: [approved.request.title],
      }, props.shutdownSignal)
      if (props.shutdownSignal.aborted || approved.runtime !== props.runtimeRef.current || approved.request.sessionId !== sessionRef.current) { await props.trackRuntimeClose(next.runtime); return }
      const fresh = createSessionId()
      props.runtimeRef.current = next.runtime; sessionRef.current = fresh
      setMetadata(next.metadata); setPreferences(value => ({ ...value, mode: 'code' })); setComposition(next.composition)
      setSessionId(fresh); setSessionTurns(0); setGeneration(value => value + 1)
      setUsage(initialSessionUsage); setAgentTopology(initialAgentTopologyHistory()); setEventHistory(initialTerminalEventHistory())
      retireRuntime(approved.runtime)
      const source = approved.request.sessionId
      const prompt = buildPlanHandoff(source, approved.request.title, approved.request.text, clarificationRef.current)
      commandRunningRef.current = false; setCommandBusy(false)
      await runHarnessPrompt(prompt, `${locale === 'zh-CN' ? '实施已确认计划，来源会话' : 'Implement confirmed plan from'} ${source}\n${approved.request.title}`)
    } catch (error) {
      setTranscript(state => appendSystemMessage(state, `${locale === 'zh-CN' ? '编码启动失败，原计划和会话已保留' : 'Coding startup failed; original plan and session retained'}: ${pluginErrorMessage(error)}`, 'plan', nextId('plan-error')))
    } finally { commandRunningRef.current = false; setCommandBusy(false) }
  }

  async function openExternalEditor(): Promise<void> {
    const text = inputRef.current
    commandRunningRef.current = true
    setCommandBusy(true)
    const task = editExternally(text, preferences, metadata.workspace, suspendTerminal, props.shutdownSignal)
      .then(next => { if (!props.shutdownSignal.aborted) setEditor(next, graphemeCount(next)) })
      .catch(error => { if (!props.shutdownSignal.aborted) setTranscript(state => appendSystemMessage(state, pluginErrorMessage(error), 'editor', nextId('editor'))) })
      .finally(() => { commandRunningRef.current = false; if (mountedRef.current) setCommandBusy(false) })
    props.trackLocalTask(task)
    await task
  }

  /**
   * Switch modes without a new process, and therefore without losing the
   * conversation. Returns false only when the caller should fall back to a
   * restart the person has explicitly confirmed with --yes.
   */
  const switchModeInPlace = useCallback(async (
    mode: WorkMode,
    allowRestart: boolean,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const zh = locale === 'zh-CN'
    const label = zh ? { code: '编码', plan: '规划', review: '审阅', research: '研究' }[mode] : mode
    const bridge = props.runtimeRef.current.interaction
    let failure: string | undefined
    if (bridge?.canSteer === true) {
      try {
        const changed = await bridge.setMode(mode)
        if (isAborted(signal)) return true
        setPreferences(value => ({ ...value, mode }))
        // The runtime really is in the new mode now. Recording it keeps /status
        // from listing the mode as waiting for a restart it no longer needs.
        setMetadata(value => ({ ...value, requestedPreferences: { ...value.requestedPreferences, mode } }))
        setTranscript(state => appendSystemMessage(
          state,
          changed
            ? (zh ? `已切换到${label}模式。这是同一个会话，之前的对话都还在。` : `Switched to ${label} mode. Same session; the conversation so far is kept.`)
            : (zh ? `已经是${label}模式。` : `Already in ${label} mode.`),
          zh ? '模式' : 'mode',
          nextId('mode'),
        ))
        return true
      } catch (error) {
        failure = pluginErrorMessage(error)
      }
    }
    if (allowRestart) return false
    setTranscript(state => appendSystemMessage(
      state,
      [
        ...(failure === undefined ? [] : [failure]),
        zh
          ? `这个运行时不能就地切换模式。/mode ${mode} --yes 会重启运行时并开启新会话，当前对话不会带过去。`
          : `This runtime cannot switch modes in place. /mode ${mode} --yes restarts it and starts a new session; this conversation will not carry over.`,
      ].join('\n'),
      zh ? '模式' : 'mode',
      nextId('mode'),
    ))
    return true
  }, [locale, nextId, props.runtimeRef])

  const applyOutcome = useCallback(async (
    outcome: TerminalCommandOutcome,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (isAborted(signal)) return
    if (outcome.kind === 'switch-mode') {
      if (await switchModeInPlace(outcome.mode, outcome.allowRestart, signal)) return
      // In-place switching failed and the person already consented to a
      // restart: take the existing restart path, which says what is lost.
      outcome = { kind: 'restart-runtime', selection: { mode: outcome.mode }, summary: `mode: ${outcome.mode}` }
    }
    switch (outcome.kind) {
      case 'sidebar': {
        const next = outcome.page ?? (sidebarPageRef.current === 'overview' ? 'tools' : 'overview')
        sidebarPageRef.current = next; setSidebarPage(next); setShowTools(true); setOverviewOffset(0)
        return
      }
      case 'profile-operation': {
        if (!props.profileOperation) throw new Error('No Profile manager is attached to this terminal')
        queue.pause()
        const result = await props.profileOperation(outcome.args, signal, preferences)
        const next = result.replacement
        if (isAborted(signal) || !mountedRef.current) { if (next) await props.trackRuntimeClose(next.runtime); return }
        if (next) {
          const previous = props.runtimeRef.current
          props.runtimeRef.current = next.runtime
          setMetadata(next.metadata)
          setPreferences(value => ({ ...value, runtime: 'dsh-profile', dshProfile: 'managed' }))
          setComposition(undefined)
          setSessionId(createSessionId())
          setGeneration(value => value + 1)
          setSessionTurns(0)
          setUsage(initialSessionUsage)
          setEventHistory(initialTerminalEventHistory())
          setAgentTopology(initialAgentTopologyHistory())
          jumpToNewest()
          retireRuntime(previous)
        }
        setLocalReport({ id: nextId('profile-report'), title: 'Profile', eventKinds: [], render: () => result.message })
        selectView('local-profile-report')
        return
      }
      case 'edit-input':
        setEditor(outcome.text, graphemeCount(outcome.text))
        return
      case 'external-editor':
        await openExternalEditor()
        return
      case 'preferences': {
        await savePreferences(preferencePaths(metadata.workspace).workspacePath, outcome.patch)
        if (isAborted(signal)) return
        const next = { ...preferences, ...outcome.patch }
        setPreferences(next)
        setTranscript(state => appendSystemMessage(state,
          outcome.patch.locale === undefined ? translate(locale, 'pending')
            : translate(resolveLocale(next.locale), 'languageChanged', { locale: resolveLocale(next.locale) }),
          translate(locale, 'settings'), nextId('preferences')))
        return
      }
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
        queue.pause()
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
          const next = await restart({ ...preferences, ...outcome.selection }, signal)
          if (isAborted(signal) || !mountedRef.current) {
            await props.trackRuntimeClose(next.runtime).catch(() => undefined)
            return
          }
          const previous = props.runtimeRef.current
          props.runtimeRef.current = next.runtime
          setMetadata(next.metadata)
          setPreferences(value => ({ ...value, ...pickPreferences(outcome.selection) }))
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
        queue.pause()
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
  }, [finish, jumpToNewest, nextId, props.host, metadata.protocolVersion, retireRuntime, runHarnessPrompt, selectView, sessionId, preferences, locale, queue, switchModeInPlace])

  const runCommand = useCallback(async (raw: string): Promise<boolean> => {
    const parsed = parseTerminalCommand(raw)
    if (parsed === undefined) return false
    const command = props.host.resolveCommand(parsed.name)
    if (command === undefined) {
      setTranscript(state => appendSystemMessage(
        state,
        translate(locale, 'unknownCommand', { name: parsed.name }),
        'command',
        nextId('command'),
      ))
      if (inputRef.current.length === 0) setEditor(raw, graphemeCount(raw))
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
        if (inputRef.current.length === 0) setEditor(raw, graphemeCount(raw))
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
  }, [applyOutcome, commandContext, nextId, props.host, props.shutdownSignal, props.trackLocalTask, locale])

  const submit = useCallback(async (waitForModel = false): Promise<void> => {
    if (commandRunningRef.current || interruptingRef.current) return
    const raw = inputRef.current
    if (raw.trim().length === 0) return
    setEditor('', 0)
    setHistoryIndex(undefined)

    if (parseTerminalCommand(raw)?.name === 'queue') {
      const parsed = parseTerminalCommand(raw)
      const [action = 'list', id, ...text] = parsed?.args ?? []
      try {
        if (action === 'remove') queue.remove(Number(id))
        else if (action === 'edit') queue.edit(Number(id), text.join(' '))
        else if (action === 'withdraw') { const value = queue.withdraw(); if (value) setEditor(value, graphemeCount(value)) }
        else if (action === 'resume') { queue.resume(sessionRef.current); queueMicrotask(() => nextQueuedRef.current()) }
        else if (action !== 'list') throw new Error('usage: /queue [list|remove N|edit N text|withdraw|resume]')
        setQueueRevision(value => value + 1)
        const textValue = queue.list().map(item => `${item.id}. [${item.sessionId}] ${item.text}`).join('\n')
        setTranscript(state => appendSystemMessage(state, textValue || translate(locale, 'emptyQueue'), 'queue', nextId('queue')))
      } catch (error) { setTranscript(state => appendSystemMessage(state, pluginErrorMessage(error), 'queue', nextId('queue'))) }
      return
    }
    if (runningRef.current) {
      if (['language', 'sidebar'].includes(parseTerminalCommand(raw)?.name ?? '')) { await runCommand(raw); return }
      try {
        if (raw.startsWith('/') && !raw.startsWith('//')) throw new Error('Only /queue and /language commands are available while a prompt is running.')
        const text = raw.startsWith('//') ? raw.slice(1) : raw
        // Steering joins the turn already running; queueing waits for the next
        // one. Prefer steering when the runtime exposes it, and say which one
        // happened — the difference is the whole point of typing now.
        const bridge = props.runtimeRef.current.interaction
        if (bridge?.canSteer === true) {
          try {
            await bridge.steer(sessionRef.current, text)
            setTranscript(state => appendSystemMessage(
              state,
              locale === 'zh-CN'
                ? '已插入当前这一轮。模型会先跑完手上这一步，然后在下一步读到它——不会丢掉已经生成的内容。'
                : 'Added to the turn already running. The model finishes the step it is on, then reads this on the next one; nothing already generated is discarded.',
              locale === 'zh-CN' ? '插话' : 'steered',
              nextId('steer'),
            ))
            return
          } catch (error) {
            // Fall through to the queue, naming the downgrade rather than
            // pretending the message went into this turn.
            setTranscript(state => appendSystemMessage(
              state,
              `${pluginErrorMessage(error)}${locale === 'zh-CN' ? ' 已改为排队到下一轮。' : ' Queued for the next turn instead.'}`,
              locale === 'zh-CN' ? '插话失败' : 'steering unavailable',
              nextId('steer-failed'),
            ))
          }
        }
        queue.add(sessionRef.current, text)
        setQueueRevision(value => value + 1)
      } catch (error) {
        setEditor(raw, graphemeCount(raw))
        setTranscript(state => appendSystemMessage(state, pluginErrorMessage(error), 'queue', nextId('queue')))
      }
      return
    }

    if (raw.startsWith('/') && !raw.startsWith('//')) {
      await runCommand(raw)
      return
    }

    const prompt = raw.startsWith('//') ? raw.slice(1) : raw
    jumpToNewest()
    const task = runHarnessPrompt(prompt, prompt)
    if (waitForModel) await task
  }, [jumpToNewest, runCommand, runHarnessPrompt, queue, locale, nextId])

  nextQueuedRef.current = () => {
    if (!mountedRef.current || props.shutdownSignal.aborted || runningRef.current || commandRunningRef.current || interruptingRef.current) return
    const item = queue.take(sessionRef.current)
    if (item === undefined) return
    setQueueRevision(value => value + 1)
    void runHarnessPrompt(item.text, item.text)
  }

  usePaste(text => {
    if (props.runtimeRef.current.interaction?.current && !interactionHiddenRef.current) { cardRef.current?.paste(text); return }
    if (!commandRunningRef.current && !interruptingRef.current && activeViewRef.current === undefined) insertInput(text.replace(/\r\n?/g, '\n'))
  })

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
        && !stroke.key.meta && !stroke.key.ctrl
        && fileChoicesRef.current.length === 0
        && activeViewRef.current === undefined
        && !toolFocusRef.current
        && !runningRef.current
        && !commandRunningRef.current
      ) {
        if (completeFromMenu()) continue
        jumpToNewest()
        await submit(true)
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
    if (props.runtimeRef.current.interaction?.current) {
      if (!interactionHiddenRef.current) { cardRef.current?.key(keyInput, key); return }
      if (key.escape || key.return) { interactionHiddenRef.current = false; setInteractionHidden(false); return }
    }
    if (fileChoicesRef.current.length > 0) {
      if (key.escape) { chooseFiles([]); return }
      if (key.upArrow || key.downArrow || key.tab) {
        const length = fileChoicesRef.current.length
        const next = (fileIndexRef.current + (key.upArrow ? -1 : 1) + length) % length
        fileIndexRef.current = next; setFileIndex(next); return
      }
      if (key.return) {
        const path = fileChoicesRef.current[fileIndexRef.current]!
        setEditor(path, graphemeCount(path)); return
      }
      chooseFiles([])
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
      if (!toolFocusRef.current && /(?:^|\s)@(?:"[^"]*|[^\s]*)$/.test(inputRef.current)) {
        const previous = inputRef.current
        const task = completeFileReference(metadata.workspace, previous).then(matches => {
          if (props.shutdownSignal.aborted || inputRef.current !== previous) return
          if (matches.length === 1) setEditor(matches[0]!, graphemeCount(matches[0]!))
          else if (matches.length > 1) chooseFiles(matches)
          else setTranscript(state => appendSystemMessage(state, translate(locale, 'noMatches'), '@', nextId('files')))
        }).catch(error => { if (!props.shutdownSignal.aborted) setTranscript(state => appendSystemMessage(state, pluginErrorMessage(error), '@', nextId('files'))) })
        props.trackLocalTask(task)
        return
      }
      // The menu is transient and explicitly open, so it takes Tab from the
      // focus switch for as long as it is showing.
      if (completeFromMenu(true)) return
      if (!toolFocusRef.current && (!showTools || size.columns < TOOL_SIDEBAR_MIN_COLUMNS)) return
      const next = !toolFocusRef.current
      focusTools(next)
      if (next && selectedToolKeyRef.current === undefined) {
        selectTool(activityRowKeysRef.current.at(-1))
      }
      return
    }

    if (toolFocusRef.current) {
      if (key.leftArrow || key.rightArrow) {
        const next = sidebarPageRef.current === 'overview' ? 'tools' : 'overview'
        sidebarPageRef.current = next; setSidebarPage(next); return
      }
      if (key.escape) {
        focusTools(false)
        return
      }
      if (key.upArrow || key.downArrow) {
        if (sidebarPageRef.current === 'overview') { setOverviewOffset(value => Math.max(0, Math.min(120, value + (key.downArrow ? 1 : -1)))); return }
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

    if (commandRunningRef.current || interruptingRef.current) return

    // Modified Enter edits the draft before menus or submit can consume it.
    if ((key.ctrl && keyInput.toLowerCase() === 'j') || (key.meta && key.return)) {
      insertInput('\n')
      return
    }

    if (keyMatches(keyInput, key.ctrl, 'withdrawQueue', preferences)) {
      if (inputRef.current.length > 0) return
      const text = queue.withdraw()
      if (text !== undefined) setEditor(text, graphemeCount(text))
      setQueueRevision(value => value + 1)
      return
    }
    if (keyMatches(keyInput, key.ctrl, 'externalEditor', preferences)) {
      void openExternalEditor()
      return
    }

    if (menuOpen()) {
      if (key.escape) {
        menuDismissedRef.current = true
        setMenuDismissed(true)
        return
      }
      if (key.upArrow || key.downArrow) {
        // While the menu is open the arrows belong to it. History is reachable
        // again the moment the menu closes, and the menu is always on screen
        // when this applies, so the keys never silently mean two things.
        const count = currentSuggestions().length
        const next = (menuIndexRef.current + (key.downArrow ? 1 : count - 1)) % count
        menuIndexRef.current = next
        setMenuIndex(next)
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
    if (key.delete) {
      setEditor(sliceByGrapheme(inputRef.current, 0, cursorRef.current)
        + sliceByGrapheme(inputRef.current, cursorRef.current + 1), cursorRef.current)
      return
    }
    if (key.backspace) {
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
    if (key.home || (key.ctrl && keyInput.toLowerCase() === 'a')) {
      setEditor(inputRef.current, 0)
      return
    }
    if (key.end || (key.ctrl && keyInput.toLowerCase() === 'e')) {
      setEditor(inputRef.current, graphemeCount(inputRef.current))
      return
    }
    if (key.upArrow && history.length > 0) {
      const historyIndex = historyIndexRef.current
      if (historyIndex === undefined) historyDraftRef.current = { value: inputRef.current, cursor: cursorRef.current }
      const next = historyIndex === undefined ? history.length - 1 : Math.max(0, historyIndex - 1)
      const value = history[next] ?? ''
      setHistoryIndex(next)
      setEditor(value, graphemeCount(value))
      return
    }
    if (key.downArrow && historyIndexRef.current !== undefined) {
      const next = historyIndexRef.current + 1
      if (next >= history.length) {
        setHistoryIndex(undefined)
        setEditor(historyDraftRef.current.value, historyDraftRef.current.cursor)
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

  function currentSuggestions(): readonly CommandSuggestion[] {
    const commands = props.host.listCommands(locale)
      .filter(command => !runningRef.current || ['queue', 'language'].includes(command.name))
    return commandSuggestions(inputRef.current, commands, locale)
  }

  function menuOpen(): boolean {
    return !menuDismissedRef.current && currentSuggestions().length > 0
  }

  /**
   * Put the highlighted command in the prompt. Returns false when there is
   * nothing to complete — either the menu is closed, or the input already is
   * exactly that command, in which case the keystroke belongs to submitting.
   */
  function completeFromMenu(addSpace = false): boolean {
    if (!menuOpen()) return false
    const selected = currentSuggestions()[menuIndexRef.current]
    if (selected === undefined) return false
    const completed = `/${selected.name} `
    if (inputRef.current.trim().toLowerCase() === `/${selected.name}`.toLowerCase()
      && (!addSpace || inputRef.current.endsWith(' '))) return false
    setEditor(completed, graphemeCount(completed))
    return true
  }

  function setEditor(value: string, nextCursor: number): void {
    if (fileChoicesRef.current.length > 0) chooseFiles([])
    if (value.length > MAX_INPUT_CHARS) {
      setTranscript(state => appendSystemMessage(state, 'Input exceeds 262144 characters; use a file reference.', 'input', nextId('input-limit')))
      return
    }
    if (inputRef.current !== value) {
      menuIndexRef.current = 0; setMenuIndex(0)
      menuDismissedRef.current = false; setMenuDismissed(false)
    }
    inputRef.current = value
    cursorRef.current = nextCursor
    setInput(value)
    setCursor(nextCursor)
  }

  function insertInput(text: string): void {
    const edited = insertAtGrapheme(inputRef.current, cursorRef.current, text)
    setEditor(edited.value, edited.cursor)
  }

  function chooseFiles(choices: readonly string[]): void {
    fileChoicesRef.current = choices; setFileChoices(choices)
    fileIndexRef.current = 0; setFileIndex(0)
  }

  const status = useMemo(() => {
    const context = commandContext()
    return props.host.orderedStatusSegments()
      .flatMap(segment => {
        const value = renderStatusSegmentSafely(segment, context)
        return value ? [{ id: segment.id, text: uiLabel(locale, sanitizeTerminalText(value)) }] : []
      })
  }, [commandContext, props.host, locale])

  const currentView = activeView === 'local-profile-report' ? localReport : activeView === undefined ? undefined : props.host.resolveView(activeView)
  const viewEventRevision = currentView?.eventKinds === undefined ? eventHistory.total
    : currentView.eventKinds.map(kind => eventKindRevisions.current.get(kind) ?? 0).join(',')
  const currentViewText = useMemo(() => currentView === undefined ? undefined : renderViewSafely(currentView, viewContext()),
    [currentView, viewEventRevision, commandContext, composition, selectedToolKey, firstPartyViewRevision, agentTopology, transcript.droppedBlockCount])
  const suggestions = !interaction && fileChoices.length === 0 && currentView === undefined && !toolFocus && !menuDismissed
    ? currentSuggestions()
    : []
  // The menu competes with the transcript for rows, so it takes only what is
  // left after the chrome and a usable body. On a short terminal it shows
  // fewer entries rather than being clipped by the frame.
  const menuCapacity = Math.max(0, Math.min(8, size.rows - 7 - MIN_BODY_ROWS))
  const menuView = menuWindow(suggestions.length, menuCapacity, menuIndex)
  const visibleFileChoices = fileChoices.slice(Math.max(0, fileIndex - Math.max(0, menuCapacity - 1)), Math.max(0, fileIndex - Math.max(0, menuCapacity - 1)) + Math.max(1, menuCapacity))
  const menuRows = menuView.shown === 0
    ? 0
    : menuView.shown + (menuView.above > 0 ? 1 : 0) + (menuView.below > 0 ? 1 : 0)
  const cardRows = interaction && !interactionHidden ? Math.max(13, Math.min(18, size.rows - 10)) : 0
  const bodyRows = Math.max(1, size.rows - 7 - statusBarContentRows(size.columns) - menuRows - visibleFileChoices.length - cardRows - (interaction && interactionHidden ? 1 : 0))
  // A sidebar takes a fixed column count, never a share of the width, so the
  // transcript rewraps predictably. Below the threshold it collapses rather
  // than squeezing the transcript, per the narrow-terminal invariant.
  const sidebarVisible = showTools && size.columns >= TOOL_SIDEBAR_MIN_COLUMNS && currentView === undefined
  const transcriptWidth = Math.max(20, size.columns - (sidebarVisible ? TOOL_SIDEBAR_WIDTH : 0))
  const transcriptLayout = useMemo(() => {
    const blocks = agentWindows?.transcript(transcript.blocks, externalSessions.current) ?? transcript.blocks
    // Keep the original transcript for history/details and for terminals where
    // the sidebar is hidden. Wide chat omits a tool card only once the call has
    // succeeded, because the sidebar indexes it and its output is one keystroke
    // away. A running call is what the reader is watching, and a failed one is
    // the thing they must not have to go looking for — dropping every tool
    // block regardless of state hid both, and silently defeated the terminal
    // injection assertion that a renderer's output reaches the screen at all.
    const shown = sidebarVisible
      ? blocks.filter(block => block.kind !== 'tool' || block.state !== 'success')
      : blocks
    return transcriptLayoutCache.prepare(shown, transcriptWidth, locale)
  }, [transcriptLayoutCache, transcript.blocks, transcriptWidth, sidebarVisible, locale, agentWindows, agentWindowRevision])
  const visible = selectTranscriptPage(transcriptLayout, bodyRows, scrollAnchor)
  scrollNavigationRef.current = { layout: transcriptLayout, page: visible }
  const activity = sidebarVisible
    ? projectToolActivity(agentWindows ? eventHistory.items.filter(event => !agentWindows.separated('sessionId' in event ? event.sessionId : undefined) && !externalSessions.current.has('sessionId' in event ? event.sessionId ?? '' : '')) : eventHistory.items, sessionId)
    : undefined
  activityRowKeysRef.current = activity?.rows.map(row => row.key) ?? []
  const queuedCount = queue.list().length

  if (interaction && !interactionHidden && size.rows < 24) return <Box flexDirection="column" width={Math.max(20, size.columns)} height={Math.max(10, size.rows)}>
    <InteractionCard key={interaction.id} ref={cardRef} request={interaction} draft={interactionDraft} zh={locale === 'zh-CN'} width={size.columns} rows={Math.max(10, size.rows)} hidden={false}
      onHide={() => { interactionHiddenRef.current = true; setInteractionHidden(true) }} onAnswer={answerInteraction} />
  </Box>

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
        <Box flexDirection="column" flexGrow={1} width={transcriptWidth} overflow="hidden">
          {currentView === undefined && (visible.above > 0 || visible.below > 0) && (
            <Box flexShrink={0}>
              <Text dimColor wrap="truncate">{scrollNotice(visible, locale)}</Text>
            </Box>
          )}
          {currentView === undefined
            ? <TranscriptRows rows={visible.rows} />
            : <ViewPanel key={activeView === 'history' ? `${activeView}:${firstPartyViewRevision}` : currentView.id} title={uiLabel(locale, currentView.title)} text={currentViewText ?? ''} width={transcriptWidth} rows={bodyRows} arrowKeys={activeView !== 'history'} />}
        </Box>
        {activity !== undefined && (
          sidebarPage === 'overview' ? <OverviewSidebar context={commandContext()} clock={clock} width={TOOL_SIDEBAR_WIDTH} rows={bodyRows} focused={toolFocus} offset={overviewOffset} /> : <ToolActivitySidebar
            activity={activity}
            rows={bodyRows}
            droppedEvents={eventHistory.dropped}
            focused={toolFocus}
            selectedKey={selectedToolKey}
            locale={locale}
            context={commandContext()}
            clock={clock}
            plan={plan}
          />
        )}
      </Box>

      <StatusBar width={Math.max(20, size.columns)} phase={phase} locale={locale} segments={status}
        clock={clock} animation={preferences.animation} waiting={interaction !== undefined}
        mode={metadata.requestedPreferences?.mode ?? 'code'} queued={queuedCount} paused={queue.paused}
        usage={usage} telemetry={telemetry?.sessionId === sessionId ? telemetry : undefined}
        provider={metadata.provider} effort={metadata.requestedPreferences?.reasoningEffort} backend={metadata.backend ?? 'bundled'} />

      {interaction && <InteractionCard key={interaction.id} ref={cardRef} request={interaction} draft={interactionDraft} zh={locale === 'zh-CN'} width={size.columns} rows={cardRows || 13}
        hidden={interactionHidden} onHide={() => { interactionHiddenRef.current = true; setInteractionHidden(true) }} onAnswer={answerInteraction} />}
      {interactionHidden && interaction && <Text dimColor wrap="truncate">{locale === 'zh-CN' ? '问题已收起 · Enter / Esc 继续回答' : 'Question hidden · Enter / Esc to answer'}</Text>}
      {menuView.shown > 0 && (
        <CommandMenu
          suggestions={suggestions}
          view={menuView}
          selected={menuIndex}
          width={size.columns}
          locale={locale}
        />
      )}
      {visibleFileChoices.length > 0 && <Box flexDirection="column" flexShrink={0} paddingX={1}>
        {visibleFileChoices.map(path => <Text key={path} color={path === fileChoices[fileIndex] ? 'cyan' : undefined} wrap="truncate">{path === fileChoices[fileIndex] ? '› ' : '  '}{sanitizeTerminalText(path)}</Text>)}
      </Box>}

      <Box flexDirection="column" flexShrink={0} paddingX={1}>
        {currentView !== undefined
          ? <Text dimColor wrap="truncate">{activeView === 'history'
              ? translate(locale, 'historyHint')
              : translate(locale, 'returnToTranscript')}</Text>
          : <>
              <Text dimColor wrap="truncate">{fileChoices.length > 0 ? translate(locale, 'fileHint') : toolFocus
                ? sidebarPage === 'overview' ? locale === 'zh-CN' ? '↑↓ 滚动概览 · ←→ 切换工具 · Tab / Esc 返回' : '↑↓ scroll overview · ←→ tools · Tab / Esc return' : translate(locale, 'toolFocusHint')
                : phase === 'running'
                  ? `${translate(locale, 'busyHint')} · ${translate(locale, 'queued', { count: queuedCount })}`
                  : commandBusy ? translate(locale, 'localBusy')
                    // The arrows and Tab mean something different while the
                    // menu is open, so the line says which meaning is live
                    // rather than leaving the reader to discover it.
                    : menuView.shown > 0
                      ? translate(locale, 'menuHint')
                      : translate(locale, 'inputHint')}</Text>
              <Text wrap="truncate">{renderEditor(input, cursor, commandBusy, Math.max(1, size.columns - 2))}</Text>
            </>}
      </Box>
    </Box>
  )
}

export interface ParsedTerminalCommand {
  name: string
  args: readonly string[]
}

import { splitKeystrokes, type InputKey, type Keystroke } from './input-controller.js'
export { splitKeystrokes, type InputKey, type Keystroke } from './input-controller.js'

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
function scrollNotice(visible: TranscriptPage, locale: Locale): string {
  if (locale === 'zh-CN') return `第 ${visible.start + 1}–${visible.start + visible.rows.length} / ${visible.start + visible.rows.length + visible.below} 行 · ${visible.below > 0
    ? 'PageUp 上翻 · PageDown 下翻至最新' : 'PageUp 查看前文'}`
  return `${visible.above} older above · ${visible.below > 0
    ? `${visible.below} newer below · PageDown to catch up` : 'PageUp for older'} (rows)`
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
 * Command names come from the registry. Known preference/diff arguments offer
 * inert text choices; other arguments and `//literal` prompts stay untouched.
 */
export function commandSuggestions(
  input: string,
  commands: readonly { name: string; aliases: readonly string[]; summary: string }[],
  locale: Locale = 'en',
): readonly CommandSuggestion[] {
  if (!input.startsWith('/') || input.startsWith('//')) return []
  if (/\s/.test(input)) {
    const name = input.slice(1).split(/\s/, 1)[0]?.toLowerCase()
    return commands.some(command => command.name === name) ? commandArgumentChoices(input, locale) : []
  }
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

function CommandMenu({ suggestions, view, selected, width, locale }: {
  suggestions: readonly CommandSuggestion[]
  view: { offset: number; shown: number; above: number; below: number }
  selected: number
  width: number
  locale: Locale
}): React.ReactElement {
  const nameWidth = Math.max(...suggestions.map(item => item.name.length + 1))
  const visible = suggestions.slice(view.offset, view.offset + view.shown)
  return (
    <Box flexDirection="column" flexShrink={0} paddingX={1}>
      {view.above > 0 && (
        <Box flexShrink={0}>
          <Text dimColor>{`↑ ${translate(locale, 'moreChoices', { count: view.above })}`}</Text>
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
          <Text dimColor>{`↓ ${translate(locale, 'moreChoices', { count: view.below })}`}</Text>
        </Box>
      )}
    </Box>
  )
}

function ToolActivitySidebar({ activity, rows, droppedEvents, focused, selectedKey, locale = 'en', context, clock, plan }: {
  activity: ToolActivityProjection
  rows: number
  droppedEvents: number
  focused: boolean
  selectedKey?: string
  locale?: Locale
  context: TerminalCommandContext
  clock: SessionClock
  plan?: readonly string[] | undefined
}): React.ReactElement {
  const inner = TOOL_SIDEBAR_WIDTH - 3
  // Keep the unfocused sidebar short; focus exposes the full retained list.
  const notes = droppedEvents > 0 ? 4 : 3
  // The plan takes at most a third of the column: it is context for the work,
  // not a replacement for watching the work.
  const planRows = plan === undefined ? 0 : Math.min(plan.length + 1, Math.max(0, Math.floor(rows / 3)))
  const statsRows = Math.min(5, Math.max(0, rows - notes - planRows - 1))
  const selectedIndex = selectedKey === undefined
    ? -1
    : activity.rows.findIndex(row => row.key === selectedKey)
  // Which entry is selected is stated in words, not carried by highlight alone.
  const heading = locale === 'zh-CN' ? `← 概览 / 工具${focused ? ` ${selectedIndex + 1}/${activity.rows.length}` : ''}` : focused
    ? `tools · focus ${selectedIndex < 0 ? '-' : selectedIndex + 1}/${activity.rows.length}`
    : 'tools'
  const capacity = Math.max(1, Math.min(rows - notes - statsRows - planRows, focused ? Infinity : 6))
  const start = !focused || selectedIndex < 0 ? Math.max(0, activity.rows.length - capacity) : Math.max(0, Math.min(selectedIndex, activity.rows.length - capacity))
  const visible = activity.rows.slice(start, start + capacity)
  return (
    <Box flexDirection="column" flexShrink={0} width={TOOL_SIDEBAR_WIDTH} borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} paddingX={1} overflow="hidden">
      <Box flexShrink={0}>
        <Text bold={focused} color={focused ? 'cyan' : undefined} wrap="truncate">{cropTerminalText(heading, inner)}</Text>
      </Box>
      {planRows > 0 && plan !== undefined && (
        <Box flexDirection="column" flexShrink={0}>
          <Text dimColor wrap="truncate">{locale === 'zh-CN' ? '计划' : 'plan'}</Text>
          {plan.slice(0, planRows - 1).map((step, index) => (
            <Text key={index} wrap="truncate">{cropTerminalText(`${index + 1} ${sanitizeTerminalText(step)}`, inner)}</Text>
          ))}
        </Box>
      )}
      {visible.map(row => (
        <Box key={row.key} flexShrink={0}>
          <Text
            color={row.state === 'success' ? undefined : activityColor(row.state)}
            dimColor={row.state === 'success' && row.key !== selectedKey}
            inverse={row.key === selectedKey}
            wrap="truncate"
          >{formatActivityRow(row, inner, true)}</Text>
        </Box>
      ))}
      <Box flexGrow={1} />
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate">{cropTerminalText(formatActivityCounts(activity.counts, locale), inner)}</Text>
      </Box>
      {droppedEvents > 0 && (
        <Box flexShrink={0}>
          <Text dimColor wrap="truncate">{cropTerminalText(locale === 'zh-CN' ? '部分旧记录已裁剪 · /trace' : 'Older records trimmed · /trace', inner)}</Text>
        </Box>
      )}
      {statsRows > 0 && <ToolSidebarStats context={context} clock={clock} rows={statsRows} />}
      <Box flexShrink={0}><Text dimColor wrap="truncate">/status · /context</Text></Box>
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

function renderEditor(value: string, cursor: number, disabled: boolean, width: number): string {
  if (disabled) return '…'
  const before = sanitizeTerminalText(sliceByGrapheme(value, 0, cursor))
  const currentGrapheme = graphemeAt(value, cursor)
  const current = currentGrapheme === undefined ? ' ' : sanitizeTerminalText(currentGrapheme)
  const after = sanitizeTerminalText(sliceByGrapheme(value, cursor + (currentGrapheme === undefined ? 0 : 1)))
  const left = before.replaceAll('\n', ' ↵ ')
  const right = after.replaceAll('\n', ' ↵ ')
  const currentText = current.replaceAll('\n', '↵')
  const budget = Math.max(0, width - 3 - terminalCellWidth(currentText))
  const rightBudget = Math.min(terminalCellWidth(right), Math.floor(budget / 3))
  const leftBudget = budget - rightBudget
  const compactBefore = terminalCellWidth(left) <= leftBudget ? left : `…${suffixByCells(left, Math.max(0, leftBudget - 1))}`
  const compactAfter = cropTerminalText(right, rightBudget)
  return `❯ ${compactBefore}▌${currentText}${compactAfter}`
}

function renderViewSafely(view: TerminalViewSpec, context: TerminalViewContext): string {
  try {
    return view.render(view.eventKinds === undefined ? context : { ...context, events: context.events.filter(event => view.eventKinds!.includes(event.kind)) })
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
