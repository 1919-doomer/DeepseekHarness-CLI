# Dependency and toolchain policy

## Upstream baseline

Reviewed 2026-08-20 against DeepSeek Harness `0.1.0-rc.8`:

- Node: `^22.19.0 || >=24.0.0` upstream-supported range;
- package manager: pnpm `11.7.0`;
- upstream project is ESM/TypeScript;
- upstream uses TypeScript 6.x and Vitest 4.x.

M1 should align with this baseline unless an ADR documents a reason to differ.

## Host policy

### Runtime

Use modern Node ESM. Do not add a second language runtime to the core terminal host without a concrete requirement.

### Package manager

Use pnpm and commit the lockfile. CI uses the pinned package-manager version.

### TypeScript

Use strict TypeScript. Upstream-facing unknown data is validated/guarded at the adapter boundary rather than asserted globally.

### Tests

Vitest is the preferred baseline to remain close to upstream tooling and keep fixture/unit tests simple.

### Lint/format

Keep the toolchain small. Prefer a fast linter compatible with TypeScript/ESM. Formatting and linting are separate concerns; M1 scaffold issue #2 will lock exact config.

## Dependency admission rules

A new runtime dependency must answer:

1. What concrete problem does it solve?
2. Can Node built-ins or the official DSH SDK solve it adequately?
3. Is it maintained and compatible with the supported Node range?
4. What supply-chain and transitive-dependency surface does it add?
5. Does it run on Windows without shell/POSIX assumptions?
6. Can it be isolated so replacing it does not affect protocol semantics?

## TUI framework

No full-screen TUI framework is selected during M0/M1. M1 uses a plain renderer; M2 proves interaction semantics. At M3 entry, evaluate candidates (including Ink if still appropriate) against:

- Windows Terminal behavior;
- input/editing and resize support;
- testability;
- accessibility/non-color semantics;
- large-output performance;
- maintenance activity;
- ESM/Node compatibility;
- dependency weight;
- ease of consuming the local normalized event projection.

Record the final choice as an ADR.

## DeepSeek Harness dependencies

Prefer official published SDK/runtime surfaces. Never spread private/internal Harness package imports through the codebase. Version-specific launch/protocol logic stays behind `src/upstream/`.

Because Harness is developer preview:

- pin the exact tested upstream version in M1;
- update the compatibility document before bumping;
- run fixture + official-runtime smoke tests on every supported bump;
- do not use broad semver ranges as a substitute for compatibility testing.

## Credential policy

No custom credential storage before alpha. Use environment/upstream mechanisms; scrub secrets from diagnostics.

## CI dependency policy

Required CI must work without provider credentials. Never expose secrets to untrusted fork PRs.

## Version bump policy

Routine dependency updates may be grouped, but DeepSeek Harness version changes are compatibility changes, not ordinary dependency bumps. They require review of protocol/runtime assumptions and `docs/UPSTREAM-COMPATIBILITY.md`.