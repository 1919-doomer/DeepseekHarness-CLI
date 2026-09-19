import { randomUUID } from 'node:crypto'
import { InteractionBridge } from './interaction.js'
import { setImmediate as yieldEventLoop } from 'node:timers/promises'
import { EventTail } from './event-tail.js'
import { ActivityMeter, type ActivityMetrics } from './activity-metrics.js'
import type { Preferences, ResolvedPreferences } from '../preferences.js'
import type { ProfileFacts } from './dsh-profile.js'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  HarnessClient,
  type HarnessClientOptions,
  type HarnessNotification,
} from '@deepseek-ai/dsh-sdk-client'
import {
  MAX_RETAINED_ACTIVITY_EVENTS,
  MAX_RETAINED_ACTIVITY_NOTIFICATIONS,
  retainHarnessNotification,
  retainNormalizedEvent,
} from '../retention.js'
import {
  SessionProjector,
  isInboxReceipt,
  type NormalizedEvent,
  type ProjectionState,
} from '../session/projection.js'
import {
  assertInstalledCompatibility,
  assertRuntimeIdentity,
  readInstalledDshVersions,
  type InstalledDshVersions,
} from './compatibility.js'
import {
  ActivityTimeoutError,
  DshcRuntimeError,
  classifyRuntimeError,
} from './errors.js'
import { effectiveRuntimeEnvironment, resolveRuntimeLaunch } from './runtime-launcher.js'

export interface HarnessRuntimeOptions {
  preferenceSources?: ResolvedPreferences['sources']
  preferences?: Partial<Preferences>
  workspace?: string
  provider?: string
  model?: string
  maxTokens?: number
  configPath?: string
  patchPaths?: readonly string[]
  moduleBasePath?: string
  devMode?: boolean
  /** Incremental environment patch for the default Harness child launch. */
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  activityTimeoutMs?: number
  shutdownTimeoutMs?: number
  disposeEofGraceMs?: number
  disposeGraceMs?: number
  launchOverride?: HarnessClientOptions
  skipInstalledVersionCheck?: boolean
}

export interface HarnessRuntimeMetadata {
  interaction?: { available: boolean }
  preferenceSources?: ResolvedPreferences['sources']
  lastActivityMetrics?: ActivityMetrics
  backend?: 'bundled' | 'dsh-profile'
  profile?: ProfileFacts
  requestedPreferences?: Partial<Preferences>
  workspace: string
  provider: string
  model: string
  serverName: string
  protocolVersion: string
  sdkVersion?: string
  runtimePackageVersion?: string
}

export interface RunActivityOptions {
  sessionId?: string
  onEvent?: (event: NormalizedEvent, notification: HarnessNotification) => void
  onNotification?: (notification: HarnessNotification) => void
  activityTimeoutMs?: number
  /**
   * False for a session no person is watching, such as an operation review.
   * It is then kept out of the interaction bridge entirely: it cannot raise a
   * question, and starting it does not clear the plan another session shows.
   */
  interactive?: boolean
}

export interface RunActivityResult {
  metrics?: ActivityMetrics
  sessionId: string
  messageId: string
  finalResponse: string
  /** Retained diagnostic tail; `eventCount` is the exact observed total. */
  events: NormalizedEvent[]
  eventCount: number
  droppedEventCount: number
  /** Retained diagnostic tail; `notificationCount` is the exact observed total. */
  notifications: HarnessNotification[]
  notificationCount: number
  droppedNotificationCount: number
  projection: ProjectionState
}

type RuntimeLifecycleState = 'idle' | 'starting' | 'running' | 'closing' | 'closed'

export class HarnessRuntime {
  interaction?: InteractionBridge
  enableInteraction(): void {
    if (!this.startTask) this.interaction ??= new InteractionBridge()
  }
  private readonly workspace: string
  private readonly provider: string
  private readonly model: string
  private readonly maxTokens: number | undefined
  private readonly defaultActivityTimeoutMs: number
  private client: HarnessClient | undefined
  private metadataValue: HarnessRuntimeMetadata | undefined
  private startTask: Promise<HarnessRuntimeMetadata> | undefined
  private closeTask: Promise<void> | undefined
  private lifecycle: RuntimeLifecycleState = 'idle'
  private diagnosticEnv: NodeJS.ProcessEnv
  private readonly activeSessions = new Set<string>()
  private readonly indeterminateSessions = new Set<string>()

