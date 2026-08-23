import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeNetwork, readNetworkFacts, redactProxyTarget } from '../../src/upstream/network.js'
import { buildPersona } from '../../src/upstream/persona.js'

const workspace = tmpdir()

describe('network facts', () => {
  it('reports the proxy variables that are actually set', () => {
    const facts = readNetworkFacts({ HTTPS_PROXY: 'http://gw:8080', NO_PROXY: 'localhost' }, workspace)
    expect(facts.proxies).toEqual([{ variable: 'HTTPS_PROXY', target: 'http://gw:8080' }])
    expect(facts.noProxy).toBe('localhost')
  })

  it('reports one protocol once when both spellings are set', () => {
    const facts = readNetworkFacts({ HTTPS_PROXY: 'http://gw:8080', https_proxy: 'http://gw:8080' }, workspace)
    expect(facts.proxies).toHaveLength(1)
  })

  it('ignores an empty variable rather than reporting an empty proxy', () => {
    expect(readNetworkFacts({ HTTP_PROXY: '   ' }, workspace).proxies).toEqual([])
  })

  it('strips credentials out of a proxy URL', () => {
    // The value reaches diagnostics and the persona, so it reaches the model.
    expect(redactProxyTarget('http://alice:hunter2@gw:8080')).toBe('http://***@gw:8080')
    expect(redactProxyTarget('http://gw:8080')).toBe('http://gw:8080')
    const facts = readNetworkFacts({ HTTP_PROXY: 'https://u:p@proxy.internal:3128' }, workspace)
    expect(facts.proxies[0]?.target).toBe('https://***@proxy.internal:3128')
    expect(describeNetwork(facts).join(' ')).not.toContain('p@')
  })

  it('prefers an explicit registry variable over any file', () => {
    const facts = readNetworkFacts({ npm_config_registry: 'https://mirror.example/' }, workspace)
    expect(facts.registry).toEqual({ url: 'https://mirror.example/', source: 'npm_config_registry' })
  })

  it('reads the workspace .npmrc, taking the last default registry line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dshc-npmrc-'))
    await writeFile(join(dir, '.npmrc'), [
      '# a comment',
      '@scope:registry=https://scoped.example/',
      'registry=https://first.example/',
      'registry=https://last.example/',
    ].join('\n'), 'utf8')

    const facts = readNetworkFacts({}, dir)
    // A scoped registry binds one scope; it is not what an unscoped install uses.
    expect(facts.registry?.url).toBe('https://last.example/')
  })
})

describe('network facts in the persona', () => {
  const base = { platform: 'linux' as NodeJS.Platform, workspace: '/w' }

  it('states the configuration and refuses to claim reachability', () => {
    const persona = buildPersona({
      ...base,
      network: {
        proxies: [{ variable: 'HTTPS_PROXY', target: 'http://gw:8080' }],
        registry: { url: 'https://mirror.example/', source: 'npm_config_registry' },
      },
    })
    expect(persona).toContain('HTTPS_PROXY=http://gw:8080')
    expect(persona).toContain('https://mirror.example/')
    expect(persona).toContain('did not probe')
  })

  it('says so plainly when there is nothing configured', () => {
    const persona = buildPersona({ ...base, network: { proxies: [] } })
    expect(persona).toContain('No HTTP proxy is configured')
    expect(persona).toContain('reachability is unknown')
  })

  it('never carries a proxy credential into the prompt', () => {
    const persona = buildPersona({
      ...base,
      network: { proxies: [{ variable: 'HTTP_PROXY', target: redactProxyTarget('http://a:secret@gw:1') }] },
    })
    expect(persona).not.toContain('secret')
  })

  it('still carries no {{variable}} reference with network lines present', () => {
    expect(buildPersona({
      ...base,
      network: { proxies: [{ variable: 'HTTP_PROXY', target: 'http://gw:1' }], noProxy: 'a,b' },
    })).not.toContain('{{')
  })
})
