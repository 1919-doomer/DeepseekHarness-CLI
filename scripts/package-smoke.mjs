#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmInvocation } from './npm-command.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const tempRoot = await mkdtemp(join(tmpdir(), 'dshc-package-smoke-'))

try {
  const tarball = await resolveTarball(process.argv[2])
  const prefix = join(tempRoot, 'global')
  const workspace = join(tempRoot, 'workspace')
  await mkdir(workspace, { recursive: true })
  const npmArgs = [
    '--global',
    '--prefix', prefix,
    '--registry', 'https://registry.npmjs.org/',
    '--no-audit',
    '--no-fund',
  ]

  await runNpm(['install', ...npmArgs, tarball], { cwd: tempRoot })
  const command = process.platform === 'win32'
    ? join(prefix, 'dshc.cmd')
    : join(prefix, 'bin', 'dshc')
  await access(command)
  // npm's Windows shim is a .cmd file, which Node 24 intentionally does not
  // execute with shell=false. Verify the shim exists, then drive the exact
  // installed JS entry without weakening argument boundaries through a shell.
  const installedEntry = process.platform === 'win32'
    ? join(prefix, 'node_modules', ...manifest.name.split('/'), 'dist', 'cli', 'bin.js')
    : command
  const installedCommand = process.platform === 'win32' ? process.execPath : command
  const installedPrefix = process.platform === 'win32' ? [installedEntry] : []
  await access(installedEntry)

  const version = await run(installedCommand, [...installedPrefix, '--version'], { cwd: tempRoot })
  assert(version.stdout.trim() === manifest.version, `--version returned ${JSON.stringify(version.stdout.trim())}`)

  const help = await run(installedCommand, [...installedPrefix, '--help'], { cwd: tempRoot })
  assert(help.stdout.includes('DeepSeek Harness Console'), 'installed --help did not render the CLI contract')

  const doctorEnv = { ...process.env }
  delete doctorEnv.DEEPSEEK_API_KEY
  doctorEnv.DEEPSEEK_BASE_URL = 'http://127.0.0.1:1'
  doctorEnv.DSH_HOME = join(tempRoot, '.dsh-home')
  doctorEnv.DSH_SESSION_ROOT = join(tempRoot, '.dsh-sessions')
  const doctor = await run(installedCommand, [...installedPrefix,
    'doctor',
    '--workspace', workspace,
    '--request-timeout-ms', '10000',
    '--json',
  ], { cwd: tempRoot, env: doctorEnv })
  const report = JSON.parse(doctor.stdout)
  assert(report.ok === true, 'installed doctor did not report ok=true')
  assert(report.dshcVersion === manifest.version, 'installed doctor reported the wrong dshc version')
  assert(report.runtime?.serverName === 'deepseek-harness-sdk-runtime', 'installed runtime did not initialize')
  assert(report.runtime?.protocolVersion === '0.0.1', 'installed runtime reported an incompatible protocol')

  // Reinstalling the selected alpha is the documented update/repair path.
  await runNpm(['install', ...npmArgs, '--force', tarball], { cwd: tempRoot })
  const updated = await run(installedCommand, [...installedPrefix, '--version'], { cwd: tempRoot })
  assert(updated.stdout.trim() === manifest.version, 'reinstalled CLI returned the wrong version')

  await runNpm([
    'uninstall',
    '--global',
    '--prefix', prefix,
    '--no-audit',
    '--no-fund',
    manifest.name,
  ], { cwd: tempRoot })
  let commandStillExists = true
  try {
    await access(command)
  } catch {
    commandStillExists = false
  }
  assert(!commandStillExists, 'npm uninstall left the dshc command behind')

  process.stdout.write(`Installed package smoke OK: ${manifest.name}@${manifest.version}\n`)
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}

async function resolveTarball(input) {
  if (input === undefined) {
    const destination = join(tempRoot, 'package')
    await mkdir(destination, { recursive: true })
    const result = await runNpm([
      'pack',
      '--json',
      '--pack-destination', destination,
    ], { cwd: root })
    const [report] = JSON.parse(result.stdout)
    assert(typeof report?.filename === 'string', 'npm pack did not return a tarball filename')
    return join(destination, report.filename)
  }

  const candidate = resolve(input)
  const info = await stat(candidate)
  if (info.isFile()) return candidate
  const tarballs = (await readdir(candidate))
    .filter(name => name.endsWith('.tgz'))
    .map(name => join(candidate, name))
  assert(tarballs.length === 1, `expected one tarball in ${candidate}, found ${tarballs.length}`)
  return tarballs[0]
}

async function run(command, args, options) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) {
        resolvePromise({ stdout, stderr })
        return
      }
      reject(new Error([
        `${command} ${args.join(' ')} exited with ${code}`,
        stdout,
        stderr,
      ].filter(Boolean).join('\n')))
    })
  })
}

async function runNpm(args, options) {
  const invocation = npmInvocation(args)
  return await run(invocation.command, invocation.args, {
    ...options,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_cache: join(tempRoot, 'npm-cache'),
      npm_config_fund: 'false',
      npm_config_registry: 'https://registry.npmjs.org/',
      ...options.env,
    },
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