  constructor(private readonly options: HarnessRuntimeOptions = {}) {
    this.workspace = resolve(options.workspace ?? process.cwd())
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-flash'
    this.maxTokens = validateMaxTokens(options.maxTokens)
    this.defaultActivityTimeoutMs = positiveTimeout(options.activityTimeoutMs, 10 * 60_000, 'activityTimeoutMs')
    // Capture the environment semantics that startup intends to give the child.
    // Once launch resolution completes this is replaced by a snapshot of the
    // exact resolved launch env, so child diagnostics and redaction cannot drift.
    this.diagnosticEnv = { ...effectiveRuntimeEnvironment({
      preferences: options.preferences,
      workspace: this.workspace,
      patchPaths: options.patchPaths,
      moduleBasePath: options.moduleBasePath,
      devMode: options.devMode,
      env: options.env,
      override: options.launchOverride,
    }) }
  }

  get metadata(): HarnessRuntimeMetadata | undefined {
    return this.metadataValue
  }

  async start(): Promise<HarnessRuntimeMetadata> {
    if (this.lifecycle === 'closing' || this.lifecycle === 'closed') {
      throw runtimeClosingError()
    }
    if (this.startTask !== undefined) return this.startTask

    this.lifecycle = 'starting'
    const task = this.performStart()
    this.startTask = task
    return task
  }

  async run(input: string, options: RunActivityOptions = {}): Promise<RunActivityResult> {
    const meter = new ActivityMeter()
    if (input.length === 0) {
      throw new DshcRuntimeError('Prompt must not be empty.', 'configuration')
    }
    const sessionId = options.sessionId ?? `session-${randomUUID().replaceAll('-', '')}`
    const activityTimeoutMs = positiveTimeout(
      options.activityTimeoutMs,
      this.defaultActivityTimeoutMs,
      'activityTimeoutMs',
    )
    if (this.activeSessions.has(sessionId)) {
      throw new DshcRuntimeError(
        `Session ${sessionId} already has an active request; protocol 0.0.1 cannot correlate concurrent same-session completion.`,
        'runtime',
      )
    }
    if (this.indeterminateSessions.has(sessionId)) {
      throw new DshcRuntimeError(
        `Session ${sessionId} cannot be reused because its previous request ended without an observed idle state; start a new session or restart the runtime.`,
        'runtime',
      )
    }

    // Completion is session-level idle, not message-level. Own this session
    // before the first await so two callers cannot both cross startup and then
    // subscribe/prompt concurrently.
    this.activeSessions.add(sessionId)
    let promptAttempted = false
    let idleObserved = false
    const bridge = options.interactive === false ? undefined : this.interaction
    try {
      await this.start()
      bridge?.begin(sessionId)
      const client = this.client
      if (client === undefined) throw new DshcRuntimeError('Harness runtime did not initialize a client.', 'runtime')

      const subscription = client.subscribeSessionTree(sessionId)
      const projector = new SessionProjector(sessionId)
      const eventHistory = new EventTail<NormalizedEvent>(MAX_RETAINED_ACTIVITY_EVENTS)
      const notificationHistory = new EventTail<HarnessNotification>(MAX_RETAINED_ACTIVITY_NOTIFICATIONS)
      let nextYield = performance.now() + 8

      try {
        promptAttempted = true
        const messageId = await client.prompt(sessionId, [{ type: 'text', text: input }])
        let receiptObserved = false
        let deadline = Date.now() + activityTimeoutMs
        let waitBaseline = bridge?.waitingMs ?? 0

        while (true) {
          const notification = await nextBeforeDeadline(subscription.next(), deadline, activityTimeoutMs, bridge, waitBaseline)
          if (!receiptObserved) {
            if (!isInboxReceipt(notification, sessionId, messageId)) continue
            receiptObserved = true
            // `activityTimeoutMs` is documented as receipt-to-idle. Waiting for
            // the durable receipt is bounded by the same value, then the activity
            // receives a fresh full window once ownership is proven.
            deadline = Date.now() + activityTimeoutMs
            waitBaseline = bridge?.waitingMs ?? 0
          }

          const rootIdle = notification.method === 'session.status'
            && notification.params.sessionId === sessionId
            && notification.params.status === 'idle'
          if (rootIdle) idleObserved = true

          // Protocol processing and projection always see the complete value.
          // Retention happens only after callbacks/projector have consumed it, so
          // local memory budgets can never backpressure or truncate Harness truth.
          options.onNotification?.(notification)
          const event = projector.ingest(notification)
          if (event.kind === 'tool-call') bridge?.expectCall(event.sessionId, event.callId, event.name)
          meter.observe(event)
          options.onEvent?.(event, notification)

          notificationHistory.push(retainHarnessNotification(notification))
          eventHistory.push(retainNormalizedEvent(event))

          if (rootIdle) break
          if (performance.now() >= nextYield) { await yieldEventLoop(); nextYield = performance.now() + 8 }
        }

        const metrics = meter.snapshot()
        if (this.metadataValue) this.metadataValue = { ...this.metadataValue, lastActivityMetrics: metrics }
        return {
          metrics,
          sessionId,
          messageId,
          finalResponse: projector.state.lastAssistantMessage,
          events: eventHistory.snapshot(),
          eventCount: eventHistory.total,
          droppedEventCount: eventHistory.dropped,
          notifications: notificationHistory.snapshot(),
          notificationCount: notificationHistory.total,
          droppedNotificationCount: notificationHistory.dropped,
          projection: projector.state,
        }
      } finally {
        bridge?.end(sessionId)
        subscription.close()
      }
    } catch (error) {
      // Once a prompt may have crossed the transport, an exception before the
      // root idle boundary leaves upstream work un-cancellable and its eventual
      // events unowned. Quarantine only that session; other sessions may still
      // be used, and a whole-runtime restart provides the recovery boundary.
      if (promptAttempted && !idleObserved) this.indeterminateSessions.add(sessionId)
      throw classifyRuntimeError(error, this.diagnosticEnv)
    } finally {
      this.activeSessions.delete(sessionId)
    }
  }

  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask

