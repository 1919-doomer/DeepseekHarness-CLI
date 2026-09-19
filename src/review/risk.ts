import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type { Locale } from '../i18n.js'

/**
 * Deterministic risk hints for one tool call.
 *
 * These read the literal arguments the model sent and nothing else: no model
 * call, no filesystem access, no execution. That makes them instant and free,
 * and it bounds what they can know. A command that runs a script which deletes
 * things, or one deliberately obfuscated, carries no tag. A tag is a reason to
 * look; the absence of one is not evidence of safety, and nothing here blocks
 * a call.
 */
export const RISK_TAGS = ['delete', 'history', 'outward', 'outside', 'secret', 'system', 'network'] as const
export type RiskTag = typeof RISK_TAGS[number]

export interface RiskContext {
  /** Absolute workspace path. Without it nothing is judged to be outside. */
  workspace?: string
  /** Home directory for `~` and profile variables; without it they count as outside. */
  home?: string
}

/** The context for calls observed on this machine: its workspace and home. */
export function localRiskContext(workspace: string | undefined): RiskContext {
  return workspace === undefined ? { home: homedir() } : { workspace, home: homedir() }
}

const LABELS: Record<Locale, Record<RiskTag, string>> = {
  'zh-CN': { delete: '删除', history: '改历史', outward: '对外', outside: '越界', secret: '凭据', system: '系统', network: '联网' },
  en: { delete: 'delete', history: 'history', outward: 'outward', outside: 'outside', secret: 'secret', system: 'system', network: 'network' },
}

export function riskTagLabel(tag: RiskTag, locale: Locale = 'en'): string {
  return LABELS[locale][tag]
}

/**
 * Tags that ask for a look. `outside` and `network` on their own describe where
 * the work happens — often exactly what was asked for — so they are shown but
 * not highlighted.
 */
const ATTENTION: ReadonlySet<RiskTag> = new Set(['delete', 'history', 'outward', 'secret', 'system'])

export function needsAttention(tags: readonly RiskTag[]): boolean {
  return tags.some(tag => ATTENTION.has(tag))
}

/** `⚠删除·越界`, or the empty string when there is nothing to flag. */
export function formatRiskTags(tags: readonly RiskTag[], locale: Locale = 'en'): string {
  return tags.length === 0 ? '' : `⚠${tags.map(tag => riskTagLabel(tag, locale)).join('·')}`
}

export function classifyToolCall(name: string, argumentsJson: string, context: RiskContext = {}): readonly RiskTag[] {
  const args = parseArguments(argumentsJson)
  if (args === undefined) return []
  const tags = new Set<RiskTag>()

  if (name === 'pwsh' || name === 'bash') {
    const command = stringArg(args, 'command')
    if (command === undefined) return []
    const workdir = stringArg(args, 'workdir')
    if (workdir !== undefined && isOutside(workdir, context)) tags.add('outside')
    const base = workdir === undefined ? context.workspace : resolveIn(context.workspace, workdir)
    classifyCommand(command, { ...context, ...(base === undefined ? {} : { base }) }, tags)
    // Asking the sandbox for wider access is a request to reach past the
    // workspace boundary by definition.
    if (args['sandbox_permissions'] !== undefined) tags.add('system')
  } else if (name === 'write' || name === 'edit') {
    const path = stringArg(args, 'file_path')
    if (path !== undefined) {
      if (isSecretPath(path)) tags.add('secret')
      if (isShellProfile(path)) tags.add('system')
      if (isOutside(path, context)) tags.add('outside')
    }
  } else if (name === 'read' || name === 'read_image' || name === 'glob' || name === 'grep') {
    // A grep pattern is text to find, not a place, so it is not checked.
    for (const key of name === 'glob' ? ['pattern', 'path'] : ['file_path', 'path', 'include']) {
      const value = stringArg(args, key)
      if (value !== undefined && isSecretPath(value)) tags.add('secret')
    }
  }
  return RISK_TAGS.filter(tag => tags.has(tag))
}

