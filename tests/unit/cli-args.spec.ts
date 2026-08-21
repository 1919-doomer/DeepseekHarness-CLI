import { describe, expect, it } from 'vitest'
import { parseCliArgs } from '../../src/cli/args.js'

describe('CLI argument separator handling', () => {
  it('resolves a subcommand that a package manager pushed behind a leading --', () => {
    expect(parseCliArgs(['--', 'doctor'])).toMatchObject({ command: 'doctor' })
    expect(Object.hasOwn(parseCliArgs(['--', 'doctor']), 'prompt')).toBe(false)
  })

  it('keeps options that follow a package-manager separator', () => {
    const options = parseCliArgs(['--', 'doctor', '--json', '--workspace', '/repo'])
    expect(options).toMatchObject({ command: 'doctor', json: true, workspace: '/repo' })
    expect(Object.hasOwn(options, 'prompt')).toBe(false)
  })

  it('still forwards an ordinary prompt that follows a leading separator', () => {
    expect(parseCliArgs(['--', 'inspect this repository'])).toMatchObject({
      command: 'auto',
      prompt: 'inspect this repository',
    })
  })

  it('preserves POSIX end-of-options semantics for a dashed prompt', () => {
    expect(parseCliArgs(['--', '--dashed-prompt'])).toMatchObject({
      command: 'auto',
      prompt: '--dashed-prompt',
    })
  })

  it('preserves a non-leading separator as end-of-options', () => {
    expect(parseCliArgs(['prompt', '--', '--after'])).toMatchObject({
      command: 'auto',
      prompt: 'prompt --after',
    })
  })

  it('treats a lone separator as no prompt at all', () => {
    const options = parseCliArgs(['--'])
    expect(options).toMatchObject({ command: 'auto' })
    expect(Object.hasOwn(options, 'prompt')).toBe(false)
  })

  it('keeps run as the explicit way to send a subcommand name as a prompt', () => {
    expect(parseCliArgs(['run', 'doctor'])).toMatchObject({ command: 'run', prompt: 'doctor' })
    expect(parseCliArgs(['--', 'run', 'doctor'])).toMatchObject({ command: 'run', prompt: 'doctor' })
  })

  it('leaves direct subcommand invocation unchanged', () => {
    expect(parseCliArgs(['doctor', '--json'])).toMatchObject({ command: 'doctor', json: true })
    expect(parseCliArgs(['some prompt'])).toMatchObject({ command: 'auto', prompt: 'some prompt' })
  })
})
