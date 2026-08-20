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
import { resolveRuntimeLaunch } from './runtime-launcher.js'

export interface HarnessRuntimeOptions {
  workspace?: string
  provider?: string
  model?: string
  maxTokens?: number
  configPath?: string
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

  constructor(private readonly options: HarnessRuntimeOptions = {}) {
    this.workspace = resolve(options.workspace ?? process.cwd())
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.maxTokens = validateMaxTokens(options.maxTokens)
    this.defaultActivityTimeoutMs = positiveTimeout(options.activityTimeoutMs, 10 * 60_000, 'activityTimeoutMs')
  }

  get metadata(): HarnessRuntimeMetadata | undefined {
    return this.metadataValue
  }

  async start(): Promise<HarnessRuntimeMetadata> {
    if (this.closeTask !== undefined) {
      throw new DshcRuntimeError('Harness runtime is already closing or closed.', 'runtime')
    }
    this.startTask ??= this.performStart()
    return this.startTask
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
    const deadline = Date.now() + activityTimeoutMs
    const subscription = client.subscribeSessionTree(sessionId)
    const projector = new SessionProjector()
    const events: NormalizedEvent[] = []
    const notifications: HarnessNotification[] = []

    try {
      const messageId = await client.prompt(sessionId, [{ type: 'text', text: input }])
      let receiptObserved = false

      while (true) {
        const notification = await nextBeforeDeadline(subscription.next(), deadline, activityTimeoutMs)
        if (!receiptObserved) {
          if (!isInboxReceipt(notification, sessionId, messageId)) continue
          receiptObserved = true
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
      throw classifyRuntimeError(error, this.options.env ?? process.env)
    } finally {
      subscription.close()
    }
  }

  close(): Promise<void> {
    this.closeTask ??= this.performClose()
    return this.closeTask
  }

  private async performStart(): Promise<HarnessRuntimeMetadata> {
    let versions: InstalledDshVersions | undefined
    let client: HarnessClient | undefined
    try {
      await assertWorkspace(this.workspace)
      if (!this.options.skipInstalledVersionCheck) {
        versions = await readInstalledDshVersions()
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
      client = new HarnessClient(launch)
      this.client = client
      client.start()
      const initialized = await client.initialize({
        cwd: this.workspace,
        provider: this.provider,
        model: this.model,
        ...(this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens }),
      })
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
      return metadata
    } catch (error) {
      this.startTask = undefined
      if (client !== undefined) {
        try {
          await client.close()
        } catch {
          // Preserve the original start failure; close is best effort here.
        }
      }
      this.client = undefined
      throw classifyRuntimeError(error, this.options.env ?? process.env)
    }
  }

  private async performClose(): Promise<void> {
    const client = this.client
    this.client = undefined
    this.metadataValue = undefined
    if (client === undefined) return
    try {
      await client.close()
    } catch (error) {
      throw classifyRuntimeError(error, this.options.env ?? process.env)
    }
  }
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
