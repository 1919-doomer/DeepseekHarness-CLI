import { gzipSync } from 'node:zlib'

/** Deterministic ustar fixture with no executable install scripts. */
export function bundleArchive(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = []
  for (const [path, text] of Object.entries(files)) {
    const bytes = Buffer.from(text)
    const header = Buffer.alloc(512)
    header.write(`package/${path}`, 0, 100)
    header.write('0000644\0', 100, 8)
    header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8)
    header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124, 12)
    header.write('00000000000\0', 136, 12)
    header.fill(32, 148, 156); header[156] = 48
    header.write('ustar\0', 257, 6); header.write('00', 263, 2)
    const checksum = header.reduce((sum, value) => sum + value, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8)
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}
export function testBundle(version = '1.0.0', patch = '[]\n', code?: string): Buffer {
  return bundleArchive({
    'package.json': JSON.stringify({ name: 'dshc-test-bundle', version, type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    'cordis.patch.yml': patch,
    ...(code === undefined ? {} : { 'index.mjs': code }),
  })
}