    // Closing is a lifecycle decision, not merely a snapshot of the currently
    // published client. Once requested, startup may never publish a successful
    // runtime later. performClose() closes both an already-published client and
    // any client that becomes visible while the in-flight start task unwinds.
    this.lifecycle = 'closing'
    const task = this.performClose()
    this.closeTask = task
    return task
  }

  private async performStart(): Promise<HarnessRuntimeMetadata> {
    let versions: InstalledDshVersions | undefined
    let client: HarnessClient | undefined
    try {
      await assertWorkspace(this.workspace)
      this.assertStartupStillOwned()

      if (!this.options.skipInstalledVersionCheck) {
        versions = await readInstalledDshVersions()
        this.assertStartupStillOwned()
        assertInstalledCompatibility(versions)
      }

      const interactionEnv = await this.interaction?.start()
      this.assertStartupStillOwned()
      const launch = await resolveRuntimeLaunch({
        preferences: this.options.preferences,
        workspace: this.workspace,
        configPath: this.options.configPath,
        patchPaths: this.options.patchPaths,
        moduleBasePath: this.options.moduleBasePath,
        devMode: this.options.devMode,
        env: { ...this.options.env, ...interactionEnv },
        requestTimeoutMs: this.options.requestTimeoutMs,
        shutdownTimeoutMs: this.options.shutdownTimeoutMs,
        disposeEofGraceMs: this.options.disposeEofGraceMs,
        disposeGraceMs: this.options.disposeGraceMs,
        override: this.options.launchOverride,
      })
      this.assertStartupStillOwned()

      // HarnessClient launches with `launch.env` when provided and otherwise
      // inherits `process.env`. Snapshot that exact effective environment before
      // start so stderr/transport errors are scrubbed against what the child saw.
      this.diagnosticEnv = { ...(launch.env ?? process.env) }
      client = new HarnessClient(launch)
      this.client = client
      client.start()
      const initialized = await client.initialize({
        cwd: this.workspace,
        provider: this.provider,
        model: this.model,
        ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
        ...(launch.profileFacts === undefined || this.options.preferences?.reasoningEffort === undefined ? {} : { reasoningEffort: this.options.preferences.reasoningEffort }),
      })
      this.assertStartupStillOwned()
      assertRuntimeIdentity(initialized.serverInfo)

      const metadata: HarnessRuntimeMetadata = {
        interaction: { available: this.interaction?.ready ?? false },
        ...(this.options.preferenceSources === undefined ? {} : { preferenceSources: this.options.preferenceSources }),
        backend: launch.profileFacts === undefined ? 'bundled' : 'dsh-profile',
        ...(launch.profileFacts === undefined ? {} : { profile: launch.profileFacts }),
        workspace: this.workspace,
        provider: this.provider,
        model: this.model,
        serverName: initialized.serverInfo.name,
        protocolVersion: initialized.serverInfo.version,
        ...(versions === undefined ? {} : {
          sdkVersion: versions.sdkVersion,
          runtimePackageVersion: launch.profileFacts?.sdkServerVersion ?? versions.runtimePackageVersion,
        }),
      }
      this.metadataValue = metadata
      if (this.options.preferences !== undefined) metadata.requestedPreferences = this.options.preferences
      this.lifecycle = 'running'
      return metadata
    } catch (error) {
      await this.interaction?.close()
      this.metadataValue = undefined
      if (client !== undefined && this.client === client) {
        this.client = undefined
        try {
          await client.close()
        } catch {
          // Preserve the original start failure; close is best effort here.
        }
      }

      if (this.lifecycle !== 'closing' && this.lifecycle !== 'closed') {
        // Ordinary startup failures remain retryable, matching the previous
        // public behavior. A close request is terminal and never resets start.
        this.lifecycle = 'idle'
        this.startTask = undefined
      }
      throw classifyRuntimeError(error, this.diagnosticEnv)
    }
  }

  private async performClose(): Promise<void> {
    await this.interaction?.close()
    const inFlightStart = this.startTask
    let firstFailure: unknown

    const closePublishedClient = async (): Promise<void> => {
      const client = this.client
      this.client = undefined
      if (client === undefined) return
      try {
        await client.close()
      } catch (error) {
        firstFailure ??= error
      }
    }

    try {
      // If startup has already published/started a client, close it now so an
      // initialize request does not hold signal shutdown open unnecessarily.
      await closePublishedClient()

      // A start that was still in workspace/version/launch resolution when the
      // close arrived must be allowed to observe `closing` and unwind. Awaiting
      // that exact task prevents a late publication from escaping cleanup.
      if (inFlightStart !== undefined) {
        await inFlightStart.catch(() => undefined)
      }

      // Cover the narrow case where startup published between the first client
      // snapshot and observing the close request.
      await closePublishedClient()
    } finally {
      this.metadataValue = undefined
      this.lifecycle = 'closed'
    }

    if (firstFailure !== undefined) {
      throw classifyRuntimeError(firstFailure, this.diagnosticEnv)
    }
  }

  private assertStartupStillOwned(): void {
    if (this.lifecycle === 'closing' || this.lifecycle === 'closed') {
      throw runtimeClosingError()
    }
  }
}

