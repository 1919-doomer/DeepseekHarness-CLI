/**
 * The deployment persona dshc launches Harness with.
 *
 * Harness already tells the model most of what it needs: the sandbox plugin
 * contributes the file policy and workspace root, the approval plugin
 * contributes the policy sentence, each tool plugin contributes its own
 * guidance, and `dsh-agent-instructions` loads `AGENTS.md`/`CLAUDE.md` from the
 * workspace. This persona deliberately does not restate any of that.
 *
 * What it adds is the part only dshc knows, because dshc is the half of the
 * system that decides it: which host the runtime was launched on, where its
 * workspace is, and what the attached client can and cannot do. Left unsaid,
 * a model infers a friendlier deployment than this one — it asks for sandbox
 * escalation nobody can answer, or starts a command that can only be stopped
 * by killing the session.
 *
 * Two constraints govern every edit here:
 *
 * 1. `dsh-system-prompt` interpolates strict `{{variable}}` references and
 *    throws on an unknown or undefined one. This text carries no references;
 *    facts are substituted here, where a missing value is a type error rather
 *    than a runtime prompt failure.
 * 2. It states what dshc owns, never what the composition configures. A
 *    sentence about `reasoningEffort` or a compaction ratio would duplicate an
 *    upstream schema and turn their next release into our lie — the same
 *    coupling that produced #83 and #84.
 */

import { describeNetwork, type NetworkFacts } from './network.js'
import { DEV_PERSONA_APPENDIX } from '../workbench/contract.js'

export interface PersonaFacts {
  /** Host platform, as `process.platform` reports it. */
  platform: NodeJS.Platform
  /** Absolute workspace path dshc launched the runtime with. */
  workspace: string
  /** Proxy and registry configuration observed at launch. */
  network: NetworkFacts
}

/** Environment variable a deployment uses to replace the persona wholesale. */
export const PERSONA_ENV_VAR = 'DSH_SYSTEM_PROMPT'

export function buildPersona(facts: PersonaFacts): string {
  return [
    'You are a coding agent working in a real repository. A person is driving you',
    'from a terminal and reads everything you write.',
    '',
    'Your deployment',
    `- dshc launched this runtime with its workspace at ${facts.workspace}.`,
    `- The host operating system is ${hostDescription(facts.platform)}.`,
    `  ${pathConvention(facts.platform)} The shell tool you are offered is the one`,
    '  that matches this host; write commands in that shell\'s own language rather',
    '  than translating from another, and prefer a dedicated tool (read, write,',
    '  edit, glob, grep) over a shell command that does the same job.',
    '- The client attached to this runtime is dshc, a terminal front end. It has no',
    '  way to answer an approval prompt, so anything that needs approval fails',
    '  closed rather than reaching the person. Do not request sandbox escalation.',
    '  Work inside the standing policy, and if that makes a step impossible, say so',
    '  plainly instead of retrying it.',
    '- The official transport has no per-request cancel. During an active turn,',
    '  dshc implements Interrupt by terminating the whole Harness runtime and',
    '  starting a fresh one. The interrupted session cannot be resumed, so prefer',
    '  bounded commands and set a timeout when one might wait for input.',
    '- The current terminal surface cannot reliably render Markdown; treat it as',
    '  unable to render Markdown. Write plain text. Do not rely on Markdown headings,',
    '  emphasis markers, fenced code blocks, tables or nested list formatting.',
    '  Keep prose, short flat lists and code excerpts narrow and easy to scan.',
    ...networkLines(facts.network),
    '',
    'How to work',
    '- Inspect before you change: read the file, then edit it.',
    '- Keep changes focused on what was asked, and match the surrounding code.',
    '- Verify your own work — run the test, re-read the file, check the exit code.',
    '  A tool returning without an error is not evidence that the change is right.',
    '- Report faithfully. Say what you did not do, what you could not verify, and',
    '  what failed, in the same breath as what worked.',
  ].join('\n')
}

export function buildDeveloperPersona(facts: PersonaFacts): string {
  return `${buildPersona(facts)}\n${DEV_PERSONA_APPENDIX}`
}

/**
 * The persona the child runtime should launch with, or `undefined` when the
 * deployment already set one. An explicit `DSH_SYSTEM_PROMPT` wins: a person
 * who wrote their own persona did so to replace this, not to be merged with it.
 */
export function resolvePersona(
  env: NodeJS.ProcessEnv,
  facts: PersonaFacts,
  devMode = false,
): string | undefined {
  const configured = env[PERSONA_ENV_VAR]
  if (configured !== undefined && configured.trim().length > 0) return undefined
  return devMode ? buildDeveloperPersona(facts) : buildPersona(facts)
}

/**
 * What dshc observed about the host's network configuration — never what it
 * concluded. dshc does not probe reachability, and a proxy variable being set
 * is not evidence that the proxy works. Stating the configuration and stopping
 * there is what keeps this from becoming a confident guess about the internet.
 */
function networkLines(network: NetworkFacts): readonly string[] {
  const observed = describeNetwork(network)
  if (observed.length === 0) {
    return [
      '- No HTTP proxy is configured for this process, and no npm registry override',
      '  was found. dshc did not probe the network, so reachability is unknown.',
    ]
  }

  return [
    '- Network configuration observed at launch:',
    ...observed.map(line => `    ${line}`),
    '  dshc did not probe reachability, so treat these as constraints rather than',
    '  guarantees. Give network commands an explicit timeout, and when one hangs,',
    '  report it instead of retrying — a retry that also hangs costs the session.',
  ]
}

function hostDescription(platform: NodeJS.Platform): string {
  switch (platform) {
    case 'win32': return 'Windows'
    case 'darwin': return 'macOS'
    case 'linux': return 'Linux'
    default: return platform
  }
}

function pathConvention(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'Paths use backslashes and compare case-insensitively.'
    : 'Paths use forward slashes and compare case-sensitively.'
}
