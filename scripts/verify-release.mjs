#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME

if (tag === undefined || tag.length === 0) {
  throw new Error('Pass the release tag or set GITHUB_REF_NAME')
}
if (!/^0\.1\.0-alpha\.\d+$/.test(manifest.version)) {
  throw new Error(`Public-alpha workflow cannot publish version ${manifest.version}`)
}
if (tag !== `v${manifest.version}`) {
  throw new Error(`Release tag ${tag} does not match package version v${manifest.version}`)
}
if (manifest.name !== '@1919-doomer/dshc' || manifest.private !== false) {
  throw new Error('Release package identity is not finalized')
}
if (manifest.publishConfig?.access !== 'public') {
  throw new Error('Scoped alpha must publish with public access')
}
if (manifest.contentPolicy?.class !== 'dual-use') {
  throw new Error('npm dual-use declaration is missing')
}

const incompatible = Object.entries(manifest.dependencies ?? {})
  .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  .filter(([, version]) => version !== '0.1.1-rc.2')
if (incompatible.length > 0) {
  throw new Error(`Harness dependency closure is not pinned to 0.1.1-rc.2: ${JSON.stringify(incompatible)}`)
}

process.stdout.write(`Release identity OK: ${manifest.name}@${manifest.version} (${tag})\n`)
