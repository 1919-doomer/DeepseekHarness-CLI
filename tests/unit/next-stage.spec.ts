import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePreferences, validatePreferences } from '../../src/preferences.js'
import { CATALOGS, resolveLocale, translate } from '../../src/i18n.js'
import { PromptQueue } from '../../src/terminal/prompt-queue.js'
import { expandTemplate, completeFileReference } from '../../src/terminal/input-actions.js'
import { EventTail } from '../../src/upstream/event-tail.js'
import { parseBundleSpec, inspectBundleArchive } from '../../src/upstream/bundle-source.js'
import { bundleArchive, testBundle } from '../fixtures/bundle.js'

describe('preferences and input contracts', () => {
  it('resolves CLI > workspace > user, validates keys and preserves machine identifiers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-settings-'))
    try {
      await mkdir(join(root, '.dshc')); await mkdir(join(root, 'user'))
      await writeFile(join(root, 'user', 'settings.json'), JSON.stringify({ locale: 'zh-CN', style: 'learning' }))
      await writeFile(join(root, '.dshc', 'settings.json'), JSON.stringify({ locale: 'en', mode: 'review' }))
      const resolved = await resolvePreferences(root, { locale: 'auto' }, { DSHC_HOME: join(root, 'user') })
      expect(resolved.values).toMatchObject({ locale: 'auto', mode: 'review', style: 'learning' })
      expect(resolved.sources).toMatchObject({ locale: 'cli', mode: 'workspace', style: 'user' })
      expect(() => validatePreferences({ apiKey: 'not-a-secret' })).toThrow('Unknown settings key')
      expect(() => validatePreferences({ keybindings: { externalEditor: 'ctrl+o' } })).toThrow('Duplicate')
      expect(Object.keys(CATALOGS.en).sort()).toEqual(Object.keys(CATALOGS['zh-CN']).sort())
      expect(resolveLocale('auto', { LANG: 'zh_CN.UTF-8' })).toBe('zh-CN')
      expect(translate('zh-CN', 'queued', { count: 3 })).toContain('3')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('expands text without execution and completes references without reading contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dshc-input-'))
    try {
      await mkdir(join(root, '.dshc', 'templates'), { recursive: true })
      await writeFile(join(root, '.dshc', 'templates', 'review.md'), 'Review $1: $ARGUMENTS; $(echo never-executed)')
      await writeFile(join(root, 'hello world.txt'), 'not-inlined')
      expect(await expandTemplate(root, 'review', ['file.ts', 'carefully'])).toBe('Review file.ts: file.ts carefully; $(echo never-executed)')
      await expect(expandTemplate(root, '../escape', [])).rejects.toThrow('Invalid template')
      expect(await completeFileReference(root, 'Read @hel')).toEqual(['Read @"hello world.txt"'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('pauses queues across task failure/session changes and requires matching session resume', () => {
    const queue = new PromptQueue()
    queue.add('old', 'one'); queue.add('old', 'two')
    queue.pause(); expect(queue.take('old')).toBeUndefined()
    expect(() => queue.resume('new')).toThrow()
    queue.edit(1, 'edited'); queue.resume('old')
    expect(queue.take('old')?.text).toBe('edited')
    expect(queue.withdraw()).toBe('two')
    expect(queue.list()).toEqual([])
  })
  it('bounds runtime tails without changing observation counts', () => {
    const tail = new EventTail<number>(3)
    for (let index = 0; index < 100; index++) tail.push(index)
    expect(tail.snapshot()).toEqual([97, 98, 99]); expect(tail.dropped).toBe(97)
  })
  it('requires exact prebuilt Bundle identities and a real bundle declaration', () => {
    expect(parseBundleSpec('community-bundle@1.2.3')).toEqual({ name: 'community-bundle', version: '1.2.3' })
    for (const spec of ['x@latest', 'x@^1.0.0', 'github:owner/repo', '../source']) expect(() => parseBundleSpec(spec)).toThrow()
    expect(inspectBundleArchive(testBundle())).toMatchObject({ name: 'dshc-test-bundle', version: '1.0.0', patchText: '[]\n' })
    expect(() => inspectBundleArchive(bundleArchive({ 'package.json': '{"name":"x","version":"1.0.0"}' }))).toThrow('dsh.bundle.patch')
    expect(() => inspectBundleArchive(bundleArchive({ '../escape': '' }))).toThrow('paths')
  })
})
