import { useEffect, useState } from 'react'
import { Box, Text, render, useInput, useIsScreenReaderEnabled, usePaste, useStdout } from 'ink'
import type { HarnessRuntime, HarnessRuntimeMetadata } from '../upstream/runtime.js'
import type { Locale } from '../i18n.js'

const LOGO = [
  '     _       _         ',
  '  __| | ___ | |__   ___',
  ' / _` |/ __||  _ \\ / __|',
  '| (_| |\\__ \\| | | | (__',
  ' \\__,_||___/|_| |_|\\___|',
]
const LOGO_WIDTH = Math.max(...LOGO.map(line => line.length))
const FRAMES = 18
const FRAME_MS = 50
const ORANGE = '#D97757'

function Splash({ capture, cancel, locale }: { capture: (text: string) => void; cancel: () => void; locale: Locale }) {
  const { stdout } = useStdout()
  const reader = useIsScreenReaderEnabled()
  const [frame, setFrame] = useState(0)
  const [skipped, setSkipped] = useState(false)
  const [size, setSize] = useState(() => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 }))
  const zh = locale === 'zh-CN'
  useInput((text, key) => { setSkipped(true); if (key.ctrl && text === 'c') { cancel(); return }; if (!key.ctrl && !key.meta && !key.escape && !key.tab && !key.backspace && !key.delete && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) capture(key.return ? '\n' : text) })
  usePaste(text => { setSkipped(true); capture(text) })
  useEffect(() => {
    const resize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 })
    stdout.on('resize', resize)
    return () => { stdout.off('resize', resize) }
  }, [stdout])
  useEffect(() => {
    if (reader || skipped) return
    const started = performance.now()
    const timer = setInterval(() => {
      // Advance by elapsed time without queuing frames behind a slow terminal.
      if (stdout.writableNeedDrain) return
      const next = Math.min(FRAMES, Math.floor((performance.now() - started) / FRAME_MS))
      setFrame(next)
      if (next === FRAMES) clearInterval(timer)
    }, FRAME_MS)
    timer.unref(); return () => { clearInterval(timer) }
  }, [stdout, reader, skipped])
  if (reader || skipped) return <Text>{zh ? 'dshc · 正在启动…' : 'dshc · Starting…'}</Text>
  const large = size.columns >= 42 && size.rows >= 14
  const width = large ? LOGO_WIDTH : 4
  const edge = Math.floor(frame / FRAMES * (width + 4))
  const settled = frame === FRAMES
  return <Box width={size.columns} height={Math.max(1, size.rows - 1)} flexDirection="column" justifyContent="center" alignItems="center" overflow="hidden">
    {(large ? LOGO : ['dshc']).map((line, i) => <Text key={i} wrap="truncate">
      {Array.from(line.padEnd(width)).map((character, column) => <Text key={column}
        color={settled || column < edge - 3 ? ORANGE : column <= edge ? '#F5C4A1' : '#59433C'}
        bold={settled || column <= edge}>{character}</Text>)}
    </Text>)}
    {size.columns >= 28 && size.rows >= 10 && <Box marginTop={1}><Text dimColor>DeepSeek Harness Console</Text></Box>}
    {size.columns >= 28 && size.rows >= 8 && <Box marginTop={1}><Text dimColor>{zh ? '正在启动 · 按任意键跳过' : 'Starting · any key to skip'}</Text></Box>}
  </Box>
}
export async function startWithSplash(runtime: HarnessRuntime, stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream, animation = true, interactive?: boolean, locale: Locale = 'en'): Promise<{ metadata: HarnessRuntimeMetadata; draft: string; instance?: ReturnType<typeof render> }> {
  let draft = ''
  const instance = animation && stdin.isTTY && stdout.isTTY ? render(<Splash locale={locale} capture={text => { draft = (draft + text).slice(0, 64_000) }} cancel={() => { void runtime.close().catch(() => undefined) }} />, { stdin, stdout, stderr, interactive, exitOnCtrlC: false, patchConsole: false }) : undefined
  const exited = instance?.waitUntilExit().catch(() => undefined)
  // Keep one Ink owner from splash to prompt. Recreating the TTY reader on
  // Windows can strand the old console read even after raw mode is restored.
  try { return { metadata: await runtime.start(), draft, instance } }
  catch (error) { instance?.clear(); instance?.unmount(); await exited; throw error }
}
