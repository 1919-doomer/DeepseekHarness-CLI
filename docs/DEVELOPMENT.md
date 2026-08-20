# Development

GitHub is the project source of truth. Long-lived contracts live in `docs/`; executable work and current status live in GitHub Issues.

## Validated toolchain

Use the toolchain supported by the pinned DeepSeek Harness baseline unless a documented compatibility problem requires a change:

- TypeScript / ESM;
- Node `^22.19.0 || >=24.0.0`;
- pnpm `11.7.0`;
- DeepSeek Harness `0.1.0-rc.8` public SDK/runtime surfaces;
- Ink `7.1.1` + React `19.2.8` for the M3 TTY product;
- Vitest for deterministic unit/integration tests;
- GitHub Actions with Windows, macOS, and Ubuntu blocking supported paths.

Exact dependencies are locked. Presentation dependencies must not force an unnecessary change to the validated Harness Node baseline.

## Source layout

```text
src/
├─ cli/          # executable, mode routing, one-shot + persistent entrypoints
├─ commands/     # legacy/plain local command parsing where still needed
├─ config/       # local configuration
├─ lifecycle/    # signals, shutdown, process ownership
├─ plugins/      # M3 first-party terminal plugin API, host and built-ins
├─ session/      # session selection, normalized events/projection/reducers
├─ terminal/     # plain renderer, transcript projection, Ink terminal product
└─ upstream/     # all DSH SDK/runtime/version-specific adaptation

runtime/         # public Cordis composition
tests/           # unit, fake-runtime, product and official-runtime integration
docs/            # compact long-lived documentation
```

Dependency direction:

```text
terminal product / commands / plugins
                 ↓
       normalized session state
                 ↓
         upstream adapter
                 ↓
    official DSH SDK/runtime
```

Never import private Harness implementation objects into terminal/plugin modules.

## Mode contract

- TTY invocation with no one-shot prompt enters the Ink terminal product.
- Positional prompts, `run`, piped stdin and `--json` remain plain one-shot paths.
- Non-TTY `--interactive` retains M2 line-by-line persistent input for scripts and deterministic automation.
- One runtime is initialized once and reused across interactive turns.
- The selected session remains stable until `/new`.
- `/new` selects a fresh session but cannot close the previous upstream session under protocol `0.0.1`.
- Local slash commands are intercepted before the model boundary.
- `//text` sends a literal slash-prefixed prompt.
- Ctrl+C closes the whole owned runtime while upstream lacks prompt cancellation.

## M3 terminal plugin discipline

The terminal plugin API is versioned and first-party only.

Current registries:

- commands;
- event/tool renderers;
- views;
- status segments.

Registry conflicts fail loudly. Specialized renderers must have a safe generic fallback. Plugin code may alter presentation/local navigation only; it must not silently alter Harness model routing, tool semantics, approval/sandbox policy, persistence or subagent scheduling.

Do not add arbitrary package discovery/loading in M3. Third-party extension work requires a reviewed isolation/security design first.

## Local activity grouping

The M3 transcript generates a local activity id around each `HarnessRuntime.run()` interval so repeated prompts in one Harness session remain distinct UI blocks.

This is a presentation implementation detail, not an upstream id. Tests and diagnostics must not interpret it as protocol causality.

## Test strategy

Required CI remains credential-free.

### Unit tests

Cover pure logic including argument/command parsing, plugin registration/conflicts, session selection, normalized projection, capability/trace formatting, same-session activity grouping, folding and terminal-control sanitization.

### Injected terminal-product integration

`tests/integration/product.fake.spec.ts` drives the real Ink product with TTY-like streams and the deterministic fake Harness runtime. It verifies:

- Ink raw-mode ownership and cleanup;
- alternate-screen entry/restore;
- two prompts using one Harness session;
- local Capability Explorer commands;
- resize handling;
- clean `/exit`;
- no hidden reasoning leakage.

This test is part of normal `pnpm test`, so the Runtime matrix exercises it on Windows, macOS and Ubuntu instead of relying on Linux-only pseudo-terminal tooling.

### Fake-runtime subprocess integration

The existing deterministic JSON-RPC subprocess suite continues to cover receipt ownership, ordering, unrelated-session filtering, M2 line-mode interaction, `/new`, EOF, POSIX active-turn SIGINT, timeout, malformed response, transport loss, crash, redaction and bounded shutdown.

### Official-runtime smoke

The published Harness runtime is launched with the repository Cordis composition. The DeepSeek adapter is routed to a local deterministic HTTP model stub, so required CI makes no paid provider call and needs no real key.

Required smoke paths:

1. one-shot: launch -> initialize -> prompt -> events -> idle -> shutdown;
2. persistent line mode: one `dshc --interactive` process -> two prompts on one named session -> expanded second provider history -> clean shutdown.

The M3 product itself is tested against the same `HarnessRuntime` contract through injected TTY streams, while the official-runtime smokes continue to validate the published upstream process boundary.

## Cross-platform rules

Windows is first-class. Do not assume `/bin/sh`, POSIX paths/quoting, Unix-only signals, identical ANSI behavior or POSIX Ctrl+C injection semantics.

Required matrix:

- Windows latest / Node 24 — blocking;
- macOS latest / Node 24 — blocking;
- Ubuntu latest / Node 24 — blocking;
- Ubuntu latest / Node 22.19.0 — blocking lower-bound coverage.

Every Runtime matrix job must build the Ink/React product before running tests.

## Terminal security and reliability

Treat terminal-bound content as hostile. Model text, tool output, filenames, repository content and diagnostics may contain active control sequences.

Release blockers include:

- escape/control/bidi injection;
- provider credential leakage;
- hidden state-changing tool activity;
- UI behavior that weakens upstream approval/sandbox semantics;
- orphaned processes;
- alternate-screen state not restored after failure;
- unbounded practical output growth;
- arbitrary unisolated third-party plugin loading.

Large output may be folded with visible disclosure, never silently deleted. `dshc` should not own provider credentials; prefer upstream/environment mechanisms and scrub diagnostics.

See root `SECURITY.md`.

## Diagnostics

Debug output must never corrupt Harness stdout JSON-RPC. Useful scrubbed metadata includes dshc/upstream versions, runtime/config resolution, session ids, public event categories/counts, lifecycle transitions and process exit reason/code.

Do not log secrets or hidden reasoning. `/trace` is a normalized observable timeline, not a chain-of-thought viewer.

A later `dshc doctor` should diagnose runtime resolution, Node/pnpm compatibility, Harness/SDK versions, protocol handshake, provider configuration presence, terminal capabilities and optional bridge/plugin compatibility without printing secrets.

## Pull requests and definition of done

A feature PR should state the Issue/milestone advanced, upstream contract relied on, user-visible behavior, tests run, compatibility/security implications and documentation changes.

A task is done when its Issue acceptance criteria are met, required tests pass, protocol/security/cross-platform implications are covered, long-lived docs match actual behavior and no known blocker is hidden by a renderer or compatibility shim.

Suggested commit prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Public-alpha release gates

The first public alpha requires at minimum:

- fresh documented install/start path;
- M1-M4 blockers closed;
- pinned compatibility statement;
- Windows/Linux/macOS validation for supported paths;
- zero known terminal-injection or credential-leak blockers;
- deterministic child-process and terminal-state cleanup;
- required CI independent of secrets;
- unofficial/community status clear in package/repository docs;
- update/uninstall and diagnostics instructions.

Use GitHub Issues for live execution state; do not duplicate task checklists across more documents.
