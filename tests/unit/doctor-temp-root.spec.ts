import { describe, expect, it } from 'vitest'
import { shellTempRootFacts, type DoctorFinding } from '../../src/cli/doctor.js'
import { startupWarnings } from '../../src/cli/main.js'

function run(
  workspace: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = 'win32',
): DoctorFinding[] {
  const findings: DoctorFinding[] = []
  shellTempRootFacts(workspace, env, findings, platform)
  return findings
}

const HOME = String.raw`C:\Users\someone`
const HOME_TEMP = String.raw`C:\Users\someone\AppData\Local\Temp`
const PROJECT = String.raw`C:\work\project`

describe('shell sandbox temp-root preflight', () => {
  it('fails when the temporary root resolves inside the workspace', () => {
    // The upstream Windows shell sandbox refuses this, so every shell call
    // fails while the rest of doctor still looks healthy.
    const [finding] = run(HOME, { TEMP: HOME_TEMP })
    expect(finding).toMatchObject({ id: 'shell.temp-root', status: 'FAIL' })
    expect(finding?.summary).toContain('every platform shell call will fail')
  })

  it('passes when the temporary root is outside the workspace', () => {
    expect(run(PROJECT, { TEMP: HOME_TEMP })[0]).toMatchObject({
      id: 'shell.temp-root',
      status: 'PASS',
    })
  })

  it('treats the workspace itself as contained', () => {
    expect(run(String.raw`C:\tmp`, { TEMP: String.raw`C:\tmp` })[0]).toMatchObject({ status: 'FAIL' })
  })

  it('does not mistake a sibling for a child on a shared prefix', () => {
    // C:\work\project-tmp is not inside C:\work\project.
    expect(run(PROJECT, { TEMP: String.raw`C:\work\project-tmp` })[0]).toMatchObject({
      status: 'PASS',
    })
  })

  it('falls back to TMP when TEMP is unset', () => {
    expect(run(String.raw`C:\work`, { TMP: String.raw`C:\work\tmp` })[0]).toMatchObject({
      status: 'FAIL',
    })
  })

  it('warns rather than guessing when neither TEMP nor TMP is set', () => {
    expect(run(String.raw`C:\work`, {})[0]).toMatchObject({
      id: 'shell.temp-root',
      status: 'WARN',
    })
  })

  it('reports nothing on platforms without the Windows ACL sandbox rule', () => {
    expect(run('/home/someone', { TEMP: '/home/someone/tmp' }, 'linux')).toEqual([])
    expect(run('/Users/someone', { TEMP: '/Users/someone/tmp' }, 'darwin')).toEqual([])
  })

  it('explains the same failure before an interactive session starts without changing TEMP', () => {
    const env = { TEMP: String.raw`C:\work\tmp` }
    const warning = startupWarnings(String.raw`C:\work`, env, false, 'win32')
    expect(warning).toContain('Windows shell unavailable in this workspace')
    expect(warning).toContain('will not relocate TEMP or weaken the Harness sandbox')
    expect(env.TEMP).toBe(String.raw`C:\work\tmp`)
  })
})
