#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmInvocation } from './npm-command.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const npm = npmInvocation(['pack', '--dry-run', '--json', '--ignore-scripts'])
const npmCache = mkdtempSync(join(tmpdir(), 'dshc-pack-check-'))
let packed
try {
  packed = spawnSync(npm.command, npm.args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_cache: npmCache,
      npm_config_fund: 'false',
      npm_config_registry: 'https://registry.npmjs.org/',
    },
  })
} finally {
  rmSync(npmCache, { recursive: true, force: true })
}

if (packed.error !== undefined) throw packed.error
if (packed.status !== 0) {
  process.stderr.write(packed.stderr)
  process.exit(packed.status ?? 1)
}

const [report] = JSON.parse(packed.stdout)
if (report === undefined || !Array.isArray(report.files)) {
  throw new Error('npm pack did not return a package file report')
}

const paths = new Set(report.files.map(file => String(file.path).replaceAll('\\', '/')))
const required = [
  'package.json',
  'LICENSE',
  'DISCLOSURE',
  'README.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'docs/INSTALLATION.md',
  'docs/COMPATIBILITY.md',
  'docs/DEMO.md',
  'docs/EXTENSIONS.md',
  'docs/assets/dshc-alpha.svg',
  'dist/cli/bin.js',
  'runtime/cordis.yml',
  'runtime/jsonrpc-agent.mjs',
]
for (const path of required) {
  if (!paths.has(path)) throw new Error(`Published package is missing required file: ${path}`)
}

const forbidden = [
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)\.git(?:\/|$)/,
  /(^|\/)node_modules(?:\/|$)/,
  /(^|\/)src(?:\/|$)/,
  /(^|\/)tests?(?:\/|$)/,
  /(^|\/)coverage(?:\/|$)/,
  /\.tgz$/,
]
for (const path of paths) {
  if (forbidden.some(pattern => pattern.test(path))) {
    throw new Error(`Published package contains forbidden path: ${path}`)
  }
}

if (manifest.name !== '@1919-doomer/dshc') throw new Error(`Unexpected package name: ${manifest.name}`)
if (manifest.private !== false) throw new Error('Published package must set private=false')
if (manifest.bin?.dshc !== './dist/cli/bin.js') throw new Error('Published package must expose the dshc binary')
if (manifest.publishConfig?.access !== 'public') throw new Error('Scoped package must publish with public access')
if (manifest.publishConfig?.registry !== 'https://registry.npmjs.org/') {
  throw new Error('Releases must target the official npm registry')
}
if (manifest.repository?.url !== 'git+https://github.com/1919-doomer/DeepseekHarness-CLI.git') {
  throw new Error('package.json repository must match the trusted GitHub publisher')
}
if (manifest.contentPolicy?.class !== 'dual-use') {
  throw new Error('The coding runtime must retain its npm dual-use declaration')
}

const unpackedSize = Number(report.unpackedSize ?? 0)
if (!Number.isFinite(unpackedSize) || unpackedSize <= 0 || unpackedSize > 10 * 1024 * 1024) {
  throw new Error(`Unexpected unpacked package size: ${report.unpackedSize}`)
}

process.stdout.write(
  `Package contents OK: ${report.filename} (${paths.size} files, ${unpackedSize} unpacked bytes)\n`,
)
