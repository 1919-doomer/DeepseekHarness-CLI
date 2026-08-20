import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  HarnessClient,
  type HarnessClientOptions,
  type HarnessNotification,
} from '@deepseek-ai/dsh-sdk-client'
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
  workspace?: string
  provider?: string
  model?: string
  maxTokens?: number
  configPath?: string
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
}

export interface RunActivityResult {
  sessionId: string
  messageId: string
  finalResponse: string
  events: NormalizedEvent[]
  notifications: HarnessNotification[]
  projection: ProjectionState
}

type RuntimeLifecycleState = 'idle' | 'starting' | 'running' | 'closing' | 'closed'

export class HarnessRuntime {
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

  constructor(private readonly options: HarnessRuntimeOptions = {}) {
    this.workspace = resolve(options.workspace ?? process.cwd())
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.maxTokens = validateMaxTokens(options.maxTokens)
    this.defaultActivityTimeoutMs = positiveTimeout(options.activityTimeoutMs, 10 * 60_000, 'activityTimeoutMs')
    // Capture the environment semantics that startup intends to give the child.
    // Once launch resolution completes this is replaced by a snapshot of the
    // exact resolved launch env, so child diagnostics and redaction cannot drift.
    this.diagnosticEnv = { ...effectiveRuntimeEnvironment({
      workspace: this.workspace,
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
    if (input.length === 0) {
      throw new DshcRuntimeError('Prompt must not be empty.', 'configuration')
    }
    await this.start()
    const client = this.client
    if (client === undefined) throw new DshcRuntimeError('Harness runtime did not initialize a client.', 'runtime')

    const sessionId = options.sessionId ?? `session-${randomUUID().replaceAll('-', '')}`
    const activityTimeoutMs = positiveTimeout(
      options.activityTimeoutMs,
      this.defaultActivityTimeoutMs,
      'activityTimeoutMs',
    )
    const subscription = client.subscribeSessionTree(sessionId)
    const projector = new SessionProjector(sessionId)
    const events: NormalizedEvent[] = []
    const notifications: HarnessNotification[] = []

    try {
      const messageId = await client.prompt(sessionId, [{ type: 'text', text: input }])
      let receiptObserved = false
      let deadline = Date.now() + activityTimeoutMs

      while (true) {
        const notification = await nextBeforeDeadline(subscription.next(), deadline, activityTimeoutMs)
        if (!receiptObserved) {
          if (!isInboxReceipt(notification, sessionId, messageId)) continue
          receiptObserved = true
          // `activityTimeoutMs` is documented as receipt-to-idle. Waiting for
          // the durable receipt is bounded by the same value, then the activity
          // receives a fresh full window once ownership is proven.
          deadline = Date.now() + activityTimeoutMs
        }

        notifications.push(notification)
        options.onNotification?.(notification)
        const event = projector.ingest(notification)
        events.push(event)
        options.onEvent?.(event, notification)

        if (
          notification.method === 'session.status'
          && notification.params.sessionId === sessionId
          && notification.params.status === 'idle'
        ) {
          break
        }
      }

      return {
        sessionId,
        messageId,
        finalResponse: projector.state.lastAssistantMessage,
        events,
        notifications,
        projection: projector.state,
      }
    } catch (error) {
      throw classifyRuntimeError(error, this.diagnosticEnv)
    } finally {
      subscription.close()
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

      const launch = await resolveRuntimeLaunch({
        workspace: this.workspace,
        configPath: this.options.configPath,
        env: this.options.env,
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
      })
      this.assertStartupStillOwned()
      assertRuntimeIdentity(initialized.serverInfo)

      const metadata: HarnessRuntimeMetadata = {
        workspace: this.workspace,
        provider: this.provider,
        model: this.model,
        serverName: initialized.serverInfo.name,
        protocolVersion: initialized.serverInfo.version,
        ...(versions === undefined ? {} : {
          sdkVersion: versions.sdkVersion,
          runtimePackageVersion: versions.runtimePackageVersion,
        }),
      }
      this.metadataValue = metadata
      this.lifecycle = 'running'
      return metadata
    } catch (error) {
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

async function nextBeforeDeadline<T>(promise: Promise<T>, deadline: number, totalTimeoutMs: number): Promise<T> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new ActivityTimeoutError(totalTimeoutMs)

  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ActivityTimeoutError(totalTimeoutMs)), remaining)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
