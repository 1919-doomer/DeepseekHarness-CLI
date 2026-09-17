/**
 * Last-resort terminal restoration and crash reporting.
 *
 * A throw that reaches Node with no handler exits the process immediately. The
 * `finally` that would write ALT_SCREEN_OFF never runs, so the report Node
 * prints lands in the alternate screen buffer — which the terminal discards on
 * exit. The product disappears with nothing on screen to explain it.
 *
 * Order matters and is the whole reason this module exists: leave the alternate
 * screen first, restore the cursor and cooked input, and only then write. A
 * report written before the restore is a report nobody reads.
 *
 * This never swallows a crash. Installing a handler suppresses Node's default
 * exit, which would leave the process running on undefined state, so the guard
 * always exits after reporting.
 */

const ALT_SCREEN_OFF = '\u001B[?1049l'
const SHOW_CURSOR = '\u001B[?25h'

export interface CrashTerminal {
  stdout: { write(chunk: string): boolean }
  /** Whether this process put the terminal into the alternate screen. */
  alternateEntered: boolean
  stdin?: { isTTY?: boolean; setRawMode?(mode: boolean): void } | undefined
}

/**
 * Put the terminal back into a state a shell can use. Every step is attempted
 * independently: a crash is already the unhappy path, and a stdout that has
 * gone away must not stop the raw-mode restore that leaves the shell usable.
 */
export function restoreTerminalForCrash(terminal: CrashTerminal): void {
  const stdin = terminal.stdin
  try {
    if (stdin?.isTTY === true && typeof stdin.setRawMode === 'function') stdin.setRawMode(false)
  } catch { /* the terminal is already gone; keep restoring what is left */ }
  try {
    if (terminal.alternateEntered) terminal.stdout.write(ALT_SCREEN_OFF)
  } catch { /* nothing further to do for the alternate screen */ }
  try {
    terminal.stdout.write(SHOW_CURSOR)
  } catch { /* the cursor stays hidden; the shell will reset it */ }
}

/** A crash report that names the failure and says what was lost. */
export function describeCrash(reason: unknown, locale: 'en' | 'zh-CN' = 'en'): string {
  const detail = reason instanceof Error
    ? `${reason.name}: ${reason.message}${reason.stack === undefined ? '' : `\n${reason.stack}`}`
    : reason === undefined ? '(no reason reported)' : String(reason)

  if (locale === 'zh-CN') {
    return [
      'dshc 因未捕获的错误退出。',
      '',
      '当前会话已结束，Harness 运行时已随之关闭；协议不支持恢复会话，对话内容无法找回。',
      '这是 dshc 的缺陷，不是你的操作问题，请连同下面这段一起反馈。',
      '',
      detail,
      '',
    ].join('\n')
  }
  return [
    'dshc exited on an uncaught error.',
    '',
    'The session ended and the Harness runtime closed with it. The protocol has',
    'no session resume, so this conversation cannot be recovered.',
    'This is a dshc defect rather than something you did; please report it with',
    'the text below.',
    '',
    detail,
    '',
  ].join('\n')
}

export interface CrashGuardOptions {
  /** Read at crash time, because `alternateEntered` changes during startup. */
  terminal: () => CrashTerminal
  stderr: { write(chunk: string): boolean }
  locale?: 'en' | 'zh-CN'
  /** Injected for tests. Production always ends the process. */
  exit?: (code: number) => void
}

/**
 * Report and exit on anything that would otherwise kill the process silently.
 *
 * Returns a disposer; the product removes the guard on a normal exit so it
 * cannot outlive the terminal it knows how to restore.
 */
export function installCrashGuard(options: CrashGuardOptions): () => void {
  let handled = false
  const handle = (reason: unknown): void => {
    // A second failure while reporting the first must not loop.
    if (handled) return
    handled = true
    try {
      restoreTerminalForCrash(options.terminal())
      options.stderr.write(describeCrash(reason, options.locale ?? 'en'))
    } catch { /* reporting failed; exiting is still correct */ }
    (options.exit ?? process.exit.bind(process))(1)
  }

  const onException = (error: unknown): void => handle(error)
  const onRejection = (reason: unknown): void => handle(reason)
  process.on('uncaughtException', onException)
  process.on('unhandledRejection', onRejection)
  return () => {
    process.off('uncaughtException', onException)
    process.off('unhandledRejection', onRejection)
  }
}
