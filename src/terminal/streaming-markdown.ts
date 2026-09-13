import { parseMarkdown, type MarkdownLine } from './markdown.js'

/** Paragraph boundaries outside fences are stable; retain their parsed spans
 * and reparse only the unfinished suffix. Replacement/retention resets the cache. */
export class StreamingMarkdown {
  private previous = ''
  private stableOffset = 0
  private stable: readonly MarkdownLine[] = []
  parse(text: string): readonly MarkdownLine[] {
    if (!text.startsWith(this.previous)) { this.stableOffset = 0; this.stable = [] }
    this.previous = text
    const suffix = text.slice(this.stableOffset)
    let fence: string | undefined
    let offset = 0; let boundary = 0
    const lines = suffix.split('\n')
    for (const line of lines.slice(0, -1)) {
      const marker = /^\s{0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line.replace(/\r$/, ''))
      if (fence) {
        if (marker?.[1] && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2]) fence = undefined
      } else if (marker?.[1]) fence = marker[1]
      offset += line.length + 1
      if (!fence && line.trim().length === 0) boundary = offset
    }
    if (boundary > 0) {
      // The prefix's final newline creates a synthetic last blank line; the
      // unfinished suffix owns that line in the complete parser's output.
      this.stable = [...this.stable, ...parseMarkdown(suffix.slice(0, boundary)).slice(0, -1)]
      this.stableOffset += boundary
    }
    return [...this.stable, ...parseMarkdown(text.slice(this.stableOffset))]
  }
}