// --- shell commands -------------------------------------------------------

interface CommandContext extends RiskContext {
  /** Directory relative paths resolve against: `workdir`, else the workspace. */
  base?: string
}

const DELETE_HEADS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'ri', 'remove-item', 'unlink', 'shred', 'rimraf', 'clear-content', 'clc', 'clear-recyclebin', 'format-volume', 'mkfs', 'wipefs'])
const NETWORK_HEADS = new Set(['curl', 'wget', 'iwr', 'invoke-webrequest', 'irm', 'invoke-restmethod', 'start-bitstransfer', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'nc', 'ncat', 'telnet', 'npx', 'pnpx', 'bunx'])
const SYSTEM_HEADS = new Set([
  'sudo', 'doas', 'runas', 'su', 'set-executionpolicy', 'regedit', 'new-itemproperty', 'set-itemproperty', 'remove-itemproperty',
  'rename-itemproperty', 'setx', 'schtasks', 'register-scheduledtask', 'unregister-scheduledtask', 'new-service', 'set-service',
  'stop-service', 'start-service', 'restart-service', 'remove-service', 'stop-process', 'kill', 'pkill', 'killall', 'taskkill',
  'chmod', 'chown', 'chgrp', 'icacls', 'takeown', 'netsh', 'bcdedit', 'diskpart', 'format', 'format-volume', 'mkfs', 'fdisk',
  'mount', 'umount', 'shutdown', 'reboot', 'halt', 'restart-computer', 'stop-computer', 'crontab', 'systemctl', 'launchctl',
  'set-mppreference', 'add-mppreference', 'remove-mppreference', 'install-module', 'install-package', 'update-module',
  'uninstall-module', 'uninstall-package', 'iex', 'invoke-expression', 'new-netfirewallrule', 'set-netfirewallprofile',
])
const SYSTEM_PACKAGE_MANAGERS = new Set(['winget', 'choco', 'scoop', 'apt', 'apt-get', 'brew', 'yum', 'dnf', 'pacman', 'snap', 'port'])
const JS_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PYTHON_PACKAGE_MANAGERS = new Set(['pip', 'pip3', 'uv', 'poetry', 'pipx', 'conda', 'mamba'])
/** Leading words that run the rest of the segment as a command. */
const WRAPPERS = new Set(['sudo', 'doas', 'nohup', 'time', 'xargs', 'exec', 'command', 'env', 'nice', 'timeout', 'start-process', 'start', 'call', 'cmd', 'powershell', 'pwsh', 'bash', 'sh'])

/**
 * Quoted text and here-strings are data — a search pattern, a message, a Python
 * program piped to stdin — so they are masked before commands are found. Only
 * a shell wrapper (`bash -c "..."`, `pwsh -Command "..."`) unwraps one again.
 * Paths and secrets are still read from the raw text, since paths are usually
 * quoted.
 */
const QUOTED = /@'[\s\S]*?'@|@"[\s\S]*?"@|'(?:[^']|'')*'|"(?:[^"`\\]|`[\s\S]|\\[\s\S])*"/g
/** Private-use code points: they cannot occur in a real command, and they are not control characters. */
const PLACEHOLDER = /^\uE000(\d+)\uE000$/
const SEPARATORS = /\r?\n|;|&&|\|\||[|&(){}]/

interface Masked {
  text: string
  /** The content of the quoted span a placeholder token stands for. */
  unquote(token: string): string | undefined
}

function maskQuotes(command: string): Masked {
  const strings: string[] = []
  const text = command.replace(QUOTED, match => {
    strings.push(match)
    return `\uE000${strings.length - 1}\uE000`
  })
  return {
    text,
    unquote: token => {
      const match = PLACEHOLDER.exec(token)
      const raw = match === null ? undefined : strings[Number(match[1])]
      if (raw === undefined) return undefined
      return raw.startsWith('@') ? raw.slice(2, -2) : raw.slice(1, -1).replaceAll("''", "'")
    },
  }
}

