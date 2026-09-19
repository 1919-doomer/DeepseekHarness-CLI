import { resolve } from 'node:path'
import { installSignalHandlers } from '../lifecycle/signals.js'
import { PlainRenderer } from '../terminal/plain-renderer.js'
import { runTerminalProduct } from '../terminal/product.js'
import {
  forkComposition,
  readCompositionSummary,
  resolveComposition,
  workspaceCompositionPath,
  type CompositionSummary,
  type ResolvedComposition,
} from '../upstream/composition.js'
import { defaultRuntimeConfigPath, defaultRuntimeDevPatchPath, defaultRuntimeInstallAnchor } from '../upstream/runtime-launcher.js'
import {
  installWorkspacePlugin,
  resolveDeepseekPlugin,
  searchDeepseekPlugins,
} from '../upstream/plugin-management.js'
import { sanitizeTerminalText, stringifyTerminalSafeJson } from '../terminal/sanitize.js'
import { classifyRuntimeError, DshcRuntimeError } from '../upstream/errors.js'
import { HarnessRuntime } from '../upstream/runtime.js'
import { DSHC_VERSION } from '../version.js'
import { JsonlHistoryReader } from '../history/reader.js'
import { HistoryWorkbench } from '../plugins/history.js'
import { parseCliArgs, type CliOptions } from './args.js'
import { cliHelp } from './help.js'
import { collectDoctorReport, doctorExitCode, renderDoctorHuman, shellTempRootFacts, type DoctorFinding } from './doctor.js'
import { renderSessionLogs } from './logs.js'
import { defaultSessionRoot } from '../upstream/session-log.js'
import { runInteractiveLoop } from './interactive.js'
import { DEV_MODE_WARNING } from '../workbench/contract.js'
import { pickPreferences, preferencePaths, resolvePreferences, savePreferences } from '../preferences.js'
import { resolveLocale, translate } from '../i18n.js'
import { ProfileManager, type BundleAction, type BundlePreview } from '../upstream/profile-manager.js'

