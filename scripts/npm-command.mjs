import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Node 24 on Windows does not execute npm.cmd directly with shell=false.
 * Prefer npm's JavaScript entry so package checks retain argument boundaries
 * and do not need a command shell. POSIX runners can resolve npm from PATH.
 */
export function npmInvocation(args) {
  if (process.platform !== 'win32') return { command: 'npm', args }

  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const cli = candidates.find(existsSync)
  if (cli === undefined) {
    throw new Error(`Unable to locate npm CLI beside ${process.execPath}`)
  }
  return { command: process.execPath, args: [cli, ...args] }
}
