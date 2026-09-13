/** The subset of Ink's parsed key flags this product reacts to. */
export interface InputKey {
  ctrl: boolean
  meta: boolean
  escape: boolean
  tab: boolean
  return: boolean
  backspace: boolean
  delete: boolean
  leftArrow: boolean
  rightArrow: boolean
  upArrow: boolean
  downArrow: boolean
  pageUp?: boolean
  pageDown?: boolean
  home?: boolean
  end?: boolean
}

export interface Keystroke {
  text: string
  key: InputKey
}

const PLAIN_KEY: InputKey = Object.freeze({
  ctrl: false,
  meta: false,
  escape: false,
  tab: false,
  return: false,
  backspace: false,
  delete: false,
  leftArrow: false,
  rightArrow: false,
  upArrow: false,
  downArrow: false,
})

const RETURN_KEY: InputKey = Object.freeze({ ...PLAIN_KEY, return: true })

/**
 * Split one stdin chunk into the keystrokes it actually represents.
 *
 * Ink parses a chunk into a single `key`, which is correct for an escape
 * sequence (arrows, Ctrl+J, Escape) but wrong when several plain keystrokes
 * coalesce or when the user pastes text. A coalesced chunk carrying a submit
 * character would otherwise fail every `key.*` test and be inserted verbatim,
 * losing the submit and leaving a raw control character in the prompt.
 *
 * Only plain chunks are split, so parsed control sequences keep their existing
 * single-stroke behavior and Ctrl+J still inserts a literal newline rather than
 * submitting. Coalesced Ctrl shortcuts are decoded before plain text insertion.
 */
export function splitKeystrokes(keyInput: string, key: InputKey): readonly Keystroke[] {
  const parsedSequence = key.ctrl || key.meta || key.escape || key.tab
    || key.backspace || key.delete
    || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow
    || key.pageUp === true || key.pageDown === true || key.home === true || key.end === true
  if (parsedSequence) return [{ text: keyInput, key }]
  // eslint-disable-next-line no-control-regex -- decoding stdin control bytes is intentional.
  if (!/[\x01-\x1a\x7f]/.test(keyInput)) {
    return [{ text: keyInput, key }]
  }

  const strokes: Keystroke[] = []
  let pending = ''
  for (const char of keyInput) {
    const code = char.charCodeAt(0)
    if (code >= 1 && code <= 26 || code === 127) {
      if (pending.length > 0) {
        strokes.push({ text: pending, key: PLAIN_KEY })
        pending = ''
      }
      if (char === '\r' || char === '\n') strokes.push({ text: char, key: RETURN_KEY })
      else if (char === '\t') strokes.push({ text: char, key: { ...PLAIN_KEY, tab: true } })
      else if (code === 8 || code === 127) strokes.push({ text: char, key: { ...PLAIN_KEY, backspace: true } })
      else strokes.push({ text: String.fromCharCode(code + 96), key: { ...PLAIN_KEY, ctrl: true } })
      continue
    }
    pending += char
  }
  if (pending.length > 0) strokes.push({ text: pending, key: PLAIN_KEY })
  return strokes
}
