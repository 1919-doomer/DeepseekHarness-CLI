import { useEffect, useState } from 'react'
import { Box, Text, render, useInput, useIsScreenReaderEnabled, usePaste, useStdout } from 'ink'
import type { HarnessRuntime, HarnessRuntimeMetadata } from '../upstream/runtime.js'
const LOGO = ['      _     _', '   __| |___| |__   ___', '  / _` / __| _  \\ / __|', ' | (_| \\__ \\ | | | (__', '  \\__,_|___/_| |_|\\___|']
function Splash({ capture, cancel }: { capture: (text: string) => void; cancel: () => void }) {
  const { stdout } = useStdout()
  const reader = useIsScreenReaderEnabled()
  const [frame, setFrame] = useState(0)
  const [skipped, setSkipped] = useState(false)
  useInput((text, key) => { setSkipped(true); if (key.ctrl && text === 'c') { cancel(); return }; if (!key.ctrl && !key.meta && !key.escape && !key.tab && !key.backspace && !key.delete && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) capture(key.return ? '\n' : text) })
  usePaste(text => { setSkipped(true); capture(text) })
  useEffect(() => {
    if (reader || skipped) return
    let count = 0
    const timer = setInterval(() => { count++; if (!stdout.writableNeedDrain) setFrame(count); if (count >= LOGO.length) clearInterval(timer) }, 100)
    timer.unref(); return () => { clearInterval(timer) }
  }, [stdout, reader, skipped])
  if (reader || skipped) return <Text>dshc …</Text>
  return <Box width={stdout.columns} flexDirection="column" alignItems="center" paddingY={1}>
    {(stdout.columns >= 42 && stdout.rows >= 14 ? LOGO : ['dshc']).map((line, i) => <Text key={i} color="#D97757" dimColor={i > frame}>{line}</Text>)}
    <Text dimColor>DeepSeek Harness Console</Text>
  </Box>
}
export async function startWithSplash(runtime: HarnessRuntime, stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, stderr: NodeJS.WriteStream, animation = true): Promise<{ metadata: HarnessRuntimeMetadata; draft: string; instance?: ReturnType<typeof render> }> {
  let draft = ''
  const instance = animation && stdin.isTTY && stdout.isTTY ? render(<Splash capture={text => { draft = (draft + text).slice(0, 64_000) }} cancel={() => { void runtime.close().catch(() => undefined) }} />, { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false }) : undefined
  const exited = instance?.waitUntilExit().catch(() => undefined)
  // Keep one Ink owner from splash to prompt. Recreating the TTY reader on
  // Windows can strand the old console read even after raw mode is restored.
  try { return { metadata: await runtime.start(), draft, instance } }
  catch (error) { instance?.clear(); instance?.unmount(); await exited; throw error }
}
