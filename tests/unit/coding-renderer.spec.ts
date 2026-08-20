import { describe, expect, it } from 'vitest'
import { createDefaultTerminalHost } from '../../src/plugins/builtins.js'
import { initialTerminalTranscript, reduceTerminalEvent, terminalBlockId } from '../../src/terminal/transcript.js'

const activity = 'activity-m4'

describe('M4.2 coding activity presentation', () => {
  it('renders filesystem intent concisely and lets the generic result patch finish the same block', () => {
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    state = reduceTerminalEvent(state, {
      sequence: 0,
      kind: 'tool-call',
      sessionId: 'root',
      callId: 'read-1',
      name: 'read',
      arguments: JSON.stringify({ file_path: 'src/app.ts' }),
    }, host, activity, 'root')

    const id = terminalBlockId('tool', activity, 'root', 'read-1')
    expect(state.blocks.find(block => block.id === id)).toMatchObject({
      title: 'read · src/app.ts',
      text: 'Inspect file',
      state: 'running',
      sessionId: 'root',
    })

    state = reduceTerminalEvent(state, {
      sequence: 1,
      kind: 'tool-result',
      sessionId: 'root',
      callId: 'read-1',
      text: '<content>hello</content>',
      isError: false,
    }, host, activity, 'root')

    expect(state.blocks.find(block => block.id === id)).toMatchObject({
      title: 'read · src/app.ts',
      text: 'Inspect file',
      detail: '<content>hello</content>',
      state: 'success',
    })
  })

  it('keeps state-changing edit and shell intent inspectable while sanitizing hostile text', () => {
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    state = reduceTerminalEvent(state, {
      sequence: 0,
      kind: 'tool-call',
      sessionId: 'child-session',
      callId: 'edit-1',
      name: 'edit',
      arguments: JSON.stringify({
        file_path: 'src/evil\u001b[31m.ts',
        old_string: 'before\u202e',
        new_string: 'after\u001b]0;pwned\u0007',
      }),
    }, host, activity, 'root')
    state = reduceTerminalEvent(state, {
      sequence: 1,
      kind: 'tool-call',
      sessionId: 'root',
      callId: 'shell-1',
      name: process.platform === 'win32' ? 'pwsh' : 'bash',
      arguments: JSON.stringify({
        command: 'printf "safe"\u001b[2J',
        description: 'Verify\u001b[31m change',
      }),
    }, host, activity, 'root')

    const edit = state.blocks.find(block => block.id === terminalBlockId('tool', activity, 'child-session', 'edit-1'))
    const shell = state.blocks.find(block => block.id === terminalBlockId('tool', activity, 'root', 'shell-1'))
    expect(edit?.title).toContain('edit · src/evil\\x1b[31m.ts')
    expect(edit?.title).toContain('child-s')
    expect(edit?.text).toContain('u202e')
    expect(edit?.text).toContain('x1b]0;pwned')
    expect(edit?.text).toContain('x07')
    expect(edit?.title).not.toContain('\u001b')
    expect(edit?.text).not.toContain('\u001b')
    expect(edit?.text).not.toContain('\u0007')
    expect(edit?.text).not.toContain('\u202e')
    expect(shell?.title).toContain('Verify\\x1b[31m change')
    expect(shell?.text).toContain('\\x1b[2J')
    expect(shell?.text).not.toContain('\u001b')
  })

  it('summarizes search and todo activity without hiding the DSH tool identity', () => {
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    state = reduceTerminalEvent(state, {
      sequence: 0,
      kind: 'tool-call',
      sessionId: 'root',
      callId: 'grep-1',
      name: 'grep',
      arguments: JSON.stringify({ pattern: 'needle', path: 'src', include: '*.{ts,tsx}' }),
    }, host, activity, 'root')
    state = reduceTerminalEvent(state, {
      sequence: 1,
      kind: 'tool-call',
      sessionId: 'root',
      callId: 'todo-1',
      name: 'todo_write',
      arguments: JSON.stringify({ todos: [
        { content: 'inspect', status: 'completed' },
        { content: 'test', status: 'in_progress' },
      ] }),
    }, host, activity, 'root')

    expect(state.blocks.find(block => block.id.includes('grep-1'))).toMatchObject({
      title: 'grep · needle',
      text: 'Search src · *.{ts,tsx}',
    })
    expect(state.blocks.find(block => block.id.includes('todo-1'))).toMatchObject({
      title: 'todo · 2 items',
      text: 'completed:1 · in_progress:1',
    })
  })

  it('falls malformed or incomplete known-tool calls and unknown tools back to the generic sanitized renderer', () => {
    const host = createDefaultTerminalHost()
    let state = initialTerminalTranscript()
    state = reduceTerminalEvent(state, {
      sequence: 0,
      kind: 'tool-call',
      sessionId: 'root',
      callId: 'bad-read',
      name: 'read',
      arguments: '{not-json\u001b[31m',
    }, host, activity, 'root')
    state = reduceTerminalEvent(state, {
      sequence: 1,
      kind: 'tool-call',
      sessionId: 'root',
      callId: 'future-edit-shape',
      name: 'edit',
      arguments: JSON.stringify({ file_path: 'src/app.ts', future_patch: 'opaque' }),
    }, host, activity, 'root')
    state = reduceTerminalEvent(state, {
      sequence: 2,
      kind: 'tool-call',
      sessionId: 'root',
      callId: 'custom',
      name: 'custom_tool',
      arguments: '{"value":"x"}',
    }, host, activity, 'root')

    expect(state.blocks.find(block => block.id.includes('bad-read'))).toMatchObject({
      title: 'tool · read',
      text: '{not-json\\x1b[31m',
    })
    expect(state.blocks.find(block => block.id.includes('future-edit-shape'))).toMatchObject({
      title: 'tool · edit',
      text: '{"file_path":"src/app.ts","future_patch":"opaque"}',
    })
    expect(state.blocks.find(block => block.id.includes('custom'))).toMatchObject({
      title: 'tool · custom_tool',
      text: '{"value":"x"}',
    })
  })

  it('labels the shipped coding baseline as local validation, not discovered runtime inventory', () => {
    const host = createDefaultTerminalHost()
    const capabilities = host.resolveView('capabilities')?.render({
      runtime: {
        workspace: '/workspace',
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        serverName: 'deepseek-harness-sdk-runtime',
        protocolVersion: '0.0.1',
      },
      session: { sessionId: 'root', turnCount: 0, generation: 0 },
      phase: 'idle',
      totalTurns: 0,
      commands: host.listCommands(),
      renderers: host.listRenderers(),
      plugins: host.listPlugins(),
      events: [],
    }) ?? ''

    expect(capabilities).toContain('runtime plugin inventory: partial/unavailable')
    expect(capabilities).toContain('Shipped default coding baseline')
    expect(capabilities).toContain('not runtime discovery')
    expect(capabilities).toContain('overrides may differ')
    expect(capabilities).toContain('read, write, edit, glob, grep')
    expect(capabilities).toContain(process.platform === 'win32' ? 'pwsh' : 'bash')
    expect(host.listRenderers()[0]).toMatchObject({ id: 'coding-tool-call', priority: 120, pluginId: 'dshc.coding' })
  })
})
