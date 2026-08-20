const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u
const JSON_TERMINAL_CONTROL = /[\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu

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

/**
 * Serialize machine-readable JSON without leaving terminal-active C1/bidi
 * characters in the raw output. Parsing the JSON reconstructs the exact
 * original string values.
 */
export function stringifyTerminalSafeJson(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('Value is not JSON-serializable.')
  }
  return serialized.replace(JSON_TERMINAL_CONTROL, (char) => {
    const code = char.codePointAt(0) ?? 0
    return `\\u${code.toString(16).padStart(4, '0')}`
  })
}
