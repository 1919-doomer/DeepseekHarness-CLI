import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { CompatibilityError } from './errors.js'

export const TESTED_DSH_BASELINE = Object.freeze({
  sdkVersion: '0.1.1-rc.2',
  runtimePackageVersion: '0.1.1-rc.2',
  serverName: 'deepseek-harness-sdk-runtime',
  protocolVersion: '0.0.1',
})

export const TESTED_CORDIS_BASELINE = Object.freeze({
  hostRunnerVersion: '0.1.1-rc.2',
  toolCordisVersion: '0.1.1-rc.2',
})

export interface InstalledDshVersions {
  sdkVersion: string
  runtimePackageVersion: string
}

export interface InstalledCordisVersions {
  hostRunnerVersion: string
  toolCordisVersion: string
}

export interface RuntimeIdentity {
  name: string
  version: string
}

export async function readInstalledDshVersions(): Promise<InstalledDshVersions> {
  const [sdkVersion, runtimePackageVersion] = await Promise.all([
    readPackageVersion('@deepseek-ai/dsh-sdk-client/package.json'),
    readPackageVersion('@deepseek-ai/dsh-sdk-jsonrpc-demo/package.json'),
  ])
  return { sdkVersion, runtimePackageVersion }
}

export async function readInstalledCordisVersions(): Promise<InstalledCordisVersions> {
  const [hostRunnerVersion, toolCordisVersion] = await Promise.all([
    readPackageVersion('@deepseek-ai/dsh-cordis-host-runner/package.json'),
    readPackageVersion('@deepseek-ai/dsh-tool-cordis/package.json'),
  ])
  return { hostRunnerVersion, toolCordisVersion }
}

export function assertInstalledCordisCompatibility(versions: InstalledCordisVersions): void {
  if (versions.hostRunnerVersion !== TESTED_CORDIS_BASELINE.hostRunnerVersion) {
    throw new CompatibilityError(`Unsupported @deepseek-ai/dsh-cordis-host-runner ${versions.hostRunnerVersion}; M6 is tested against ${TESTED_CORDIS_BASELINE.hostRunnerVersion}.`)
  }
  if (versions.toolCordisVersion !== TESTED_CORDIS_BASELINE.toolCordisVersion) {
    throw new CompatibilityError(`Unsupported @deepseek-ai/dsh-tool-cordis ${versions.toolCordisVersion}; M6 is tested against ${TESTED_CORDIS_BASELINE.toolCordisVersion}.`)
  }
}

export function assertInstalledCompatibility(versions: InstalledDshVersions): void {
  if (versions.sdkVersion !== TESTED_DSH_BASELINE.sdkVersion) {
    throw new CompatibilityError(
      `Unsupported @deepseek-ai/dsh-sdk-client ${versions.sdkVersion}; M1 is tested against ${TESTED_DSH_BASELINE.sdkVersion}.`,
    )
  }
  if (versions.runtimePackageVersion !== TESTED_DSH_BASELINE.runtimePackageVersion) {
    throw new CompatibilityError(
      `Unsupported @deepseek-ai/dsh-sdk-jsonrpc-demo ${versions.runtimePackageVersion}; M1 is tested against ${TESTED_DSH_BASELINE.runtimePackageVersion}.`,
    )
  }
}

export function assertRuntimeIdentity(identity: RuntimeIdentity): void {
  if (identity.name !== TESTED_DSH_BASELINE.serverName) {
    throw new CompatibilityError(
      `Unexpected Harness server identity ${JSON.stringify(identity.name)}; expected ${JSON.stringify(TESTED_DSH_BASELINE.serverName)}.`,
    )
  }
  if (identity.version !== TESTED_DSH_BASELINE.protocolVersion) {
    throw new CompatibilityError(
      `Unsupported Harness SDK protocol ${identity.version}; M1 is tested against ${TESTED_DSH_BASELINE.protocolVersion}.`,
    )
  }
}

async function readPackageVersion(specifier: string): Promise<string> {
  let url: string
  try {
    url = import.meta.resolve(specifier)
  } catch (error) {
    throw new CompatibilityError(`Required package ${specifier.replace('/package.json', '')} is not installed: ${errorMessage(error)}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(fileURLToPath(url), 'utf8'))
  } catch (error) {
    throw new CompatibilityError(`Unable to read ${specifier}: ${errorMessage(error)}`)
  }

  if (!isRecord(parsed) || typeof parsed.version !== 'string') {
    throw new CompatibilityError(`${specifier} does not contain a string version field.`)
  }
  return parsed.version
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
