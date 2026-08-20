import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HarnessClientOptions } from '@deepseek-ai/dsh-sdk-client'
import { DshcRuntimeError } from './errors.js'

export interface RuntimeLaunchOptions {
  workspace: string
  configPath?: string
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
  disposeEofGraceMs?: number
  disposeGraceMs?: number
  override?: HarnessClientOptions
}

export async function resolveRuntimeLaunch(options: RuntimeLaunchOptions): Promise<HarnessClientOptions> {
  if (options.override !== undefined) return options.override

  const configPath = resolve(options.configPath ?? defaultRuntimeConfigPath())
  try {
    await access(configPath)
  } catch {
    throw new DshcRuntimeError(`Harness runtime config does not exist: ${configPath}`, 'configuration')
  }

  let runtimeBin: string
  try {
    runtimeBin = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin'))
  } catch (error) {
    throw new DshcRuntimeError(
      `Unable to resolve the official dsh-jsonrpc-agent runtime package: ${errorMessage(error)}`,
      'configuration',
      { cause: error instanceof Error ? error : undefined },
    )
  }

  return {
    command: process.execPath,
    args: [runtimeBin, configPath],
    cwd: options.workspace,
    env: {
      ...process.env,
      ...options.env,
      DSH_CWD: options.workspace,
    },
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 1_000,
    disposeEofGraceMs: options.disposeEofGraceMs ?? 6_000,
    disposeGraceMs: options.disposeGraceMs ?? 3_000,
  }
}

export function defaultRuntimeConfigPath(): string {
  return fileURLToPath(new URL('../../runtime/cordis.yml', import.meta.url))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
