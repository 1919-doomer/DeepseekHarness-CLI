import { constants, realpathSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import {
  MAX_RETAINED_ACTIVITY_EVENTS,
  MAX_RETAINED_ACTIVITY_NOTIFICATIONS,
  MAX_RETAINED_EVENT_TEXT_CHARS,
  MAX_RETAINED_NOTIFICATION_STRING_CHARS,
  MAX_RETAINED_TERMINAL_EVENTS,
  MAX_RETAINED_TOPOLOGY_ENTRIES,
  MAX_RETAINED_TRANSCRIPT_BLOCKS,
  MAX_RETAINED_TRANSCRIPT_FIELD_CHARS,
} from '../retention.js'
import { sanitizeTerminalText } from '../terminal/sanitize.js'
import {
  assertInstalledCompatibility,
  readInstalledDshVersions,
  TESTED_DSH_BASELINE,
  type InstalledDshVersions,
} from '../upstream/compatibility.js'
import { classifyRuntimeError, type RuntimeErrorCode } from '../upstream/errors.js'
import { HarnessRuntime, type HarnessRuntimeMetadata, type HarnessRuntimeOptions } from '../upstream/runtime.js'
import { defaultRuntimeConfigPath, effectiveRuntimeEnvironment } from '../upstream/runtime-launcher.js'
import { DSHC_VERSION } from '../version.js'

export type DoctorStatus = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN'

export interface DoctorFinding {
  id: string
  status: DoctorStatus
  category: RuntimeErrorCode | 'environment' | 'local-policy' | 'capability'
  summary: string
  detail?: string
}

export interface DoctorTtyFacts {
  stdin: boolean
  stdout: boolean
  stderr: boolean
  rawModeCapable: boolean
  rawModeActive: boolean
  columns?: number
  rows?: number
  term?: string
  color: 'forced' | 'disabled' | 'tty-default' | 'non-tty' | 'unknown'
}

export interface DoctorRetentionFacts {
  activityNotifications: number
  activityEvents: number
  terminalEvents: number
  transcriptBlocks: number
  topologyEntries: number
  eventTextChars: number
  notificationStringChars: number
  transcriptFieldChars: number
}

export interface DoctorReport {
  schemaVersion: 1
  ok: boolean
  dshcVersion: string
  nodeVersion: string
  platform: NodeJS.Platform
  arch: string
  workspace: string
  runtimeConfig: {
    path: string
    source: 'shipped-default' | 'override'
  }
  selection: {
    provider: string
    model: string
  }
  credential: {
    provider: string
    environmentVariable?: string
    present: boolean | null
  }
  tty: DoctorTtyFacts
  testedBaseline: typeof TESTED_DSH_BASELINE
  retention: DoctorRetentionFacts
  runtime?: HarnessRuntimeMetadata
  findings: DoctorFinding[]
  counts: Record<DoctorStatus, number>
}

interface DoctorInputStream {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?: unknown
}

interface DoctorOutputStream {
  isTTY?: boolean
  columns?: number
  rows?: number
}

export interface DoctorOptions extends HarnessRuntimeOptions {
  stdin?: DoctorInputStream
  stdout?: DoctorOutputStream
  stderr?: DoctorOutputStream
}

export async function collectDoctorReport(options: DoctorOptions = {}): Promise<DoctorReport> {
  const workspace = resolve(options.workspace ?? process.cwd())
  const provider = options.provider ?? 'deepseek-official'
  const model = options.model ?? 'deepseek-v4-flash'
  const runtimeConfigPath = resolve(options.configPath ?? defaultRuntimeConfigPath())
  const runtimeConfigSource = options.configPath === undefined ? 'shipped-default' : 'override'
  const childEnv = effectiveRuntimeEnvironment({
    workspace,
    configPath: options.configPath,
    env: options.env,
    requestTimeoutMs: options.requestTimeoutMs,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    disposeEofGraceMs: options.disposeEofGraceMs,
    disposeGraceMs: options.disposeGraceMs,
    override: options.launchOverride,
  })
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const findings: DoctorFinding[] = []

  const nodeReady = checkNodeVersion(process.versions.node, findings)
  const workspaceReady = await checkWorkspace(workspace, findings)
  const configReady = await checkRuntimeConfig(runtimeConfigPath, runtimeConfigSource, findings)
  const packageReady = await checkInstalledPackages(findings)

  findings.push({
    id: 'selection',
    status: 'PASS',
    category: 'capability',
    summary: `Provider ${provider}; model ${model}.`,
  })

  const credential = credentialFacts(provider, childEnv, findings)
  shellTempRootFacts(workspace, childEnv, findings)
  const tty = ttyFacts(stdin, stdout, stderr, childEnv)
  findings.push({
    id: 'terminal',
    status: tty.stdin && tty.stdout ? 'PASS' : 'WARN',
    category: 'environment',
    summary: tty.stdin && tty.stdout
      ? `TTY available; raw-mode ${tty.rawModeCapable ? 'capable' : 'unavailable'}.`
      : 'Non-TTY execution is supported, but the interactive raw-mode product is unavailable on these streams.',
  })

  if (runtimeConfigSource === 'shipped-default') {
    findings.push(
      {
        id: 'composition.coding',
        status: 'PASS',
        category: 'capability',
        summary: 'Shipped M4 coding composition selected: filesystem, search, platform shell, subagent and todo capabilities are Harness-owned.',
      },
      {
        id: 'composition.sandbox',
        status: 'PASS',
        category: 'capability',
        summary: 'Shipped sandbox policy is workspace-write; danger-full-access is not an implicit default or fallback.',
      },
      {
        id: 'composition.approval',
        status: 'PASS',
        category: 'capability',
        summary: 'Shipped approval policy is ask; without an upstream answerer, wider escalation fails closed.',
      },
    )
  } else {
    findings.push({
      id: 'composition.override',
      status: 'WARN',
      category: 'configuration',
      summary: 'A runtime config override is selected; shipped M4 coding/sandbox/approval composition facts may not apply.',
      detail: runtimeConfigPath,
    })
  }

  findings.push({
    id: 'retention',
    status: 'PASS',
    category: 'local-policy',
    summary: 'dshc diagnostic and terminal histories use bounded local retention; complete upstream protocol processing happens before retention.',
  })

  let runtimeMetadata: HarnessRuntimeMetadata | undefined
  if (nodeReady && workspaceReady && configReady && packageReady) {
    const runtime = new HarnessRuntime(options)
    try {
      runtimeMetadata = await runtime.start()
      findings.push(
        {
          id: 'runtime.initialize',
          status: 'PASS',
          category: 'capability',
          summary: 'Harness child launched and completed initialize without issuing a session prompt.',
        },
        {
          id: 'runtime.server',
          status: 'PASS',
          category: 'compatibility',
          summary: `Server identity ${runtimeMetadata.serverName} matches the tested baseline.`,
        },
        {
          id: 'runtime.protocol',
          status: 'PASS',
          category: 'compatibility',
          summary: `SDK protocol ${runtimeMetadata.protocolVersion} matches the tested baseline.`,
        },
        {
          id: 'runtime.protocol-limitations',
          status: 'PASS',
          category: 'capability',
          summary: 'Protocol 0.0.1 has no dshc-supported prompt cancel, per-session close, or server-to-client approval request transport.',
        },
      )
    } catch (error) {
      const classified = classifyRuntimeError(error, childEnv)
      findings.push({
        id: 'runtime.initialize',
        status: 'FAIL',
        category: classified.code,
        summary: `Harness initialize failed: ${classified.message}`,
      })
    } finally {
      try {
        await runtime.close()
      } catch (error) {
        const classified = classifyRuntimeError(error, childEnv)
        findings.push({
          id: 'runtime.cleanup',
          status: 'FAIL',
          category: classified.code,
          summary: `Harness child cleanup failed: ${classified.message}`,
        })
      }
    }
  } else {
    findings.push({
      id: 'runtime.initialize',
      status: 'UNKNOWN',
      category: 'configuration',
      summary: 'Harness initialize was not attempted because a required preflight check failed.',
    })
  }

  const counts = countStatuses(findings)
  return {
    schemaVersion: 1,
    ok: counts.FAIL === 0,
    dshcVersion: DSHC_VERSION,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    workspace,
    runtimeConfig: { path: runtimeConfigPath, source: runtimeConfigSource },
    selection: { provider, model },
    credential,
    tty,
    testedBaseline: TESTED_DSH_BASELINE,
    retention: retentionFacts(),
    ...(runtimeMetadata === undefined ? {} : { runtime: runtimeMetadata }),
    findings,
    counts,
  }
}

export function doctorExitCode(report: DoctorReport): number {
  return report.ok ? 0 : 1
}

export function renderDoctorHuman(report: DoctorReport): string {
  const lines = [
    `DeepSeek Harness Console doctor — dshc ${report.dshcVersion}`,
    `workspace: ${safe(report.workspace)}`,
    `runtime config: ${safe(report.runtimeConfig.path)} (${report.runtimeConfig.source})`,
    '',
  ]
  for (const finding of report.findings) {
    lines.push(`${finding.status.padEnd(7)} ${safe(finding.id).padEnd(30)} ${safe(finding.summary)}`)
    if (finding.detail !== undefined) lines.push(`        ${safe(finding.detail)}`)
  }
  lines.push(
    '',
    `Summary: ${report.counts.PASS} pass, ${report.counts.WARN} warn, ${report.counts.FAIL} fail, ${report.counts.UNKNOWN} unknown`,
  )
  return `${lines.join('\n')}\n`
}

async function checkWorkspace(workspace: string, findings: DoctorFinding[]): Promise<boolean> {
  try {
    const info = await stat(workspace)
    if (!info.isDirectory()) {
      findings.push({
        id: 'workspace',
        status: 'FAIL',
        category: 'configuration',
        summary: 'Workspace exists but is not a directory.',
        detail: workspace,
      })
      return false
    }
    await access(workspace, constants.R_OK)
    findings.push({
      id: 'workspace',
      status: 'PASS',
      category: 'configuration',
      summary: 'Workspace resolves to an accessible directory.',
      detail: workspace,
    })
    return true
  } catch (error) {
    const classified = classifyRuntimeError(error)
    findings.push({
      id: 'workspace',
      status: 'FAIL',
      category: 'configuration',
      summary: `Workspace is unavailable: ${classified.message}`,
      detail: workspace,
    })
    return false
  }
}

async function checkRuntimeConfig(
  path: string,
  source: 'shipped-default' | 'override',
  findings: DoctorFinding[],
): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    findings.push({
      id: 'runtime.config',
      status: 'PASS',
      category: 'configuration',
      summary: `${source === 'shipped-default' ? 'Shipped' : 'Override'} runtime config is readable.`,
      detail: path,
    })
    return true
  } catch (error) {
    const classified = classifyRuntimeError(error)
    findings.push({
      id: 'runtime.config',
      status: 'FAIL',
      category: 'configuration',
      summary: `Runtime config is unavailable: ${classified.message}`,
      detail: path,
    })
    return false
  }
}

