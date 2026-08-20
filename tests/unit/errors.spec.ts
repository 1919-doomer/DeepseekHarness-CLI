import { describe, expect, it } from 'vitest'
import { redactSensitiveText } from '../../src/upstream/errors.js'

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
})
