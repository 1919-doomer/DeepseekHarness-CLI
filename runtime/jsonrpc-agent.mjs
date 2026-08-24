#!/usr/bin/env node
import { existsSync } from 'node:fs'
import {
  boot,
  installFailLoud,
  loadEnv,
  loadOptionalPatches,
  resolveConfigPath,
} from '@deepseek-ai/dsh-app-boot'

const NAME = 'dshc-jsonrpc-agent'
const PATCHES_ENV = 'DSHC_CORDIS_PATCHES'
const MODULE_BASE_ENV = 'DSHC_MODULE_BASE_URL'

installFailLoud(NAME)
loadEnv(NAME)

const requested = process.env.DSH_CORDIS_CONFIG || process.argv[2]
const configPath = requested ? resolveConfigPath(requested, undefined) : undefined
if (configPath === undefined || !existsSync(configPath)) {
  process.stderr.write(`usage: ${NAME} <path/to/cordis.yml>; the config is required\n`)
  process.exit(1)
}

let patchPaths = []
try {
  const encoded = process.env[PATCHES_ENV]
  patchPaths = encoded === undefined ? [] : JSON.parse(encoded)
  if (!Array.isArray(patchPaths) || patchPaths.some(value => typeof value !== 'string')) {
    throw new TypeError(`${PATCHES_ENV} must encode an array of paths`)
  }
} catch (error) {
  process.stderr.write(`${NAME}: invalid patch selection: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

const patches = patchPaths.flatMap(path => loadOptionalPatches(NAME, path) ?? [])
const ctx = await boot(
  NAME,
  configPath,
  patches,
  undefined,
  process.env[MODULE_BASE_ENV],
)

let exiting = false
async function disposeAndExit(code) {
  if (exiting) return
  exiting = true
  try {
    await ctx.fiber.dispose()
  } finally {
    process.exit(code)
  }
}

process.stdin.on('end', () => void disposeAndExit(0))
process.on('SIGTERM', () => void disposeAndExit(0))
process.on('SIGINT', () => void disposeAndExit(130))
