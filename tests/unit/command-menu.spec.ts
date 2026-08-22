import { describe, expect, it } from 'vitest'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
import { commandSuggestions } from '../../src/terminal/product.js'
import {
  selectVisibleBlocks,
} from '../../src/terminal/product.js'
import type { TranscriptBlock } from '../../src/plugins/api.js'

const commands = createDefaultTerminalHost().listCommands()

describe('slash command menu', () => {
  it('lists every registered command on a bare slash', () => {
    const names = commandSuggestions('/', commands).map(item => item.name)
    expect(names).toEqual(commands.map(command => command.name))
    expect(names).toContain('tools')
    expect(names).toContain('trace')
  })

  it('narrows as the name is typed', () => {
    expect(commandSuggestions('/tr', commands).map(item => item.name)).toEqual(['trace'])
    expect(commandSuggestions('/nope', commands)).toEqual([])
  })

  it('is case-insensitive about what was typed', () => {
    expect(commandSuggestions('/TR', commands).map(item => item.name)).toEqual(['trace'])
  })

  it('carries each command summary, so the menu explains itself', () => {
    const help = commandSuggestions('/help', commands)[0]
    expect(help?.summary.length).toBeGreaterThan(0)
  })

  it('stays out of the way of an escaped prompt and of ordinary text', () => {
    expect(commandSuggestions('//literal', commands)).toEqual([])
    expect(commandSuggestions('what is this', commands)).toEqual([])
    expect(commandSuggestions('', commands)).toEqual([])
  })

  it('closes once an argument is being typed', () => {
    // Past the command name the user is no longer choosing one.
    expect(commandSuggestions('/trace ', commands)).toEqual([])
    expect(commandSuggestions('/trace errors', commands)).toEqual([])
  })

  it('is built from the registry, so it cannot fall behind it', () => {
    // Every registered command must be reachable from a bare slash; a menu
    // maintained separately is what let `dshc --help` drift for two milestones.
    const suggested = new Set(commandSuggestions('/', commands).map(item => item.name))
    for (const command of commands) expect(suggested.has(command.name)).toBe(true)
  })
})

describe('condensed review', () => {
  const block = (id: string, kind: TranscriptBlock['kind']): TranscriptBlock => ({
    id, kind, title: id, text: 'body line one\nbody line two\nbody line three', detail: 'detail text',
  })

  it('fits more activity on screen while scrolled back', () => {
    const blocks = Array.from({ length: 10 }, (_, index) => block(`t${index}`, 'tool'))
    const atRest = selectVisibleBlocks(blocks, 24, 80, 0).blocks.length
    // Reviewing collapses a call to its header, so more of them fit.
    const reviewing = selectVisibleBlocks(blocks, 24, 80, 1).blocks.length
    expect(reviewing).toBeGreaterThan(atRest)
  })

  it('does not collapse prose, which is what the reader is looking for', () => {
    const blocks = Array.from({ length: 10 }, (_, index) => block(`a${index}`, 'assistant'))
    expect(selectVisibleBlocks(blocks, 24, 80, 1).blocks.length)
      .toBe(selectVisibleBlocks(blocks, 24, 80, 0).blocks.length)
  })
})
