import { open } from 'node:fs/promises'

/** Read until EOF even when a filesystem returns short reads; growth remains bounded. */
export async function readBoundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error(`Expected a regular file no larger than ${limit} bytes`)
    const parts: Buffer[] = []; let count = 0
    while (count <= limit) {
      const part = Buffer.alloc(Math.min(65_536, limit + 1 - count))
      const { bytesRead } = await file.read(part, 0, part.length, count)
      if (bytesRead === 0) return Buffer.concat(parts, count)
      count += bytesRead
      if (count > limit) throw new Error(`File exceeds ${limit} bytes`)
      parts.push(part.subarray(0, bytesRead))
    }
    throw new Error(`File exceeds ${limit} bytes`)
  } finally { await file.close() }
}
