import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DSHC_VERSION } from '../../src/version.js'

describe('version declaration', () => {
  it('matches the packaged version', () => {
    // The version is declared twice: package.json is what npm ships, and
    // src/version.ts is what `dshc --version`, the banner and doctor report.
    // A release where they disagree misreports the build a user is running.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { version?: unknown }

    expect(manifest.version).toBe(DSHC_VERSION)
  })
})
