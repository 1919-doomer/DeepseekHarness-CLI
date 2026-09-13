import { memo, useEffect, useState } from 'react'
import { Text, useIsScreenReaderEnabled, useStdout } from 'ink'
import type { TerminalRuntimePhase } from '../plugins/api.js'
import { translate, type Locale } from '../i18n.js'

/** Animation state stays here so breathing never reprojects the transcript. */
export const StatusLight = memo(function StatusLight({ phase, locale, animation = true, waiting = false }: {
  phase: TerminalRuntimePhase
  locale: Locale
  animation?: boolean
  waiting?: boolean
}) {
  const { stdout } = useStdout()
  const screenReader = useIsScreenReaderEnabled()
  const [frame, setFrame] = useState(0)
  const breathing = animation && !waiting && (phase === 'running' || phase === 'starting')

  useEffect(() => {
    if (!breathing || screenReader) return
    const started = performance.now()
    const timer = setInterval(() => {
      // Decorative frames may be skipped when stdout cannot keep up.
      if (!stdout.writableNeedDrain) setFrame(Math.floor((performance.now() - started) / 120) % 10)
    }, 120)
    timer.unref()
    return () => { clearInterval(timer) }
  }, [breathing, screenReader, stdout])

  const ascii = process.env.TERM === 'dumb' || process.env.DSHC_ASCII === '1'
  // None of these glyphs have emoji presentation; avoid U+2733 entirely.
  const frames = ascii ? ['.', '+', '*', '*', '+', '*', '*', '+', '*', '.'] : ['·', '✢', '✶', '✻', '✽', '✻', '✶', '✢', '✶', '·']
  const color = phase === 'failed' ? 'red' : '#D97757'

  return <Text color={color} bold={breathing} dimColor={!breathing || frame < 2}
    aria-label={translate(locale, phase)}>
    {phase === 'failed' ? '!' : phase === 'closing' ? '·' : breathing && !screenReader ? frames[frame] : ascii ? '*' : '✻'}
  </Text>
})
