/** Exact public tool contract exported by @deepseek-ai/dsh-tool-cordis 0.1.1-rc.2. */
export const CORDIS_TOOL_NAMES = [
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
] as const

export type CordisToolName = typeof CORDIS_TOOL_NAMES[number]

const CORDIS_TOOL_NAME_SET: ReadonlySet<string> = new Set(CORDIS_TOOL_NAMES)

export function isCordisToolName(value: string): value is CordisToolName {
  return CORDIS_TOOL_NAME_SET.has(value)
}

export const CORDIS_RUNTIME_VERSION = '0.1.1-rc.2'

export const CORDIS_RUNTIME_PACKAGES = [
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-tool-cordis',
] as const

export const DEV_MODE_WARNING = [
  'DEVELOPER MODE — TRUSTED CODE EXECUTION',
  'Dynamic Cordis plugin code runs inside the Harness process and can affect every session in that process.',
  'The Cordis VM is not a security boundary. Treat this mode as having shell-equivalent authority.',
  'Definitions live only in process memory and disappear on restart until written as a normal source package and workspace patch.',
  'dshc observes lifecycle events; it does not provide a sandbox, HMR, or a private plugin runner.',
].join('\n')

export const DEV_PERSONA_APPENDIX = [
  '',
  'Cordis plugin workbench',
  '- This runtime was explicitly launched with dshc --dev. Dynamic host code has',
  '  process-wide authority and is not sandboxed. State that risk before defining',
  '  or running code, and do not describe a definition as isolated to one session.',
  '- Create an ordinary DSH/Cordis package in the repository; do not invent a dshc',
  '  plugin format. Discover and run the project\'s own typecheck, lint, build and',
  '  test commands before claiming the package works.',
  `- Use only the official lifecycle tools: ${CORDIS_TOOL_NAMES.join(', ')}.`,
  '- Host-only prototypes can run in this terminal deployment. A package with a',
  '  client half needs a browser client and cannot complete here.',
  '- There is no source HMR. Modify a prototype by defining a new immutable package',
  '  for the existing plugin, then run it in update mode.',
  '- A dynamic definition is temporary. Finish by writing a normal source package',
  '  and Cordis workspace patch, restart, and verify initialization plus behavior',
  '  before calling the result persistent.',
].join('\n')
