import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { captureProcess } from '../../src/upstream/process.js'
import { readWorkspaceDiff } from '../../src/plugins/diff.js'

it('shows staged and unstaged changes without invoking configured diff drivers or treating paths as patterns', async () => {
  const root = await mkdtemp(resolve('node_modules/dshc-diff-'))
  const git = (...args: string[]) => captureProcess('git', args, { cwd: root })
  try {
    await git('init')
    await git('config', 'user.name', 'fixture')
    await git('config', 'user.email', 'fixture@example.invalid')
    await writeFile(join(root, '[a].txt'), 'before\n')
    await writeFile(join(root, 'a.txt'), 'other\n')
    await writeFile(join(root, '.gitattributes'), '*.txt diff=fixture\n')
    await git('add', '.')
    await git('-c', 'core.hooksPath=', 'commit', '-m', 'fixture')
    await git('config', 'diff.fixture.command', 'dshc-fixture-command-must-never-run')
    await git('config', 'diff.fixture.textconv', 'dshc-fixture-textconv-must-never-run')
    await writeFile(join(root, '[a].txt'), 'staged\n')
    await git('add', '[a].txt')
    await writeFile(join(root, '[a].txt'), 'unstaged\n')
    await writeFile(join(root, 'a.txt'), 'unrelated\n')
    const before = await git('status', '--porcelain')
    expect(await readWorkspaceDiff(root, true, '[a].txt')).toContain('+staged')
    const diff = await readWorkspaceDiff(root, false, '[a].txt')
    expect(diff).toContain('+unstaged')
    expect(diff).not.toContain('unrelated')
    expect(await git('status', '--porcelain')).toBe(before)
    expect(await readFile(join(root, '[a].txt'), 'utf8')).toBe('unstaged\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})
