import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectDoctorReport,
  doctorExitCode,
  renderDoctorHuman,
} from '../../src/cli/doctor.js'
import { stringifyTerminalSafeJson } from '../../src/terminal/sanitize.js'

const fakeRuntimePath = fileURLToPath(new URL('../fixtures/doctor-runtime.mjs', import.meta.url))
const tempRoots: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dshc-doctor-'))
  tempRoots.push(root)
  return root
}

function fakeLaunch(root: string, mode: string, logPath: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return {
    command: process.execPath,
    args: [fakeRuntimePath],
    cwd: root,
    env: {
      ...process.env,
      ...extraEnv,
      DSHC_DOCTOR_FAKE_MODE: mode,
      DSHC_DOCTOR_FAKE_LOG: logPath,
    },
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 500,
    disposeEofGraceMs: 500,
    disposeGraceMs: 500,
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('dshc doctor fake-runtime integration', () => {
  it('performs initialize + shutdown only and reports credential presence without leaking its value', async () => {
    const root = await workspace()
    const logPath = join(root, 'methods.log')
    const secret = 'doctor-secret-value-12345\u001b]52;c;attack\u0007'
    const env = {
      ...process.env,
      DEEPSEEK_API_KEY: secret,
    }

    const report = await collectDoctorReport({
      workspace: root,
      skipInstalledVersionCheck: true,
      launchOverride: fakeLaunch(root, 'success', logPath, { DEEPSEEK_API_KEY: secret }),
      env,
      stdin: { isTTY: false, isRaw: false },
      stdout: { isTTY: false },
      stderr: { isTTY: false },
    })

    expect(doctorExitCode(report)).toBe(0)
    expect(report.ok).toBe(true)
    expect(report.credential).toEqual({
      provider: 'deepseek-official',
      environmentVariable: 'DEEPSEEK_API_KEY',
      present: true,
    })
    expect(report.runtime).toMatchObject({
      serverName: 'deepseek-harness-sdk-runtime',
      protocolVersion: '0.0.1',
    })
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'runtime.initialize', status: 'PASS' }),
      expect.objectContaining({ id: 'terminal', status: 'WARN' }),
    ]))

    const methods = (await readFile(logPath, 'utf8')).trim().split('\n')
    expect(methods).toEqual(['initialize', 'shutdown'])
    expect(methods).not.toContain('session/prompt')

    const human = renderDoctorHuman(report)
    const json = stringifyTerminalSafeJson(report)
    expect(human).not.toContain(secret)
    expect(json).not.toContain(secret)
    expect(JSON.parse(json)).toMatchObject({ schemaVersion: 1, ok: true })
  })

  it.each([
    ['bad-version', 'Unsupported Harness SDK protocol'],
    ['bad-server', 'Unexpected Harness server identity'],
  ])('fails compatibility for %s initialize identity', async (mode, message) => {
    const root = await workspace()
    const logPath = join(root, `${mode}.log`)
    const report = await collectDoctorReport({
      workspace: root,
      skipInstalledVersionCheck: true,
      launchOverride: fakeLaunch(root, mode, logPath),
    })

    expect(doctorExitCode(report)).toBe(1)
    expect(report.ok).toBe(false)
    expect(report.runtime).toBeUndefined()
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'runtime.initialize',
        status: 'FAIL',
        category: 'compatibility',
        summary: expect.stringContaining(message),
      }),
    ]))
    expect((await readFile(logPath, 'utf8')).trim().split('\n')).not.toContain('session/prompt')
  })

  it('classifies malformed initialize as a protocol failure', async () => {
    const root = await workspace()
    const logPath = join(root, 'malformed.log')
    const report = await collectDoctorReport({
      workspace: root,
      skipInstalledVersionCheck: true,
      launchOverride: fakeLaunch(root, 'malformed', logPath),
    })

    expect(doctorExitCode(report)).toBe(1)
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'runtime.initialize', status: 'FAIL', category: 'protocol' }),
    ]))
  })

  it('does not launch the Harness child when workspace/config preflight fails', async () => {
    const root = await workspace()
    const logPath = join(root, 'must-not-launch.log')
    const missingWorkspace = join(root, 'missing-workspace')
    const missingConfig = join(root, 'missing-cordis.yml')

    const report = await collectDoctorReport({
      workspace: missingWorkspace,
      configPath: missingConfig,
      skipInstalledVersionCheck: true,
      launchOverride: fakeLaunch(root, 'success', logPath),
    })

    expect(doctorExitCode(report)).toBe(1)
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'workspace', status: 'FAIL' }),
      expect.objectContaining({ id: 'runtime.config', status: 'FAIL' }),
      expect.objectContaining({ id: 'runtime.initialize', status: 'UNKNOWN' }),
      expect.objectContaining({ id: 'composition.override', status: 'WARN' }),
    ]))
    await expect(readFile(logPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('labels a readable runtime-config override without claiming shipped composition facts', async () => {
    const root = await workspace()
    const logPath = join(root, 'override.log')
    const config = join(root, 'custom.yml')
    await writeFile(config, '# custom deployment\n', 'utf8')

    const report = await collectDoctorReport({
      workspace: root,
      configPath: config,
      skipInstalledVersionCheck: true,
      launchOverride: fakeLaunch(root, 'success', logPath),
    })

    expect(report.runtimeConfig).toEqual({ path: config, source: 'override' })
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'composition.override', status: 'WARN' }),
    ]))
    expect(report.findings.some(finding => finding.id === 'composition.sandbox')).toBe(false)
  })
})
