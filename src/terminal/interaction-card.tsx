import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import type { InteractionAnswer, InteractionRequest } from '../upstream/interaction.js'
import type { InputKey } from './input-controller.js'
import { splitGraphemes, wrapTerminalLines, insertAtGrapheme, deleteGraphemeBefore, graphemeCount, sliceByGrapheme, suffixByCells, prefixByCells } from './text-metrics.js'
import { sanitizeTerminalText } from './sanitize.js'
export interface InteractionCardHandle { key: (text: string, key: InputKey) => void; paste: (text: string) => void }
export function createInteractionDraft(request: InteractionRequest) {
  return { index: 0, focus: 0, selected: request.kind === 'questions' ? request.questions.map(q => Math.max(0, q.options.findIndex(o => o.recommended))) : [0], texts: request.kind === 'questions' ? request.questions.map(() => '') : [''], cursors: [0, 0, 0], scroll: 0, submitted: false }
}
export const InteractionCard = forwardRef<InteractionCardHandle, {
  request: InteractionRequest; draft?: ReturnType<typeof createInteractionDraft>; zh: boolean; width: number; rows: number; hidden: boolean; onHide: () => void; onAnswer: (answer: InteractionAnswer) => void
}>(function InteractionCard({ request, draft, zh, width, rows, hidden, onHide, onAnswer }, ref) {
  const [, redraw] = useState(0)
  const state = useRef(draft ?? createInteractionDraft(request))
  const s = state.current
  const append = (text: string): void => {
    if (s.submitted) return
    s.focus = 1
    const result = insertAtGrapheme(s.texts[s.index]!, s.cursors[s.index]!, text.replace(/\r\n?/g, '\n').slice(0, Math.max(0, 8000 - s.texts[s.index]!.length)))
    s.texts[s.index] = result.value; s.cursors[s.index] = result.cursor; redraw(n => n + 1)
  }
  /** Commit the current selection: next question, or the final answer. */
  const advance = (): void => {
    if (request.kind !== 'questions') {
      s.submitted = true
      onAnswer({ action: (['implement', 'revise', 'defer'] as const)[s.selected[0]!]!, text: s.texts[0] })
      return
    }
    if (s.focus === 3) { s.submitted = true; onAnswer({ action: 'skip' }); return }
    const question = request.questions[s.index]!
    // "Write my own answer" is the one option that needs something typed, so it
    // moves to the note instead of committing an empty answer.
    if (s.selected[s.index] === question.options.length && !s.texts[s.index]?.trim()) { s.focus = 1; return }
    if (s.index < request.questions.length - 1) { s.index++; s.focus = 0; s.scroll = 0; return }
    s.submitted = true
    onAnswer({
      action: 'submit',
      answers: request.questions.map((q, i) => ({
        id: q.id,
        option: s.selected[i] === q.options.length ? undefined : s.selected[i],
        text: s.texts[i]!,
      })),
    })
  }

  /** Select by position. Returns false when there is no such option. */
  const pick = (index: number): boolean => {
    const count = request.kind === 'questions' ? request.questions[s.index]!.options.length + 1 : 3
    if (index < 0 || index >= count) return false
    s.selected[s.index] = index
    advance()
    return true
  }

  useImperativeHandle(ref, () => ({ paste: append, key(text, key) {
    if (s.submitted) return
    if (key.escape) { onHide(); return }
    if (key.pageUp || key.pageDown) s.scroll = Math.max(0, s.scroll + (key.pageDown ? rows - 4 : 4 - rows))
    else if (key.tab) s.focus = (s.focus + 1) % (request.kind === 'questions' ? 4 : 3)
    else if (key.ctrl && text === 'u') { s.texts[s.index] = ''; s.cursors[s.index] = 0 }
    else if (key.ctrl && text === 'b' && s.index > 0) { s.index--; s.scroll = 0; s.focus = 0 }
    else if (key.upArrow || key.downArrow) {
      const count = request.kind === 'questions' ? request.questions[s.index]!.options.length + 1 : 3
      s.selected[s.index] = (s.selected[s.index]! + (key.downArrow ? 1 : count - 1)) % count
      s.focus = 0; s.scroll = 0
    } else if (key.leftArrow && s.focus === 1) s.cursors[s.index] = Math.max(0, s.cursors[s.index]! - 1)
    else if (key.rightArrow && s.focus === 1) s.cursors[s.index] = Math.min(graphemeCount(s.texts[s.index]!), s.cursors[s.index]! + 1)
    else if (key.home || key.ctrl && text === 'a') s.cursors[s.index] = 0
    else if (key.end || key.ctrl && text === 'e') s.cursors[s.index] = graphemeCount(s.texts[s.index]!)
    else if (key.delete && s.focus === 1) { const parts = splitGraphemes(s.texts[s.index]!); parts.splice(s.cursors[s.index]!, 1); s.texts[s.index] = parts.join('') }
    else if (key.backspace && s.focus === 1) { const result = deleteGraphemeBefore(s.texts[s.index]!, s.cursors[s.index]!); s.texts[s.index] = result.value; s.cursors[s.index] = result.cursor }
    // Enter means one thing everywhere: go forward. It used to mean three
    // different things depending on an invisible focus value, so answering a
    // single question took three of them.
    else if (key.return && !key.meta && !key.ctrl) advance()
    // A digit picks its option outright. This is the whole difference between
    // reading the list and operating it.
    else if (s.focus === 0 && /^[1-9]$/.test(text) && pick(Number(text) - 1)) { /* handled */ }
    else if (key.return) append('\n')
    else if (!key.ctrl && !key.meta && text && !key.leftArrow && !key.rightArrow && !key.delete) append(text)
    redraw(n => n + 1)
  } }))
  if (hidden) return null
  const q = request.kind === 'questions' ? request.questions[s.index]! : undefined
  const options = q ? [...q.options.map(o => `${o.label}${o.recommended ? zh ? '（推荐）' : ' (recommended)' : ''}${o.description ? ` — ${o.description}` : ''}`), zh ? '填写自己的答案' : 'Write my own answer'] : zh ? ['开始实施', '继续修改', '暂不实施'] : ['Implement', 'Revise', 'Defer']
  const content = q ? `${s.index + 1}/${request.kind === 'questions' ? request.questions.length : 1} ${q.title}` : request.kind === 'plan' ? `${request.title}\n${request.text}` : ''
  // The selected option is listed below; repeating it here cost a row and told
  // the reader nothing they could not already see.
  const lines = wrapTerminalLines(sanitizeTerminalText(content), Math.max(1, width - 4))
  // Every option stays on screen. Showing only the selected one on a short
  // terminal meant choosing between alternatives you could not read.
  const chrome = q ? 6 : 5
  const optionRows = Math.max(1, Math.min(options.length, Math.max(1, rows - chrome - 1)))
  const optionStart = Math.max(0, Math.min(s.selected[s.index]!, options.length - optionRows))
  const shownOptions = options.map((text, i) => ({ text, i })).slice(optionStart, optionStart + optionRows)
  const capacity = Math.max(1, rows - shownOptions.length - chrome)
  const start = Math.min(s.scroll, Math.max(0, lines.length - capacity))
  const before = sanitizeTerminalText(sliceByGrapheme(s.texts[s.index] ?? '', 0, s.cursors[s.index])).replaceAll('\n', '↵')
  const after = sanitizeTerminalText(sliceByGrapheme(s.texts[s.index] ?? '', s.cursors[s.index]!)).replaceAll('\n', '↵')
  const inputPreview = `${suffixByCells(before, Math.max(1, width - 20))}${s.focus === 1 ? '▏' : ''}${prefixByCells(after, 5)}`
  const lastQuestion = !q || s.index === (request.kind === 'questions' ? request.questions.length : 1) - 1
  const confirmLabel = q
    ? lastQuestion ? (zh ? '提交回答' : 'Submit answers') : (zh ? '下一题' : 'Next question')
    : (zh ? '确认' : 'Confirm')
  const hint = [
    zh ? '↑↓ 选择' : '↑↓ choose',
    zh ? '1-9 直接选' : '1-9 pick',
    zh ? `Enter ${lastQuestion ? '提交' : '下一题'}` : `Enter ${lastQuestion ? 'submit' : 'next'}`,
    zh ? 'Tab 补充说明' : 'Tab add a note',
    ...(s.index > 0 ? [zh ? 'Ctrl+B 上一题' : 'Ctrl+B back'] : []),
    zh ? 'Esc 隐藏' : 'Esc hide',
  ].join(' · ')
  return <Box height={rows} flexShrink={0} flexDirection="column" borderStyle="single" borderColor="#D97757" paddingX={1} overflow="hidden">
    <Text wrap="truncate">{lines.slice(start, start + capacity).join('\n')}</Text>
    {shownOptions.map(({ text: option, i }) => <Text key={i} inverse={s.focus === 0 && i === s.selected[s.index]} wrap="truncate">{i === s.selected[s.index] ? '›' : ' '}{i < 9 ? `${i + 1} ` : '  '}{sanitizeTerminalText(option)}</Text>)}
    <Text inverse={s.focus === 1} wrap="truncate">{zh ? '补充' : 'Note'}: {inputPreview}</Text>
    <Text inverse={s.focus === 2} wrap="truncate">{confirmLabel}</Text>
    {q && <Text inverse={s.focus === 3} wrap="truncate">{zh ? '跳过本组问题' : 'Skip questions'}</Text>}
    <Text dimColor wrap="truncate">{hint}</Text>
  </Box>
})
