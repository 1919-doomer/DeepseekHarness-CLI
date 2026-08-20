import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../../src/cli/args.js'

describe('doctor CLI parsing', () => {
  it('parses doctor with diagnostic-safe options and no prompt', () => {
    expect(parseCliArgs([
      'doctor',
      '--workspace',
      '/repo',
      '--provider',
      'deepseek-official',
      '--model',
      'deepseek-v4-flash',
      '--runtime-config',
      '/runtime/cordis.yml',
      '--request-timeout-ms',
      '9000',
      '--json',
    ])).toMatchObject({
      command: 'doctor',
      workspace: '/repo',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      runtimeConfig: '/runtime/cordis.yml',
      requestTimeoutMs: 9000,
      json: true,
      prompt: undefined,
    })
  })

  it('keeps a positional token visible so mode validation can reject doctor prompts', () => {
    expect(parseCliArgs(['doctor', 'do not send this'])).toMatchObject({
      command: 'doctor',
      prompt: 'do not send this',
    })
  })
})
