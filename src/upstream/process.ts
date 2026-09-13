import { spawn } from 'node:child_process'

export async function captureProcess(command: string, args: readonly string[], options: {
  cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number
}): Promise<string> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false, detached: process.platform !== 'win32' })
    const stdout: Buffer[] = []; const stderr: Buffer[] = []
    let bytes = 0; let failure: Error | undefined
    let forcedClose: ReturnType<typeof setTimeout> | undefined
    const stop = (error: Error): void => {
      if (failure) return
      failure = error
      // Package-manager children may inherit the output pipes. Terminate the
      // owned process tree, then bound pipe shutdown even if a child misbehaves.
      if (child.pid !== undefined && process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => { child.kill() })
      } else if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      } else child.kill()
      forcedClose = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref()
        cleanup(); reject(error)
      }, 2_000)
    }
    const timeout = setTimeout(() => stop(new Error(`${command} timed out`)), options.timeoutMs ?? 15_000)
    const abort = (): void => stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error('Aborted'))
    options.signal?.addEventListener('abort', abort, { once: true })
    const collect = (target: Buffer[]) => (data: Buffer): void => {
      bytes += data.length
      if (bytes > (options.maxBytes ?? 262_144)) { stop(new Error(`${command} output exceeds the display limit; narrow the selection`)); return }
      target.push(data)
    }
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr))
    const cleanup = (): void => { clearTimeout(timeout); clearTimeout(forcedClose); options.signal?.removeEventListener('abort', abort) }
    child.once('error', error => { cleanup(); reject(error) })
    child.once('close', code => {
      cleanup()
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`))
      else resolve(Buffer.concat(stdout).toString('utf8'))
    })
  })
}