function runtimeClosingError(): DshcRuntimeError {
  return new DshcRuntimeError('Harness runtime is already closing or closed.', 'runtime')
}

async function assertWorkspace(workspace: string): Promise<void> {
  let info
  try {
    info = await stat(workspace)
  } catch (error) {
    throw new DshcRuntimeError(`Workspace does not exist: ${workspace}`, 'configuration', {
      cause: error instanceof Error ? error : undefined,
    })
  }
  if (!info.isDirectory()) {
    throw new DshcRuntimeError(`Workspace is not a directory: ${workspace}`, 'configuration')
  }
}

function validateMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DshcRuntimeError('maxTokens must be a positive safe integer.', 'configuration')
  }
  return value
}

function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new DshcRuntimeError(`${name} must be a positive safe integer.`, 'configuration')
  }
  return result
}

async function nextBeforeDeadline<T>(promise: Promise<T>, deadline: number, totalTimeoutMs: number, bridge?: InteractionBridge, waitBaseline = 0): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let unsubscribe: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        const schedule = (): void => {
          clearTimeout(timer)
          if (bridge?.current) return
          const remaining = deadline + (bridge?.waitingMs ?? 0) - waitBaseline - Date.now()
          timer = setTimeout(() => reject(new ActivityTimeoutError(totalTimeoutMs)), Math.max(0, remaining))
        }
        unsubscribe = bridge?.subscribe(schedule)
        schedule()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    unsubscribe?.()
  }
}
