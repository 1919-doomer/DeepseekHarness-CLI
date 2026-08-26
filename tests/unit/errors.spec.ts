import { describe, expect, it } from 'vitest'
import { classifyRuntimeError, DshcRuntimeError, redactSensitiveText } from '../../src/upstream/errors.js'

describe('redactSensitiveText', () => {
  it('removes configured secrets and bearer-like credentials', () => {
    const env = {
      DEEPSEEK_API_KEY: 'super-secret-1234',
      NORMAL_VALUE: 'not-sensitive',
    }
    const text = 'provider said super-secret-1234; Authorization: Bearer abcdefghijklmnop; sk-test_token_12345678'
    const redacted = redactSensitiveText(text, env)
    expect(redacted).not.toContain('super-secret-1234')
    expect(redacted).not.toContain('abcdefghijklmnop')
    expect(redacted).not.toContain('sk-test_token_12345678')
    expect(redacted).toContain('[REDACTED]')
  })

  it('redacts an already classified runtime error before presentation', () => {
    const error = new DshcRuntimeError(
      'registry failed with top-secret-value at https://alice:hunter2@mirror.example/npm?token=query-secret',
      'runtime',
    )
    const classified = classifyRuntimeError(error, {
      PASSWORD: 'top-secret-value',
      npm_config_registry: 'https://alice:hunter2@mirror.example/npm?token=query-secret',
    })
    expect(classified.code).toBe('runtime')
    expect(classified.message).toBe(
      'registry failed with [REDACTED] at https://***@mirror.example/npm?token=[REDACTED]',
    )
  })
})
