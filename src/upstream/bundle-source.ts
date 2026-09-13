import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { readBoundedFile } from './bounded-file.js'
import { gunzipSync } from 'node:zlib'
import { isAbsolute, join, posix, resolve } from 'node:path'

export interface BundleSource {
  requested: string; name: string; version: string; archive: string; sha256: string
  patch: string; patchText: string; dependencies: Record<string, string>; clientDependencies: string[]
}
const exactPackage = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?)$/
export function parseBundleSpec(spec: string): { name: string; version: string } | { path: string } {
  const match = exactPackage.exec(spec)
  if (match) return { name: match[1]!, version: match[2]! }
  if (/\.(?:tgz|tar\.gz)$/i.test(spec) && (isAbsolute(spec) || /^\.{1,2}[\\/]/.test(spec))) return { path: spec }
  throw new Error('Bundle source must be package@exact-version or an explicit local .tgz/.tar.gz path; tags, ranges, Git and source builds are not supported')
}
async function download(url: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000), redirect: 'error' })
  if (!response.ok || !response.body) throw new Error(`Bundle download failed: HTTP ${response.status}`)
  const chunks: Buffer[] = []; let length = 0
  for await (const data of response.body) {
    length += data.byteLength
    if (length > limit) { throw new Error('Bundle download exceeds the size limit') }
    chunks.push(Buffer.from(data))
  }
  return Buffer.concat(chunks)
}

/** Reads only archive metadata/text. Never extracts or executes package code. */
export function inspectBundleArchive(compressed: Buffer): Omit<BundleSource, 'requested' | 'archive' | 'sha256'> {
  if (compressed.length > 32 * 1024 * 1024) throw new Error('Bundle archive exceeds 32 MiB')
  const tar = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 })
  const files = new Map<string, Buffer>()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(value => value === 0)) break
    const name = header.subarray(0, 100).toString().split('\0')[0]!
    const prefix = header.subarray(345, 500).toString().split('\0')[0]!
    const full = prefix ? `${prefix}/${name}` : name
    const size = Number.parseInt(header.subarray(124, 136).toString().split('\0')[0]!.trim() || '0', 8)
    const type = header[156]
    const expectedChecksum = Number.parseInt(header.subarray(148, 156).toString().split('\0')[0]!.trim(), 8)
    const checksum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0)
    if (checksum !== expectedChecksum) throw new Error('Invalid Bundle tar checksum')
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid Bundle tar header')
    if (!full.startsWith('package/') || full.includes('\\') || full.split('/').some(part => part === '..' || part === '.') || posix.normalize(full) !== full) throw new Error('Bundle archive paths must remain canonical under package/')
    if (type !== 0 && type !== 48 && type !== 53) throw new Error('Bundle archive links and extended tar entries are not supported')
    if (type !== 53) {
      if (files.has(full)) throw new Error('Duplicate Bundle archive entry')
      files.set(full, tar.subarray(offset + 512, offset + 512 + size))
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  const manifestBytes = files.get('package/package.json')
  if (!manifestBytes || manifestBytes.length > 1_048_576) throw new Error('Bundle package.json is missing or too large')
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>
  const dsh = manifest['dsh'] as { bundle?: { patch?: unknown } } | undefined
  const patch = dsh?.bundle?.patch
  if (typeof patch !== 'string' || posix.isAbsolute(patch) || patch.split('/').includes('..') || patch.includes('\\')) throw new Error('Package has no valid dsh.bundle.patch declaration')
  const content = files.get(`package/${patch.replace(/^\.\//, '')}`)
  if (!content || content.length > 262_144) throw new Error('Declared Bundle patch is missing or too large to review')
  const name = manifest['name']; const version = manifest['version']
  if (typeof name !== 'string' || typeof version !== 'string' || !exactPackage.test(`${name}@${version}`)) throw new Error('Invalid Bundle package identity')
  const dependencies = manifest['dependencies'] as Record<string, string> | undefined
  if (dependencies && (typeof dependencies !== 'object' || Object.values(dependencies).some(value => typeof value !== 'string'))) throw new Error('Invalid Bundle dependencies')
  const entries = Object.keys(dependencies ?? {})
  return { name, version, patch, patchText: content.toString('utf8'), dependencies: dependencies ?? {},
    clientDependencies: entries.filter(name => /(?:^|[/-])client(?:-|\/)|web-ui|frontend/.test(name)) }
}

export async function resolveBundleSource(spec: string, workspace: string, signal?: AbortSignal): Promise<BundleSource> {
  const source = parseBundleSpec(spec)
  let bytes: Buffer
  if ('path' in source) {
    bytes = await readBoundedFile(resolve(workspace, source.path), 32 * 1024 * 1024)
  }
  else {
    const metadata = JSON.parse((await download(`https://registry.npmjs.org/${encodeURIComponent(source.name)}/${encodeURIComponent(source.version)}`, 2_097_152, signal)).toString('utf8')) as { dist?: { tarball?: string; integrity?: string } }
    const tarball = new URL(metadata.dist?.tarball ?? '')
    if (tarball.protocol !== 'https:' || tarball.hostname !== 'registry.npmjs.org') throw new Error('Bundle tarball must come from the npm registry')
    bytes = await download(tarball.href, 32 * 1024 * 1024, signal)
    const integrity = metadata.dist?.integrity
    if (!integrity?.startsWith('sha512-') || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) throw new Error('Bundle registry integrity check failed')
  }
  signal?.throwIfAborted()
  const info = inspectBundleArchive(bytes)
  if ('name' in source && (info.name !== source.name || info.version !== source.version)) throw new Error('Bundle archive identity does not match the requested exact package')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const directory = join(workspace, '.dshc', 'bundle-cache')
  await mkdir(directory, { recursive: true })
  const archive = join(directory, `${sha256}.tgz`)
  await writeFile(archive, bytes, { mode: 0o600 })
  return { ...info, requested: 'path' in source ? resolve(workspace, source.path) : spec, archive, sha256 }
}