async function checkInstalledPackages(findings: DoctorFinding[]): Promise<boolean> {
  try {
    const versions = await readInstalledDshVersions()
    assertInstalledCompatibility(versions)
    findings.push({
      id: 'runtime.packages',
      status: 'PASS',
      category: 'compatibility',
      summary: packageSummary(versions),
    })
    return true
  } catch (error) {
    const classified = classifyRuntimeError(error)
    findings.push({
      id: 'runtime.packages',
      status: 'FAIL',
      category: classified.code,
      summary: classified.message,
    })
    return false
  }
}

function packageSummary(versions: InstalledDshVersions): string {
  return `DSH SDK ${versions.sdkVersion}; runtime package ${versions.runtimePackageVersion}; both match the pinned baseline.`
}

function checkNodeVersion(version: string, findings: DoctorFinding[]): boolean {
  const [majorRaw, minorRaw] = version.split('.')
  const major = Number(majorRaw)
  const minor = Number(minorRaw)
  const supported = (major === 22 && minor >= 19) || major >= 24
  findings.push({
    id: 'node',
    status: supported ? 'PASS' : 'FAIL',
    category: 'compatibility',
    summary: supported
      ? `Node ${version} is supported (^22.19.0 or >=24.0.0).`
      : `Node ${version} is outside the supported range (^22.19.0 or >=24.0.0).`,
  })
  return supported
}