function classifyCommand(command: string, context: CommandContext, tags: Set<RiskTag>, depth = 0): void {
  const lower = command.toLowerCase()
  const masked = maskQuotes(command)
  const nested = (inner: string): void => { if (depth < 2) classifyCommand(inner, context, tags, depth + 1) }
  for (const segment of masked.text.toLowerCase().split(SEPARATORS)) classifySegment(words(segment), tags, masked, nested)
  if (dumpsEnvironment(masked)) tags.add('secret')

  // Fetching something and executing it in one breath runs code nobody here
  // has seen.
  if (/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring)\b[\s\S]*\|\s*(sh|bash|zsh|iex|invoke-expression|python3?|node)\b/.test(lower)
    || /\b(iex|invoke-expression)\b[\s\S]*\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring)\b/.test(lower)) {
    tags.add('system').add('network')
  }
  if (/\b(net\.webclient|downloadstring|downloadfile)\b/.test(lower)) tags.add('network')
  if (/\b(hklm|hkcu|hkcr|hku|hkcc):|registry::|hkey_(local_machine|current_user)|\[environment\]::setenvironmentvariable/.test(lower)) tags.add('system')
  if (/-verb\s+['"]?runas/.test(lower)) tags.add('system')
  if (/(add-content|set-content|out-file|new-item)\b[^;|\n]*\$profile\b|>>?\s*['"]?\$profile\b/.test(lower)) tags.add('system')
  if (/(>>?|tee(\s+-a)?|add-content|set-content|out-file)\s*['"]?~?[\\/]?[^\s'"]*\.(bashrc|zshrc|bash_profile|profile|zprofile)\b/.test(lower)) tags.add('system')

  if (secretInCommand(command)) tags.add('secret')
  if (commandLeavesWorkspace(command, context)) tags.add('outside')
}

function words(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(word => word.length > 0).map(word => word.replace(/^['"]+|['"]+$/g, ''))
}

/** `C:\tools\git.exe` → `git`; `.\rimraf.cmd` → `rimraf`. */
function commandName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word
  return base.replace(/\.(exe|cmd|bat|ps1|sh)$/, '')
}

function classifySegment(tokens: readonly string[], tags: Set<RiskTag>, masked: Masked, nested: (command: string) => void): void {
  let rest = [...tokens]
  // Environment assignments (`FOO=1 cmd`) and dot-sourcing are not the command.
  // (The PowerShell call operator `&` never gets here: segments split on it.)
  while (rest.length > 0 && (/^[a-z_][a-z0-9_]*=/.test(rest[0]!) || rest[0] === '.')) rest.shift()
  if (rest.length === 0) return

  let head = commandName(rest[0]!)
  let args = rest.slice(1)
  // `sudo rm -rf x` is both a privilege change and a delete, so the wrapper is
  // judged and then the command it wraps.
  for (let guard = 0; guard < 4 && WRAPPERS.has(head); guard++) {
    if (SYSTEM_HEADS.has(head)) tags.add('system')
    // An encoded command is unreadable by design.
    if ((head === 'pwsh' || head === 'powershell') && args.some(word => /^-(e|ec|enc|encodedcommand)$/.test(word))) { tags.add('system'); return }
    const next = args.findIndex(word => !word.startsWith('-') && !word.startsWith('/') && !/^[a-z_][a-z0-9_]*=/.test(word) && !/^\d+$/.test(word))
    if (next < 0) return
    const inner = masked.unquote(args[next]!)
    if (inner !== undefined) { nested(inner); return }
    head = commandName(args[next]!)
    args = args.slice(next + 1)
  }
  if (head === 'iex' || head === 'invoke-expression') {
    const inner = args.map(word => masked.unquote(word)).find(value => value !== undefined)
    if (inner !== undefined) nested(inner)
  }

  // Removing an environment variable, function or alias is not deleting data.
  const target = args.find(word => !word.startsWith('-'))
  if (DELETE_HEADS.has(head) && !/^(env|variable|function|alias):/.test(target ?? '')) tags.add('delete')
  if (NETWORK_HEADS.has(head)) tags.add('network')
  if (SYSTEM_HEADS.has(head)) tags.add('system')

  const sub = args.find(word => !word.startsWith('-'))
  const has = (...flags: string[]): boolean => args.some(word => flags.includes(word))

  if (head === 'git') classifyGit(args, tags)
  else if (head === 'gh') classifyGh(args, tags)
  else if (head === 'reg' && ['add', 'delete', 'import', 'copy', 'restore', 'load', 'unload'].includes(sub ?? '')) tags.add('system')
  else if (head === 'sc' && ['create', 'delete', 'config', 'stop', 'start'].includes(sub ?? '')) tags.add('system')
  else if (head === 'find' && (has('-delete') || args.includes('rm'))) tags.add('delete')
  else if (head === 'docker' || head === 'podman') {
    if (sub === 'push') tags.add('outward').add('network')
    else if (sub === 'pull' || sub === 'build') tags.add('network')
    else if (sub === 'rm' || sub === 'rmi' || sub === 'prune' || (sub === 'system' && args.includes('prune'))) tags.add('delete')
  } else if (JS_PACKAGE_MANAGERS.has(head)) {
    if (['publish', 'unpublish', 'deprecate', 'dist-tag', 'owner'].includes(sub ?? '')) tags.add('outward').add('network')
    else if (['install', 'i', 'add', 'update', 'up', 'upgrade', 'ci', 'dlx', 'create', 'global'].includes(sub ?? '')) tags.add('network')
    if (['login', 'adduser', 'token'].includes(sub ?? '')) tags.add('secret')
    // Only a global change is a system change; `npm ls -g` and `npm root -g` read.
    const changes = ['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'un', 'update', 'up', 'upgrade', 'link']
    if ((has('-g', '--global', '--location=global') && changes.includes(sub ?? '')) || sub === 'global') tags.add('system')
  } else if (PYTHON_PACKAGE_MANAGERS.has(head) || (/^python3?$|^py$/.test(head) && args[0] === '-m' && PYTHON_PACKAGE_MANAGERS.has(args[1] ?? ''))) {
    const effective = head.startsWith('p') && args[0] === '-m' ? args.slice(2) : args
    const verb = effective.find(word => !word.startsWith('-'))
    if (['install', 'add', 'download', 'sync', 'lock', 'update'].includes(verb ?? '') || (verb === 'pip' && effective.includes('install'))) tags.add('network')
    if (verb === 'publish' || verb === 'upload') tags.add('outward').add('network')
  } else if (head === 'twine' && sub === 'upload') tags.add('outward').add('network')
  else if (head === 'cargo') {
    if (sub === 'publish') tags.add('outward').add('network')
    else if (['install', 'add', 'fetch', 'update'].includes(sub ?? '')) tags.add('network')
  } else if (head === 'go' && ['get', 'install'].includes(sub ?? '')) tags.add('network')
  else if (head === 'dotnet' && (sub === 'restore' || (sub === 'add' && args.includes('package')))) tags.add('network')
  else if (head === 'dotnet' && sub === 'nuget' && args.includes('push')) tags.add('outward').add('network')
  else if (SYSTEM_PACKAGE_MANAGERS.has(head) && ['install', 'upgrade', 'update', 'uninstall', 'remove', 'add'].includes(sub ?? '')) tags.add('system').add('network')
  else if (head === 'send-mailmessage') tags.add('outward').add('network')
}

function classifyGit(args: readonly string[], tags: Set<RiskTag>): void {
  // Skip global options, including the ones that take a value.
  let index = 0
  while (index < args.length && args[index]!.startsWith('-')) {
    index += ['-c', '-C', '--git-dir', '--work-tree', '--namespace'].includes(args[index]!) ? 2 : 1
  }
  const sub = args[index]
  const rest = args.slice(index + 1)
  const has = (...flags: string[]): boolean => rest.some(word => flags.includes(word))
  switch (sub) {
    case 'clean': case 'rm': tags.add('delete'); return
    case 'reset':
      if (has('--hard')) tags.add('delete').add('history')
      else if (has('--soft', '--mixed', '--keep', '--merge') || rest.some(word => /^(head[~^]|origin\/|[0-9a-f]{7,40}$)/.test(word))) tags.add('history')
      return
    case 'checkout':
      // `git checkout -- file` and `git checkout .` discard local edits.
      if (has('--', '.', '-f', '--force')) tags.add('delete')
      return
    case 'restore':
      if (!has('--staged', '-S') || has('--worktree', '-W')) tags.add('delete')
      return
    case 'stash':
      if (has('drop', 'clear')) tags.add('delete')
      return
    case 'worktree':
      if (has('remove', 'prune')) tags.add('delete')
      return
    case 'branch':
      if (has('-d', '-D', '--delete')) tags.add('history')
      return
    case 'tag':
      if (has('-d', '--delete')) tags.add('history')
      return
    case 'rebase': case 'filter-branch': case 'filter-repo': tags.add('history'); return
    case 'commit':
      if (has('--amend')) tags.add('history')
      return
    case 'update-ref':
      if (has('-d')) tags.add('history')
      return
    case 'reflog':
      if (has('expire', 'delete')) tags.add('history')
      return
    case 'push':
      tags.add('outward').add('network')
      if (has('-f', '--force', '--force-with-lease', '--force-if-includes', '-d', '--delete', '--mirror', '--prune')
        || rest.some(word => word.startsWith('+') || word.startsWith(':') || word.startsWith('--force-with-lease='))) tags.add('history')
      return
    case 'clone': case 'fetch': case 'pull': case 'ls-remote': tags.add('network'); return
    case 'submodule':
      if (has('update', 'add', 'sync')) tags.add('network')
      return
    case 'config': {
      // Reading configuration (`--list`, `--get`, or a key with no value) is not a change.
      const positional = rest.filter(word => !word.startsWith('-'))
      const writes = positional.length >= 2 || has('--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e', '--remove-section', '--rename-section')
      if (has('--global', '--system') && writes && !has('--get', '--get-all', '--get-regexp', '--list', '-l')) tags.add('system')
      return
    }
    case 'credential': tags.add('secret'); return
  }
}

const GH_OUTWARD: Record<string, readonly string[]> = {
  pr: ['create', 'merge', 'close', 'comment', 'review', 'edit', 'reopen', 'ready', 'lock', 'unlock'],
  issue: ['create', 'close', 'comment', 'edit', 'reopen', 'delete', 'transfer', 'lock', 'unlock', 'pin', 'unpin'],
  release: ['create', 'delete', 'upload', 'edit', 'delete-asset'],
  repo: ['create', 'delete', 'edit', 'rename', 'archive', 'unarchive', 'fork', 'sync'],
  gist: ['create', 'edit', 'delete', 'rename'],
  workflow: ['run', 'enable', 'disable'],
  run: ['rerun', 'cancel', 'delete'],
  secret: ['set', 'delete'],
  variable: ['set', 'delete'],
  label: ['create', 'edit', 'delete', 'clone'],
}

function classifyGh(args: readonly string[], tags: Set<RiskTag>): void {
  tags.add('network')
  const [group, verb] = args.filter(word => !word.startsWith('-'))
  if (group === undefined) return
  if (verb !== undefined && GH_OUTWARD[group]?.includes(verb)) tags.add('outward')
  if (group === 'secret' || (group === 'auth' && verb === 'token')) tags.add('secret')
  if (group === 'api') {
    const method = args.findIndex(word => word === '-x' || word === '--method')
    const explicit = method >= 0 ? args[method + 1] : args.find(word => word.startsWith('--method='))?.slice(9)
    const writes = explicit !== undefined ? explicit !== 'get' : args.some(word => ['-f', '-F', '--field', '--raw-field', '--input'].includes(word))
    if (writes) tags.add('outward')
  }
}

// --- secrets ---------------------------------------------------------------

const SECRET_FILE = /(^|[\\/\s'"=:])(\.env(\.(?!example\b|sample\b|template\b|dist\b)[\w-]+)?|\.envrc|id_(rsa|dsa|ecdsa|ed25519)(?!\.pub)|auth\.json|credentials(\.json)?|\.git-credentials|\.npmrc|\.pypirc|_?\.?netrc|[\w.*-]+\.(pem|key|pfx|p12|keystore|jks|kdbx)|secrets?\.(json|ya?ml|toml|env))(?=$|[\s'"\\/;|,)*])/i
const SECRET_DIR = /(^|[\\/\s'"=:~])\.(ssh|aws|gnupg|azure|kube[\\/]config|docker[\\/]config\.json|config[\\/]gh[\\/]hosts\.yml)(?=$|[\s'"\\/;|,)*])/i

function isSecretPath(value: string): boolean {
  return SECRET_FILE.test(value) || SECRET_DIR.test(value)
}

function isShellProfile(path: string): boolean {
  return /(^|[\\/])(\.bashrc|\.zshrc|\.bash_profile|\.zprofile|\.profile|microsoft\.powershell_profile\.ps1|profile\.ps1)$/i.test(path)
    || path.startsWith('/etc/')
}

const SECRET_NAME = String.raw`[a-z0-9_]*(key|token|secret|passw(or)?d|credential)[a-z0-9_]*`
/** PowerShell `$env:X`, cmd `%X%` and .NET lookups; any case. */
const SECRET_VARIABLE = new RegExp(String.raw`\$env:${SECRET_NAME}\b|\$\{env:${SECRET_NAME}\}|%${SECRET_NAME}%|getenvironmentvariable\(\s*['"]${SECRET_NAME}['"]`, 'i')
/**
 * POSIX `$X` / `${X}`, upper case only: that is the environment convention, and
 * it keeps a PowerShell loop variable like `$key` from counting.
 */
const SECRET_POSIX_VARIABLE = /\$\{?[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSW(OR)?D|CREDENTIAL)[A-Z0-9_]*\b/

function secretInCommand(command: string): boolean {
  if (isSecretPath(command)) return true
  if (SECRET_VARIABLE.test(command) || SECRET_POSIX_VARIABLE.test(command)) return true
  return /\b(cmdkey|security\s+find-(generic|internet)-password|convertfrom-securestring)\b/i.test(command)
}

/** Words that, in a variable name or a filter over names, point at a credential. */
const SECRETISH = /key|token|secret|pass|credential|auth|deepseek|api/i

/**
 * Listing the environment prints every secret in it — unless the listing is
 * narrowed to names that carry none. `Get-ChildItem env: | Where-Object Name
 * -like 'DSH_*'` is the common, harmless case; a filter on `DEEPSEEK` is not.
 */
function dumpsEnvironment(masked: Masked): boolean {
  for (const statement of masked.text.split(/\r?\n|;|&&|\|\|/)) {
    const [first = '', ...stages] = statement.split('|')
    const named = /(?:^|\s)(?:gci|get-childitem|dir|ls|get-item)\s+(?:-path\s+)?env:\\?(\S*)/i.exec(first)
    const bare = /^\s*(?:printenv|env|set)\s*$/i.test(first) || /\[environment\]::getenvironmentvariables\(\s*\)/i.test(first)
    if (named !== null || bare) {
      // `Env:DSH_*` names what it lists, so it is judged by that name.
      const name = named?.[1] ?? ''
      if (name !== '') {
        if (name === '*' || SECRETISH.test(name)) return true
        continue
      }
      const filter = stages.find(stage => /^\s*(where-object|where|\?|select-string|sls|findstr|grep)\b/i.test(stage))
      if (filter === undefined) return true
      const text = filter.replace(/\uE000\d+\uE000/g, token => masked.unquote(token) ?? '')
      if (SECRETISH.test(text)) return true
      continue
    }
    const printed = /(?:^|\s)printenv\s+(\S+)/i.exec(first)
    if (printed !== null && SECRETISH.test(printed[1]!)) return true
  }
  return false
}

// --- paths -----------------------------------------------------------------

function flavorOf(path: string): typeof win32 | typeof posix {
  return /^[a-zA-Z]:[\\/]|^\\\\/.test(path) ? win32 : posix
}

function resolveIn(workspace: string | undefined, path: string): string | undefined {
  if (workspace === undefined) return undefined
  return flavorOf(workspace).resolve(workspace, path)
}

function isOutside(path: string, context: RiskContext, base = context.workspace): boolean {
  const workspace = context.workspace
  if (workspace === undefined) return false
  const home = /^(~|\$home|\$env:userprofile|%userprofile%)(?=$|[\\/])/i.exec(path)
  // An unknown home is judged outside rather than guessed at.
  if (home !== null && context.home === undefined) return true
  const expanded = home === null ? path : `${context.home}${path.slice(home[0].length)}`
  const flavor = flavorOf(workspace)
  const resolved = flavor.resolve(base ?? workspace, expanded)
  const windows = flavor === win32
  const relative = flavor.relative(windows ? workspace.toLowerCase() : workspace, windows ? resolved.toLowerCase() : resolved)
  return relative.startsWith('..') || flavor.isAbsolute(relative)
}

const WINDOWS_ABSOLUTE = /(?<![\w$])([a-zA-Z]:[\\/][^\s'"|;,<>(){}`]*)/g
const UNC = /(?<![\w\\])(\\\\[\w.$-]+\\[^\s'"|;,<>(){}`]*)/g
const HOME_REFERENCE = /(?<![\w$])((?:~|\$home|\$env:userprofile|%userprofile%)(?:[\\/][^\s'"|;,<>(){}`]*)?)(?=$|[\s'"|;,<>(){}`])/gi
const SYSTEM_LOCATION = /(\$env:|%)(appdata|localappdata|programfiles|programdata|windir|systemroot|temp|tmp|allusersprofile|public)\b/i
const POSIX_ABSOLUTE = /(?<=^|[\s'"=(])(\/(?:[\w.@+-]+\/)+[\w.@+*-]*|\/(?:etc|usr|var|home|root|opt|tmp|mnt|users|bin|sbin|lib|proc|sys|boot|private|volumes)\b[^\s'"|;,<>(){}`]*)/gi
const PARENT_RELATIVE = /(?<=^|[\s'"=(])(\.\.(?:[\\/][^\s'"|;,<>(){}`]*)?)(?=$|[\s'"|;,<>(){}`])/g

function commandLeavesWorkspace(command: string, context: CommandContext): boolean {
  const workspace = context.workspace
  if (workspace === undefined) return false
  const windowsWorkspace = flavorOf(workspace) === win32
  // Trailing sentence punctuation is not part of a path; `..` itself is.
  const outside = (path: string): boolean => isOutside(path.replace(/([^.])[.,:]+$/, '$1'), context, context.base)

  if (SYSTEM_LOCATION.test(command)) return true
  for (const [, path] of command.matchAll(WINDOWS_ABSOLUTE)) if (outside(path!)) return true
  if (command.match(UNC) !== null) return true
  for (const [, path] of command.matchAll(HOME_REFERENCE)) if (outside(path!)) return true
  for (const [, path] of command.matchAll(PARENT_RELATIVE)) if (outside(path!)) return true
  for (const [, path] of command.matchAll(POSIX_ABSOLUTE)) {
    if (/^\/dev\/(null|stdout|stderr|stdin|tty)$/.test(path!)) continue
    // On a Windows workspace a slash path is far more often a URL route or a
    // search pattern than a place, except Git Bash's `/c/...` drive form.
    if (windowsWorkspace) {
      const drive = /^\/([a-zA-Z])(\/.*)?$/.exec(path!)
      if (drive !== null && outside(`${drive[1]}:${(drive[2] ?? '/').replaceAll('/', '\\')}`)) return true
      continue
    }
    if (outside(path!)) return true
  }
  return false
}

// --- helpers ---------------------------------------------------------------

function parseArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
