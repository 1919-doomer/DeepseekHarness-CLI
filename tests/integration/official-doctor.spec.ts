import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { TESTED_CORDIS_BASELINE, TESTED_DSH_BASELINE } from '../../src/upstream/compatibility.js'

const cliEntry = fileURLToPath(new URL('../../dist/cli/bin.js', import.meta.url))
const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('published DeepSeek Harness doctor', () => {
  it('runs built dshc doctor through initialize + shutdown with no provider credential or model request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-official-doctor-'))
    tempRoots.push(root)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: join(root, '.dsh-home'),
      DSH_SESSION_ROOT: join(root, '.dsh-sessions'),
      // If doctor accidentally issues a model request it must fail rather than
      // reaching any real endpoint. initialize itself does not use this URL.
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
    }
    delete env.DEEPSEEK_API_KEY

    const result = await runProcess(
      process.execPath,
      [cliEntry, 'doctor', '--workspace', root, '--request-timeout-ms', '10000', '--json'],
      env,
      root,
    )

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout) as Record<string, unknown>
    expect(report).toMatchObject({
      schemaVersion: 1,
      ok: true,
      workspace: root,
      runtimeConfig: { source: 'shipped-default' },
      selection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      credential: {
        provider: 'deepseek-official',
        environmentVariable: 'DEEPSEEK_API_KEY',
        present: false,
      },
      runtime: {
        serverName: 'deepseek-harness-sdk-runtime',
        protocolVersion: '0.0.1',
        sdkVersion: TESTED_DSH_BASELINE.sdkVersion,
        runtimePackageVersion: TESTED_DSH_BASELINE.runtimePackageVersion,
      },
    })

    const findings = report['findings']
    expect(Array.isArray(findings)).toBe(true)
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'credential', status: 'WARN' }),
      expect.objectContaining({ id: 'runtime.initialize', status: 'PASS' }),
      expect.objectContaining({ id: 'composition.sandbox', status: 'PASS' }),
      expect.objectContaining({ id: 'composition.approval', status: 'PASS' }),
      expect.objectContaining({ id: 'retention', status: 'PASS' }),
      expect.objectContaining({ id: 'history.reader', status: 'PASS' }),
      expect.objectContaining({ id: 'bridge.protocol', status: 'UNKNOWN' }),
      expect.objectContaining({ id: 'approval.answerer', status: 'UNKNOWN' }),
      expect.objectContaining({ id: 'context.capacity', status: 'UNKNOWN' }),
      expect.objectContaining({ id: 'prompt.runtime-inspection', status: 'UNKNOWN' }),
    ]))
  }, 30_000)

  it('validates developer composition without credentials or executing dynamic code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-official-dev-doctor-'))
    tempRoots.push(root)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: join(root, '.dsh-home'),
      DSH_SESSION_ROOT: join(root, '.dsh-sessions'),
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
    }
    delete env.DEEPSEEK_API_KEY

    const result = await runProcess(
      process.execPath,
      [cliEntry, 'doctor', '--dev', '--workspace', root, '--request-timeout-ms', '10000', '--json'],
      env,
      root,
    )

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout) as Record<string, unknown>
    expect(report).toMatchObject({
      schemaVersion: 1,
      ok: true,
      devMode: true,
      workspace: root,
      runtimeConfig: {
        source: 'shipped-default',
        patchPaths: [expect.stringMatching(/cordis\.dev\.patch\.yml$/u)],
      },
      credential: {
        environmentVariable: 'DEEPSEEK_API_KEY',
        present: false,
      },
      runtime: {
        serverName: TESTED_DSH_BASELINE.serverName,
        protocolVersion: TESTED_DSH_BASELINE.protocolVersion,
      },
    })

    const findings = report['findings']
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'credential', status: 'WARN' }),
      expect.objectContaining({ id: 'workbench.mode', status: 'WARN' }),
      expect.objectContaining({ id: 'workbench.patch-order', status: 'PASS' }),
      expect.objectContaining({
        id: 'workbench.packages',
        status: 'PASS',
        summary: expect.stringContaining(TESTED_CORDIS_BASELINE.hostRunnerVersion),
      }),
      expect.objectContaining({ id: 'composition.dev-patch', status: 'PASS' }),
      expect.objectContaining({ id: 'runtime.initialize', status: 'PASS' }),
    ]))
  }, 30_000)
})

async function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
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
    child.once('exit', code => resolve({ code, stdout, stderr }))
  })
}
