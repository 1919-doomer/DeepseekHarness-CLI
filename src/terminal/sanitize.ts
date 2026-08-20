const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/u

/**
 * Render arbitrary model/tool/repository text as inert terminal text.
 * dshc styling is generated separately; untrusted input never supplies ANSI,
 * OSC, C0/C1 or bidi-control behavior.
 */
export function sanitizeTerminalText(input: string): string {
  let output = ''
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\n' || char === '\t') {
      output += char
      continue
    }
    if (code === 0x1b) {
      output += '\\x1b'
      continue
    }
    if (code < 0x20 || code === 0x7f) {
      output += `\\x${code.toString(16).padStart(2, '0')}`
      continue
    }
    if (code >= 0x80 && code <= 0x9f) {
      output += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    if (BIDI_CONTROL.test(char)) {
      output += `\\u${code.toString(16).padStart(4, '0')}`
      continue
    }
    output += char
  }
  return output
}
