import { describe, expect, it } from 'vitest'
import { parseInteractiveInput } from '../../src/commands/interactive.js'

describe('parseInteractiveInput', () => {
  it('keeps ordinary text as a model prompt', () => {
    expect(parseInteractiveInput('inspect the repo')).toEqual({ kind: 'prompt', text: 'inspect the repo' })
  })

  it('routes supported slash commands locally', () => {
    for (const command of ['help', 'status', 'session', 'new', 'clear', 'exit'] as const) {
      expect(parseInteractiveInput(`/${command}`)).toEqual({ kind: 'command', command })
    }
  })

  it('never treats an unknown slash command as model input', () => {
    expect(parseInteractiveInput('/danger')).toEqual({ kind: 'unknown-command', name: '/danger' })
    expect(parseInteractiveInput('/status extra')).toEqual({ kind: 'unknown-command', name: '/status' })
  })

  it('uses a doubled slash to send a literal slash-prefixed prompt', () => {
    expect(parseInteractiveInput('//review README.md')).toEqual({ kind: 'prompt', text: '/review README.md' })
  })

  it('ignores blank lines', () => {
    expect(parseInteractiveInput('   ')).toEqual({ kind: 'empty' })
  })
})