const MAX_STDIN_BYTES = 4 * 1024 * 1024

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options: CliOptions
  try {
    options = parseCliArgs(argv)
    const preferences = await resolvePreferences(options.workspace ?? process.cwd(), pickPreferences(options))
    options = { ...options, ...preferences.values, preferenceSources: preferences.sources }
    validateModeOptions(options)
  } catch (error) {
    writeError(error)
    return 1
  }

  if (options.help) {
    process.stdout.write(cliHelp(resolveLocale(options.locale)))
    process.stdout.write(`\n${translate(resolveLocale(options.locale), 'helpPreferences')}\n`)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${DSHC_VERSION}\n`)
    return 0
  }
  if (options.command === 'doctor') return runDoctorCommand(options)
  if (options.command === 'logs') return runLogsCommand(options)

  if (shouldRunInteractive(options)) return runInteractiveMode(options)

  let prompt = options.prompt
  if (prompt === undefined && !process.stdin.isTTY) {
    try {
      prompt = await readPromptFromStdin()
    } catch (error) {
      writeError(error)
      return 1
    }
  }
  if (prompt === undefined || prompt.trim().length === 0) {
    process.stderr.write('dshc: a prompt is required in one-shot mode. Use `dshc` without `run` to start the interactive terminal product.\n')
    return 1
  }

  return runOneShot(options, prompt)
}

function shouldRunInteractive(options: CliOptions): boolean {
  if (options.command === 'run' || options.command === 'doctor' || options.json) return false
  if (options.interactive) return true
  if (options.prompt !== undefined) return false
  return process.stdin.isTTY === true
}

export function validateModeOptions(
  options: CliOptions,
  tty: { stdin: boolean; stdout: boolean } = {
    stdin: process.stdin.isTTY === true,
    stdout: process.stdout.isTTY === true,
  },
): void {
  if (options.help || options.version) return
  if (options.runtime === 'dsh-profile' && (options.runtimeConfig !== undefined || options.dev)) {
    throw new DshcRuntimeError('The dsh-profile backend cannot be combined with --runtime-config or --dev.', 'configuration')
  }
  if (options.mode !== undefined && options.mode !== 'code' && options.dev) {
    throw new DshcRuntimeError('Developer mode requires code mode.', 'configuration')
  }
  if (options.dev && options.runtimeConfig !== undefined) {
    throw new DshcRuntimeError('`--dev` cannot be combined with `--runtime-config`; developer mode requires the shipped base composition.', 'configuration')
  }
  if (options.command === 'doctor') {
    if (options.interactive) {
      throw new DshcRuntimeError('`doctor` cannot be combined with `--interactive`.', 'configuration')
    }
    if (options.prompt !== undefined) {
      throw new DshcRuntimeError('`doctor` does not accept a positional prompt.', 'configuration')
    }
    if (options.sessionId !== undefined) {
      throw new DshcRuntimeError('`doctor` does not create or select a session; remove `--session`.', 'configuration')
    }
    if (options.maxTokens !== undefined) {
      throw new DshcRuntimeError('`doctor` does not issue a model request; remove `--max-tokens`.', 'configuration')
    }
    if (options.activityTimeoutMs !== undefined) {
      throw new DshcRuntimeError('`doctor` has no prompt activity; remove `--activity-timeout-ms`.', 'configuration')
    }
    return
  }

  if (options.dev) {
    if (options.command === 'run' || options.prompt !== undefined || options.json) {
      throw new DshcRuntimeError('`--dev` is available only in the interactive TTY product; one-shot and JSON modes are not supported.', 'configuration')
    }
    if (!tty.stdin || !tty.stdout) {
      throw new DshcRuntimeError('`--dev` requires interactive TTY stdin and stdout; piped and scripted modes are rejected.', 'configuration')
    }
  }

  if (!options.interactive) return
  if (options.command === 'run') {
    throw new DshcRuntimeError('`run` and `--interactive` select conflicting modes.', 'configuration')
  }
  if (options.prompt !== undefined) {
    throw new DshcRuntimeError('`--interactive` cannot be combined with a positional one-shot prompt.', 'configuration')
  }
  if (options.json) {
    throw new DshcRuntimeError('`--json` is a one-shot/doctor output mode and cannot be combined with `--interactive`.', 'configuration')
  }
}

function createRuntime(
  options: CliOptions,
  composition: ResolvedComposition,
  moduleBasePath?: string,
  env?: NodeJS.ProcessEnv,
): HarnessRuntime {
  return new HarnessRuntime({
    ...(env === undefined ? {} : { env }),
    preferences: pickPreferences(options),
    preferenceSources: options.preferenceSources,
    workspace: options.workspace,
    provider: options.provider,
    model: options.model,
    maxTokens: options.maxTokens,
    ...(options.runtime === 'dsh-profile' ? {} : { configPath: composition.path, patchPaths: composition.patchPaths }),
    devMode: options.dev,
    ...(moduleBasePath === undefined ? {} : { moduleBasePath }),
    activityTimeoutMs: options.activityTimeoutMs,
    requestTimeoutMs: options.requestTimeoutMs,
  })
}

/** The official backend owns its config sources; do not even read a bundled workspace patch. */
async function resolveBackendComposition(options: CliOptions): Promise<ResolvedComposition> {
  if (options.runtime === 'dsh-profile') return { path: '', source: 'override', patchPaths: [] }
  return resolveComposition(options.workspace ?? process.cwd(), options.runtimeConfig, defaultRuntimeConfigPath(),
    { devMode: options.dev, devPatchPath: defaultRuntimeDevPatchPath() })
}

/** Close a command-owned candidate promptly when the terminal begins shutdown. */
async function startRuntimeWithAbort(
  runtime: HarnessRuntime,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<HarnessRuntime['start']>>> {
  signal?.throwIfAborted()
  const onAbort = (): void => { void runtime.close().catch(() => undefined) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const metadata = await runtime.start()
    signal?.throwIfAborted()
    return metadata
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

async function runLogsCommand(options: CliOptions): Promise<number> {
  try {
    const { text, exitCode } = await renderSessionLogs({
      root: defaultSessionRoot(process.env),
      // The positional selects a session; without one this lists recent ones.
      selector: options.prompt,
      eventTypeFilter: options.eventType,
      json: options.json,
    })
    process.stdout.write(text)
    return exitCode
  } catch (error) {
    writeError(error)
    return 1
  }
}

async function runDoctorCommand(options: CliOptions): Promise<number> {
  try {
    const report = await collectDoctorReport({
      workspace: options.workspace,
      provider: options.provider,
      model: options.model,
      configPath: options.runtimeConfig,
      requestTimeoutMs: options.requestTimeoutMs,
      devMode: options.dev,
      preferences: pickPreferences(options),
    })
    process.stdout.write(options.json
      ? `${stringifyTerminalSafeJson(report)}\n`
      : renderDoctorHuman(report, resolveLocale(options.locale)))
    return doctorExitCode(report)
  } catch (error) {
    writeError(error)
    return 1
  }
}

async function runInteractiveMode(cliOptions: CliOptions): Promise<number> {
  let activeOptions = { ...cliOptions }
  const profileManager = new ProfileManager(cliOptions.workspace ?? process.cwd())
  const bundlePreviews = new Map<string, BundlePreview>()
  const resolved = await resolveBackendComposition(cliOptions)
  const options = activeOptions
  const runtime = createRuntime(activeOptions, resolved)
  let primaryFailure = false
  let exitCode = 0

  try {
    if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
      // Ink installs its richer product-level SIGINT/SIGTERM handlers after it
      // has runtime metadata. This outer owner exists solely to cover the
      // startup interval as well; once Ink is active both handlers may call the
      // idempotent runtime.close(), but only the product decides its UI result.
      const startupSignals = installSignalHandlers(runtime, {
        onCloseError: (error) => {
          if (options.debug) process.stderr.write(`dshc: startup signal cleanup: ${safeErrorMessage(error)}\n`)
        },
      })
      try {
        const composition = options.runtime === 'dsh-profile' ? undefined : await readCompositionSummary(resolved.path, resolved.source, resolved.patchPaths)
        const workspace = options.workspace ?? process.cwd()
        const history = new HistoryWorkbench(new JsonlHistoryReader())
        const startupNotice = startupWarnings(workspace, process.env, options.dev)
        const result = await runTerminalProduct(runtime, {
          preferences: pickPreferences(options),
          profileOperation: async (args, signal, preferences) => {
            const selected = activeOptions.dshProfile ?? 'sdk'
            const [action = 'list', ...rest] = args
            const subject = rest.filter(arg => arg !== '--yes').join(' ')
            if (action === 'list' || action === 'details') {
              const inventory = await profileManager.inventory(selected)
              const items = action === 'details' ? inventory.filter(item => item.name === subject) : inventory
              return { message: JSON.stringify({ profile: await profileManager.active(selected), bundles: items, rollback: (await profileManager.pointer())?.history ?? [] }, null, 2) }
            }
            if (!['install', 'upgrade', 'disable', 'uninstall', 'rollback'].includes(action)) return { message: '/plugin list | details <name> | install <package@version|./bundle.tgz> | upgrade <package@version> | disable <name> | uninstall <name> | rollback [profile]\nRun without --yes to review the candidate; repeat with --yes to activate.' }
            const key = `${selected}:${action}:${subject}`
            if (!args.includes('--yes')) {
              const preview = await profileManager.preview(selected, action as BundleAction, subject, signal)
              bundlePreviews.clear()
              bundlePreviews.set(key, preview)
              return { message: `${preview.summary}\n\n/plugin ${action} ${subject} --yes` }
            }
            const preview = bundlePreviews.get(key)
            if (!preview) throw new Error('Run the same command without --yes first to review its exact target Profile and configuration changes')
            bundlePreviews.clear()
            const applied = await profileManager.apply(preview, async (name, signal) => {
              const nextOptions: CliOptions = { ...activeOptions, ...pickPreferences(preferences ?? {}), runtime: 'dsh-profile', dshProfile: name }
              const next = new HarnessRuntime({ workspace: nextOptions.workspace, provider: nextOptions.provider, model: nextOptions.model,
                maxTokens: nextOptions.maxTokens, preferences: pickPreferences(nextOptions), preferenceSources: nextOptions.preferenceSources,
                activityTimeoutMs: nextOptions.activityTimeoutMs, requestTimeoutMs: nextOptions.requestTimeoutMs })
              next.enableInteraction()
              try { return { runtime: next, metadata: await startRuntimeWithAbort(next, signal) } }
              catch (error) { await next.close(); throw error }
            }, value => value.runtime.close(), signal)
            activeOptions = { ...activeOptions, ...pickPreferences(preferences ?? {}), runtime: 'dsh-profile', dshProfile: 'managed' }
            applied.value.metadata.requestedPreferences = pickPreferences(activeOptions)
            return { message: `Activated ${applied.profile}. Startup verified; individual tool paths are unverified. Reopen with --runtime dsh-profile --dsh-profile managed.`, replacement: applied.value }
          },
          initialSessionId: options.sessionId,
          debug: options.debug,
          devMode: options.dev,
          ...(startupNotice === undefined ? {} : { startupNotice }),
          history,
          ...(composition === undefined ? {} : { composition }),
          // A fork lands beside the workspace so it travels with the project
          // rather than with this machine.
          forkComposition: (from, _signal) => forkComposition(
            from,
            workspaceCompositionPath(options.workspace ?? process.cwd()),
          ),
          // Construction and startup live here; the product owns presentation
          // and lifecycle, not how a runtime is built.
          restart: async (selection, signal) => {
            if (activeOptions.dev && selection.runtimeConfig !== undefined) {
              throw new DshcRuntimeError('Developer mode cannot reload an explicit runtime config; persist changes through the workspace patch.', 'configuration')
            }
            const nextOptions: CliOptions = {
              ...activeOptions,
              ...pickPreferences(selection),
              ...(selection.provider === undefined ? {} : { provider: selection.provider }),
              ...(selection.model === undefined ? {} : { model: selection.model }),
              ...(selection.maxTokens === undefined ? {} : { maxTokens: selection.maxTokens }),
              ...(selection.runtimeConfig === undefined ? {} : { runtimeConfig: selection.runtimeConfig }),
            }
            validateModeOptions(nextOptions)
            const nextResolved = await resolveBackendComposition(nextOptions)
            // A plan the person already approved carries into the code session
            // it hands off to, so the gate does not demand it be restated.
            const next = createRuntime(nextOptions, nextResolved, undefined,
              selection.approvedPlan === undefined || selection.approvedPlan.length === 0
                ? undefined
                : { DSHC_APPROVED_PLAN: JSON.stringify(selection.approvedPlan.slice(0, 8)) })
            next.enableInteraction()
            try {
              const metadata = await startRuntimeWithAbort(next, signal)
              const nextComposition = nextOptions.runtime === 'dsh-profile' ? undefined : await readCompositionSummary(
                nextResolved.path,
                nextResolved.source,
                nextResolved.patchPaths,
              )
              const changed = pickPreferences(Object.fromEntries(Object.entries(pickPreferences(selection))
                .filter(([key, value]) => value !== activeOptions[key as keyof CliOptions])))
              if (Object.keys(changed).length > 0) await savePreferences(preferencePaths(nextOptions.workspace ?? process.cwd()).workspacePath, changed)
              activeOptions = nextOptions
              return {
                runtime: next,
                metadata,
                ...(nextComposition === undefined ? {} : { composition: nextComposition }),
              }
            } catch (error) {
              await next.close().catch(() => undefined)
              throw error
            }
          },
          searchPlugins: (query, signal) => searchDeepseekPlugins(
            query,
            activeOptions.workspace ?? process.cwd(),
            process.env,
            undefined,
            signal,
          ),
          resolvePlugin: (spec, signal) => resolveDeepseekPlugin(
            spec,
            activeOptions.workspace ?? process.cwd(),
            process.env,
            undefined,
            signal,
          ),
          installPlugin: async (exactSpec, signal) => {
            if (activeOptions.runtime === 'dsh-profile') throw new Error('Use the Profile Bundle manager for the official backend')
            if (activeOptions.runtimeConfig !== undefined) {
              throw new DshcRuntimeError(
                'Workspace plugin installation requires the shipped base composition; remove --runtime-config first.',
                'configuration',
              )
            }
            const workspace = activeOptions.workspace ?? process.cwd()
            const installed = await installWorkspacePlugin({
              workspace,
              exactSpec,
              patchPath: workspaceCompositionPath(workspace),
              installAnchor: defaultRuntimeInstallAnchor(),
              signal,
              trial: async (moduleBasePath, candidatePatchPath, trialSignal) => {
                const nextResolved = await resolveComposition(
                  workspace,
                  undefined,
                  defaultRuntimeConfigPath(),
                  { devMode: activeOptions.dev, devPatchPath: defaultRuntimeDevPatchPath() },
                )
                const trialResolved: ResolvedComposition = {
                  ...nextResolved,
                  patchPath: candidatePatchPath,
                  patchPaths: nextResolved.patchPath === undefined
                    ? [...nextResolved.patchPaths, candidatePatchPath]
                    : nextResolved.patchPaths.map(path => path === nextResolved.patchPath ? candidatePatchPath : path),
                }
                const next = createRuntime(activeOptions, trialResolved, moduleBasePath)
                try {
                  const metadata = await startRuntimeWithAbort(next, trialSignal)
                  return {
                    runtime: next,
                    metadata,
                  }
                } catch (error) {
                  try {
                    await next.close()
                  } catch (closeError) {
                    throw new DshcRuntimeError(
                      `Plugin trial initialization failed and its runtime could not be closed: ${safeErrorMessage(error)}; cleanup: ${safeErrorMessage(closeError)}`,
                      'runtime',
                      { cause: error instanceof Error ? error : undefined },
                    )
                  }
                  throw error
                }
              },
              discardTrial: async value => value.runtime.close(),
            })
            let nextComposition: CompositionSummary | undefined
            let compositionWarning = ''
            try {
              const committed = await resolveComposition(
                workspace,
                undefined,
                defaultRuntimeConfigPath(),
                { devMode: activeOptions.dev, devPatchPath: defaultRuntimeDevPatchPath() },
              )
              nextComposition = await readCompositionSummary(
                committed.path,
                committed.source,
                committed.patchPaths,
              )
            } catch (error) {
              compositionWarning = `\nThe plugin is active, but its local composition summary is unavailable: ${safeErrorMessage(error)}`
            }
            return {
              ...installed.value,
              ...(nextComposition === undefined ? {} : { composition: nextComposition }),
              message: `Installed ${installed.exactSpec}; workspace patch ${installed.patchPath} passed trial initialization.${compositionWarning}`,
            }
          },
        })
        exitCode = result.exitCode
      } catch (error) {
        if (startupSignals.interrupted) {
          exitCode = startupSignals.exitCode ?? 130
        } else {
          throw error
        }
      } finally {
        startupSignals.dispose()
      }
    } else {
      const result = await runInteractiveLoop(runtime, {
        initialSessionId: options.sessionId,
        debug: options.debug,
        workspace: resolve(options.workspace ?? process.cwd()),
      })
      exitCode = result.exitCode
    }
  } catch (error) {
    primaryFailure = true
    writeError(error)
    exitCode = 1
  } finally {
    try {
      await runtime.close()
    } catch (error) {
      if (!primaryFailure && exitCode === 0) {
        writeError(error)
        exitCode = 1
      } else if (options.debug) {
        process.stderr.write(`dshc: cleanup: ${safeErrorMessage(error)}\n`)
      }
    }
  }

  return exitCode
}

export function startupWarnings(
  workspace: string,
  env: NodeJS.ProcessEnv,
  devMode: boolean,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const notices: string[] = []
  if (devMode) notices.push(DEV_MODE_WARNING)
  const findings: DoctorFinding[] = []
  shellTempRootFacts(workspace, env, findings, platform)
  const tempFailure = findings.find(finding => finding.id === 'shell.temp-root' && finding.status === 'FAIL')
  if (tempFailure !== undefined) {
    notices.push([
      'Windows shell unavailable in this workspace.',
      tempFailure.summary,
      tempFailure.detail ?? '',
      'dshc will not relocate TEMP or weaken the Harness sandbox automatically; run `dshc doctor` after correcting the environment.',
    ].filter(Boolean).join('\n'))
  }
  return notices.length === 0 ? undefined : notices.join('\n\n')
}

async function runOneShot(cliOptions: CliOptions, prompt: string): Promise<number> {
  const resolved = await resolveBackendComposition(cliOptions)
  const options = cliOptions
  const runtime = createRuntime(options, resolved)
  const renderer = options.json ? undefined : new PlainRenderer({
    debugUnknownEvents: options.debug,
    rootSessionId: options.sessionId,
    workspace: resolve(options.workspace ?? process.cwd()),
  })
  const signals = installSignalHandlers(runtime, {
    onSignal: (signal) => {
      process.stderr.write(
        `\ndshc: ${signal} closes the entire Harness runtime; the current DSH protocol has no prompt-level cancel.\n`,
      )
    },
    onCloseError: (error) => {
      if (options.debug) process.stderr.write(`dshc: signal cleanup: ${safeErrorMessage(error)}\n`)
    },
  })

  let exitCode = 0
  let primaryFailure = false

  try {
    const metadata = await runtime.start()
    if (options.debug) {
      process.stderr.write(
        `dshc: runtime ${metadata.serverName}/${metadata.protocolVersion}; SDK ${metadata.sdkVersion ?? 'unverified'}; package ${metadata.runtimePackageVersion ?? 'unverified'}; model ${sanitizeTerminalText(metadata.model)}\n`,
      )
    }

    const result = await runtime.run(prompt, {
      sessionId: options.sessionId,
      onEvent: (event) => renderer?.render(event),
    })
    renderer?.finish()

    if (options.json) {
      process.stdout.write(`${stringifyTerminalSafeJson({
        sessionId: result.sessionId,
        messageId: result.messageId,
        finalResponse: result.finalResponse,
        turnError: result.projection.lastTurnError ?? null,
        eventCount: result.eventCount,
        retainedEventCount: result.events.length,
        droppedEventCount: result.droppedEventCount,
        notificationCount: result.notificationCount,
        retainedNotificationCount: result.notifications.length,
        droppedNotificationCount: result.droppedNotificationCount,
        unknownEventCount: result.projection.unknownEventCount,
        runtime: metadata,
      })}\n`)
    }

    if (result.projection.lastTurnError !== undefined) exitCode = 2
  } catch (error) {
    primaryFailure = true
    if (signals.interrupted) {
      exitCode = signals.exitCode ?? 130
    } else {
      writeError(error)
      exitCode = 1
    }
  } finally {
    renderer?.finish()
    signals.dispose()
    try {
      await runtime.close()
    } catch (error) {
      if (!primaryFailure && !signals.interrupted) {
        writeError(error)
        exitCode = 1
      } else if (options.debug) {
        process.stderr.write(`dshc: cleanup: ${safeErrorMessage(error)}\n`)
      }
    }
  }

  return exitCode
}

async function readPromptFromStdin(): Promise<string> {
  process.stdin.setEncoding('utf8')
  let input = ''
  let bytes = 0
  for await (const chunk of process.stdin) {
    const text = String(chunk)
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_STDIN_BYTES) throw new Error(`stdin prompt exceeds ${MAX_STDIN_BYTES} bytes`)
    input += text
  }
  return input.trimEnd()
}

function writeError(error: unknown): void {
  const classified = classifyRuntimeError(error)
  process.stderr.write(`dshc: ${sanitizeTerminalText(classified.message)}\n`)
}

function safeErrorMessage(error: unknown): string {
  return sanitizeTerminalText(classifyRuntimeError(error).message)
}
