import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Network facts dshc can observe about the host it launched on.
 *
 * The model otherwise reasons about a generic internet. On a host behind a
 * corporate proxy, or pointed at a registry mirror that does not proxy github,
 * `npm install -g <github url>` is not a suggestion that might fail — it is one
 * that cannot succeed, and the person pays for the timeout.
 *
 * Everything here is read, never executed: shelling out to `npm config get`
 * would add seconds to every launch to learn something `.npmrc` already says.
 * Nothing is inferred about reachability — dshc does not probe the network, and
 * a proxy being set is not evidence that it works.
 */

export interface ProxyFact {
  /** Environment variable that set it, reported as written. */
  variable: string
  /** Proxy target with any credentials removed. */
  target: string
}

export interface RegistryFact {
  url: string
  /** Where the value was read from, for the reader to go and change it. */
  source: string
}

export interface NetworkFacts {
  proxies: readonly ProxyFact[]
  noProxy?: string
  registry?: RegistryFact
}

/** Proxy variables in precedence order; the lowercase spelling is conventional on POSIX. */
const PROXY_VARIABLES = [
  'HTTPS_PROXY', 'https_proxy',
  'HTTP_PROXY', 'http_proxy',
  'ALL_PROXY', 'all_proxy',
] as const

export function readNetworkFacts(env: NodeJS.ProcessEnv, workspace: string): NetworkFacts {
  const proxies: ProxyFact[] = []
  const seen = new Set<string>()
  for (const variable of PROXY_VARIABLES) {
    const raw = env[variable]
    if (raw === undefined || raw.trim().length === 0) continue
    // HTTPS_PROXY and https_proxy usually carry the same value; report the
    // protocol once rather than twice under two spellings.
    const key = variable.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    proxies.push({ variable, target: redactProxyTarget(raw.trim()) })
  }

  const noProxy = env.NO_PROXY ?? env.no_proxy
  const registry = readRegistry(env, workspace)

  return {
    proxies,
    ...(noProxy === undefined || noProxy.trim().length === 0 ? {} : { noProxy: noProxy.trim() }),
    ...(registry === undefined ? {} : { registry }),
  }
}

/**
 * A proxy URL may carry `user:password@`. It reaches diagnostics, the persona
 * and therefore the model, so the credential is removed at the point of
 * reading rather than at each point of display.
 */
export function redactProxyTarget(target: string): string {
  const at = target.lastIndexOf('@')
  const scheme = target.indexOf('://')
  const withoutUserInfo = at >= 0 && scheme >= 0 && at >= scheme
    ? `${target.slice(0, scheme + 3)}***@${target.slice(at + 1)}`
    : target
  return withoutUserInfo.replace(
    /([?&](?:api[_-]?key|token|secret|password|authorization|credential)=)[^&#]*/gi,
    '$1[REDACTED]',
  )
}

function readRegistry(env: NodeJS.ProcessEnv, workspace: string): RegistryFact | undefined {
  const fromEnv = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return { url: redactProxyTarget(fromEnv.trim()), source: 'npm_config_registry' }
  }

  for (const candidate of [join(workspace, '.npmrc'), join(homedir(), '.npmrc')]) {
    const url = readRegistryLine(candidate)
    if (url !== undefined) return { url: redactProxyTarget(url), source: candidate }
  }
  return undefined
}

function readRegistryLine(path: string): string | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }

  let found: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
    // Only the default registry; `@scope:registry=` binds one scope and is not
    // what a command without a scope will use.
    const match = /^registry\s*=\s*(.+)$/.exec(line)
    if (match?.[1] === undefined) continue
    found = match[1].trim()
  }
  return found
}

/** One-line summary for the persona and for diagnostics, or `undefined` when there is nothing to say. */
export function describeNetwork(facts: NetworkFacts): readonly string[] {
  const lines: string[] = []
  if (facts.proxies.length > 0) {
    const list = facts.proxies.map(proxy => `${proxy.variable}=${proxy.target}`).join(', ')
    lines.push(`proxy: ${list}`)
    if (facts.noProxy !== undefined) lines.push(`no_proxy: ${facts.noProxy}`)
  }
  if (facts.registry !== undefined) lines.push(`npm registry: ${facts.registry.url}`)
  return lines
}