function credentialFacts(
  provider: string,
  env: NodeJS.ProcessEnv,
  findings: DoctorFinding[],
): DoctorReport['credential'] {
  if (provider !== 'deepseek-official') {
    findings.push({
      id: 'credential',
      status: 'UNKNOWN',
      category: 'environment',
      summary: `Credential presence is not inferred for provider ${provider}; doctor only knows the shipped DeepSeek provider contract.`,
    })
    return { provider, present: null }
  }

  const present = typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.length > 0
  findings.push({
    id: 'credential',
    status: present ? 'PASS' : 'WARN',
    category: 'environment',
    summary: present
      ? 'DEEPSEEK_API_KEY is present in the effective Harness child environment.'
      : 'DEEPSEEK_API_KEY is absent; initialize can still be diagnosed, but provider-backed prompts will require a credential.',
  })
  return { provider, environmentVariable: 'DEEPSEEK_API_KEY', present }
}

/**
 * The upstream Windows shell sandbox refuses to run when its temp root sits
 * inside the workspace. Without this check `doctor` reports a healthy machine
 * and `composition.coding` claims a platform shell, while every shell call
 * fails — the exact class of startup problem this command exists to catch.
 *
 * Paths are resolved to their real form first: on Windows `%TEMP%` is commonly
 * an 8.3 short name, so the containment is invisible to a textual comparison.
 * dshc reports the same conclusion as the sandbox; it never enforces it.
 */
