/* eslint-disable no-control-regex -- Remove untrusted terminal controls before applying our own styling. */
// Standalone append-only renderer: preserves native terminal scrollback and
// needs no React runtime or source loader in the monitor process.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const colors = { orange: '217;119;87', cyan: '103;198;211', green: '140;192;137', red: '232;125;125', dim: '137;143;153' }
export const safe = value => String(value ?? '').replace(/\r\n/g, '\n').replace(/\t/g, '    ')
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
function cells(grapheme) {
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(grapheme)) return 2
  let visible = false
  for (const char of grapheme) {
    const cp = char.codePointAt(0)
    if (/\p{Mark}/u.test(char) || cp === 0x200d || cp >= 0xfe00 && cp <= 0xfe0f) continue
    visible = true
    if (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a
      || cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f || cp >= 0xac00 && cp <= 0xd7a3
      || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe19 || cp >= 0xfe30 && cp <= 0xfe6f
      || cp >= 0xff00 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6
      || cp >= 0x1b000 && cp <= 0x1b001 || cp >= 0x1f200 && cp <= 0x1f251 || cp >= 0x20000 && cp <= 0x3fffd)) return 2
  }
  return visible ? 1 : 0
}
const graphemes = value => Array.from(segmenter.segment(value), part => part.segment)
const width = value => graphemes(value).reduce((sum, part) => sum + cells(part), 0)
function wrap(value, columns) {
  return safe(value).split('\n').flatMap(line => {
    const lines = []; let current = '', used = 0
    for (const part of graphemes(line)) {
      const size = cells(part)
      if (used + size > columns && current) { lines.push(current); current = ''; used = 0 }
      current += part; used += size
    }
    lines.push(current); return lines
  })
}
function crop(value, columns) {
  const text = safe(value).replace(/\n/g, ' ')
  if (width(text) <= columns) return text
  let out = '', used = 0
  for (const part of graphemes(text)) { if (used + cells(part) > columns - 1) break; out += part; used += cells(part) }
  return `${out}…`
}
function argumentsText(text, zh) {
  try {
    const args = JSON.parse(text)
    if (!args || typeof args !== 'object' || Array.isArray(args)) return safe(text)
    const labels = zh ? { file_path: '文件', path: '路径', command: '命令', description: '说明', content: '内容', pattern: '搜索', timeoutMs: '超时 ms' } : {}
    return Object.entries(args).map(([key, value]) => `${Object.hasOwn(labels, key) ? labels[key] : key}  ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`).join('\n')
  } catch { return safe(text) }
}
function resultText(text, zh) {
  // Only unwrap the complete, known filesystem envelope; arbitrary tool text
  // (including malformed/nested markup) remains literal text.
  const match = /^<path>([^<>]*)<\/path>\s*<type>([^<>]*)<\/type>\s*<content>\n?([\s\S]*)\n?<\/content>\s*$/.exec(text)
  return match ? `${zh ? '路径' : 'Path'}  ${match[1]}\n\n${match[3].trimEnd()}` : text
}
export class AgentWindowFormatter {
  constructor({ columns = () => process.stdout.columns ?? 100, color = false, ascii = false, zh = false } = {}) {
    this.columns = columns; this.color = color; this.ascii = ascii; this.zh = zh; this.streaming = false
  }
  paint(text, tone) { return this.color ? `\x1b[38;2;${colors[tone]}m${text}\x1b[0m` : text }
  box(title, body, tone = 'dim', limit = 24) {
    const columns = Math.max(1, Math.min(104, this.columns() - 2))
    if (columns < 14) return `${safe(title)}\n${safe(body)}\n`
    const inner = columns - 4, chars = this.ascii ? ['+', '+', '+', '+', '-', '|'] : ['╭', '╮', '╰', '╯', '─', '│']
    const heading = ` ${crop(title, columns - 6)} `
    const lines = wrap(body, inner)
    const shown = lines.slice(0, limit)
    if (lines.length > limit) shown.push(crop(this.zh ? `… 另 ${lines.length - limit} 行 · /trace` : `… ${lines.length - limit} more lines · /trace`, inner))
    const edge = text => this.paint(text, tone)
    return `\n ${edge(chars[0] + chars[4] + heading + chars[4].repeat(Math.max(0, columns - 3 - width(heading))) + chars[1])}\n`
      + shown.map(line => ` ${edge(chars[5])} ${line}${' '.repeat(Math.max(0, inner - width(line)))} ${edge(chars[5])}\n`).join('')
      + ` ${edge(chars[2] + chars[4].repeat(columns - 2) + chars[3])}\n`
  }
  header(title) {
    const text = `${safe(title)}\n${this.zh ? '实时输出 · 只读监视 · 关闭窗口不会取消任务' : 'Live output · Read-only · Closing does not cancel work'}`
    return this.box('dshc / Agent', text, 'orange', 5)
  }
  entry(entry) {
    const text = safe(entry.text), zh = this.zh
    if (entry.kind === 'delta') {
      const heading = this.streaming ? '' : `\n ${this.paint('● Agent', 'orange')}\n\n`
      this.streaming = true; return heading + text
    }
    const prefix = this.streaming ? '\n' : ''; this.streaming = false
    switch (entry.kind) {
      case 'message-end': return prefix
      case 'message': return prefix + `\n ${this.paint('● Agent', 'orange')}\n\n${text}\n`
      case 'user': return prefix + this.box(zh ? '❯ 任务' : '❯ Task', text, 'dim', 16)
      case 'call': return prefix + this.box(`▸ ${entry.title ?? 'tool'} · ${zh ? '调用' : 'call'}`, argumentsText(text, zh), 'cyan', 12)
      case 'result': return prefix + this.box(`✓ ${entry.title ?? 'tool'} · ${zh ? '完成' : 'done'}`, resultText(text, zh), 'green')
      case 'error': return prefix + this.box(`✗ ${entry.title ?? 'tool'} · ${zh ? '失败' : 'failed'}`, resultText(text, zh), 'red')
      case 'finished': return prefix + this.box(zh ? '✓ 已完成' : '✓ Finished', text, 'green', 3)
      default: return prefix + ` ${this.paint(text.trimEnd(), 'dim')}\n`
    }
  }
}