export function shellTempRootFacts(
  workspace: string,
  env: NodeJS.ProcessEnv,
  findings: DoctorFinding[],
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') return

  const configured = env.TEMP ?? env.TMP
  if (configured === undefined || configured.length === 0) {
    findings.push({
      id: 'shell.temp-root',
      status: 'WARN',
      category: 'environment',
      summary: 'Neither TEMP nor TMP is set for the Harness child; the platform shell sandbox may be unable to select a temporary root.',
    })
    return
  }

  const realWorkspace = realPathOrSelf(workspace)
  const realTemp = realPathOrSelf(resolve(configured))

  if (!containsPath(realWorkspace, realTemp)) {
    findings.push({
      id: 'shell.temp-root',
      status: 'PASS',
      category: 'environment',
      summary: 'Shell sandbox temporary root resolves outside the workspace.',
      detail: sanitizeTerminalText(realTemp),
    })
    return
  }

  findings.push({
    id: 'shell.temp-root',
    status: 'FAIL',
    category: 'environment',
    summary: 'Shell sandbox temporary root resolves inside the workspace, so every platform shell call will fail. Run dshc from a project directory that does not contain the temporary root, or point TEMP outside it.',
    detail: sanitizeTerminalText(`workspace=${realWorkspace}; temp=${realTemp}`),
  })
}

/** Resolves 8.3 short names and symlinks; falls back to the literal path. */
function realPathOrSelf(target: string): string {
  try {
    return realpathSync.native(target)
  } catch {
    return resolve(target)
  }
}

function containsPath(parent: string, child: string): boolean {
  const offset = relative(parent, child)
  if (offset.length === 0) return true
  return !offset.startsWith('..') && !offset.startsWith(`..${sep}`) && !/^[a-zA-Z]:/.test(offset)
}

function ttyFacts(
  stdin: DoctorInputStream,
  stdout: DoctorOutputStream,
  stderr: DoctorOutputStream,
  env: NodeJS.ProcessEnv,
): DoctorTtyFacts {
  const stdoutTty = stdout.isTTY === true
  return {
    stdin: stdin.isTTY === true,
    stdout: stdoutTty,
    stderr: stderr.isTTY === true,
    rawModeCapable: stdin.isTTY === true && typeof stdin.setRawMode === 'function',
    rawModeActive: stdin.isRaw === true,
    ...(Number.isSafeInteger(stdout.columns) ? { columns: stdout.columns } : {}),
    ...(Number.isSafeInteger(stdout.rows) ? { rows: stdout.rows } : {}),
    ...(typeof env.TERM === 'string' ? { term: env.TERM } : {}),
    color: colorMode(stdoutTty, env),
  }
}

function colorMode(stdoutTty: boolean, env: NodeJS.ProcessEnv): DoctorTtyFacts['color'] {
  if (env.NO_COLOR !== undefined || env.TERM === 'dumb' || env.FORCE_COLOR === '0') return 'disabled'
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') return 'forced'
  if (!stdoutTty) return 'non-tty'
  if (typeof env.TERM === 'string') return 'tty-default'
  return 'unknown'
}

function retentionFacts(): DoctorRetentionFacts {
  return {
    activityNotifications: MAX_RETAINED_ACTIVITY_NOTIFICATIONS,
    activityEvents: MAX_RETAINED_ACTIVITY_EVENTS,
    terminalEvents: MAX_RETAINED_TERMINAL_EVENTS,
    transcriptBlocks: MAX_RETAINED_TRANSCRIPT_BLOCKS,
    topologyEntries: MAX_RETAINED_TOPOLOGY_ENTRIES,
    eventTextChars: MAX_RETAINED_EVENT_TEXT_CHARS,
    notificationStringChars: MAX_RETAINED_NOTIFICATION_STRING_CHARS,
    transcriptFieldChars: MAX_RETAINED_TRANSCRIPT_FIELD_CHARS,
  }
}

function countStatuses(findings: readonly DoctorFinding[]): Record<DoctorStatus, number> {
  const counts: Record<DoctorStatus, number> = { PASS: 0, WARN: 0, FAIL: 0, UNKNOWN: 0 }
  for (const finding of findings) counts[finding.status]++
  return counts
}

function safe(value: string): string {
  return sanitizeTerminalText(value)
}
