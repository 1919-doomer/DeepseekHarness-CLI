# Development

GitHub is the project source of truth. Long-lived contracts live in `docs/`; executable work and current status live in GitHub Issues.

## Validated toolchain

Use the toolchain supported by the pinned DeepSeek Harness baseline unless a documented compatibility problem requires a change:

- TypeScript / ESM;
- Node `^22.19.0 || >=24.0.0`;
- pnpm `11.7.0`;
- DeepSeek Harness `0.1.1-rc.2` public SDK/runtime surfaces;
- Ink `7.1.1` + React `19.2.8` for the TTY product;
- Vitest for deterministic unit/integration tests;
- GitHub Actions with Windows, macOS, and Ubuntu blocking supported paths.

Exact dependencies are locked. Presentation dependencies must not force an unnecessary change to the validated Harness Node baseline.

## Source layout

```text
src/
├─ cli/          # executable, mode routing, doctor, one-shot + persistent entrypoints
├─ commands/     # legacy/plain local command parsing where still needed
├─ config/       # local configuration
├─ lifecycle/    # signals, shutdown, process ownership
├─ plugins/      # first-party terminal plugin API, host and built-ins
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
- Positional prompts, `run`, piped stdin and one-shot `--json` remain plain paths.
- `doctor` is a dedicated preflight mode; it never creates a session or calls `session/prompt`.
- `doctor --json` is machine-readable and uses the same terminal-safe JSON serializer as one-shot mode.
- Non-TTY `--interactive` retains line-by-line persistent input for scripts and deterministic automation.
- One runtime is initialized once and reused across interactive turns.
- The selected session remains stable until `/new`.
- `/new` selects a fresh session but cannot close the previous upstream session under protocol `0.0.1`.
- Local slash commands are intercepted before the model boundary; malformed local commands remain local errors.
- `//text` sends a literal slash-prefixed prompt.
- Ctrl+C closes the whole owned runtime while upstream lacks prompt cancellation.
- SIGINT/SIGTERM ownership begins before runtime startup. A close request during workspace/version/launch/initialize work is terminal: startup must not later publish a live client or successful metadata, and repeated close calls remain idempotent.

## Terminal plugin discipline

The terminal plugin API is versioned and first-party only.

Current registries:

- commands;
- event/tool renderers;
- views;
- status segments.

Registration is transactional. Command/alias, view, renderer-id and status-id conflicts are rejected before any part of an incoming plugin mutates the host. Specialized renderers must have a safe generic fallback.

Plugin callbacks are presentation boundaries. Command failures stay local; renderer match/render failures fall back to the generic normalized renderer; view/status failures degrade their own surface. A terminal-plugin exception must not abort an otherwise-valid Harness activity or be classified as an upstream runtime failure.

Plugin code may alter presentation/local navigation only; it must not silently alter Harness model routing, tool semantics, approval/sandbox policy, persistence or subagent scheduling.

Do not add arbitrary package discovery/loading. Third-party extension work requires a reviewed isolation/security design first.

## Local activity and session grouping

The transcript generates a local activity id around each `HarnessRuntime.run()` interval so repeated prompts in one Harness session remain distinct UI groups.

This is a presentation implementation detail, not an upstream id. Tests and diagnostics must not interpret it as protocol causality. Because `subscribeSessionTree()` can interleave root and descendant sessions, `activityId` alone is not a unique transcript identity: assistant/tool blocks also carry session identity, and multiple committed assistant steps inside one activity receive distinct local segments.

Root completion projection is scoped to the session explicitly submitted to `run()`. Descendant output remains observable but cannot overwrite root `finalResponse`, root activity or root turn-error state.

## Test strategy

Required CI remains credential-free.

### Unit tests

Cover pure logic including argument/command parsing, malformed slash input, doctor command parsing, transactional plugin registration/conflicts, renderer fallback on plugin exceptions, session selection, root/descendant normalized projection, same-session activity grouping, multiple assistant steps per activity, cross-session call-id collisions, truthful current-root agent topology, folding, retention arithmetic and terminal-control sanitization.

### Injected terminal-product integration

`tests/integration/product.fake.spec.ts` drives the real Ink product with TTY-like streams and the deterministic fake Harness runtime. It verifies:

- Ink raw-mode ownership and cleanup;
- alternate-screen entry/restore;
- two prompts using one Harness session;
- root/descendant assistant and tool output remains separately attributed;
- multiple visible assistant steps from one activity are retained;
- local Capability Explorer commands;
- command/view/status plugin callback failures stay inside presentation;
- resize handling;
- clean `/exit`;
- active-turn Ctrl+C returns 130, closes the whole runtime truthfully, and restores terminal state;
- no hidden reasoning leakage.

This test is part of normal `pnpm test`, so the Runtime matrix exercises it on Windows, macOS and Ubuntu instead of relying on Linux-only pseudo-terminal tooling. POSIX OS-signal injection remains separately covered where Node exposes those semantics.

### Fake-runtime subprocess integration

The deterministic JSON-RPC subprocess suite covers durable receipt ownership, pinned upstream event ordering, descendant-session traffic, unrelated-session filtering, line-mode interaction, `/new`, EOF, POSIX startup and active-turn SIGINT/SIGTERM, close-during-initialize ownership, receipt-to-idle timeout semantics, malformed response, transport loss, crash, redaction and bounded shutdown.

The doctor fake runtime is deliberately initialize-only. Doctor tests require successful paths to observe exactly `initialize` then `shutdown`, never `session/prompt`, and cover incompatible server/protocol identity, malformed initialize, missing workspace/config, runtime override labelling and credential-value non-leakage.

### Official-runtime smoke

The published Harness runtime is launched with the repository Cordis composition. Model-backed smokes route the DeepSeek adapter to a local deterministic HTTP stub, so required CI makes no paid provider call and needs no real key.

Required smoke paths:

1. one-shot: build `dist`, launch the actual `dist/cli/bin.js` -> initialize -> prompt -> events -> idle -> shutdown;
2. persistent line mode: one built `dshc --interactive` process -> two prompts on one named session -> expanded second provider history -> clean shutdown;
3. repository workflow: cwd -> Harness read/edit/search/platform-shell -> final response;
4. workspace sandbox: repository-local writes succeed while non-temp sibling writes and unavailable escalation fail closed;
5. doctor: built `dist/cli/bin.js doctor --json` -> initialize -> shutdown with `DEEPSEEK_API_KEY` removed and a deliberately unreachable provider URL, proving no model request occurs.

The TTY product itself is tested against the same `HarnessRuntime` contract through injected streams; official smokes validate the published upstream process boundary and built distribution entrypoint rather than the TypeScript source runner.

## Cross-platform rules

Windows is first-class. Do not assume `/bin/sh`, POSIX paths/quoting, Unix-only signals, identical ANSI behavior or POSIX Ctrl+C injection semantics.

Required matrix:

- Windows latest / Node 24 — blocking;
- macOS latest / Node 24 — blocking;
- Ubuntu latest / Node 24 — blocking;
- Ubuntu latest / Node 22.19.0 — blocking lower-bound coverage.

Every Runtime matrix job must build the Ink/React product before running tests. `pnpm test:official-runtime` also builds first so smoke commands are valid outside CI.

## Terminal security and reliability

Treat terminal-bound content as hostile. Model text, tool output, filenames, repository content, diagnostics and plugin error messages may contain active control sequences.

Release blockers include:

- escape/control/bidi injection, including machine-readable JSON printed to a terminal;
- provider credential leakage;
- hidden state-changing tool activity;
- UI behavior that weakens upstream approval/sandbox semantics;
- descendant session output silently impersonating root output;
- orphaned processes, including clients created by an interrupted startup after close has already been requested;
- alternate-screen state not restored after failure;
- unbounded practical output growth;
- arbitrary unisolated third-party plugin loading.

Large output may be folded with visible disclosure, never silently deleted. `dshc` should not own provider credentials; prefer upstream/environment mechanisms and scrub diagnostics.

See root `SECURITY.md`.

## Diagnostics

Debug/doctor output must never corrupt Harness stdout JSON-RPC. Useful scrubbed metadata includes dshc/upstream versions, runtime/config resolution, session ids, public event categories/counts, lifecycle transitions and process exit reason/code.

`dshc doctor` is the deterministic preflight surface. It reports PASS/WARN/FAIL/UNKNOWN findings for Node/workspace/runtime-config readiness, pinned DSH package versions, provider/model selection, DeepSeek credential presence, TTY/raw-mode facts, the public initialize handshake, server/protocol identity, shipped M4 coding/sandbox/approval defaults and dshc-local retention budgets.

Doctor safety invariants:

- never call `session/prompt`;
- never print environment dumps;
- credential checks report presence only — never value, length, prefix or derived fingerprint;
- use the effective child environment semantics already owned by `runtime-launcher`;
- runtime-config overrides are labelled as potentially different rather than inheriting shipped capability claims;
- hard configuration/compatibility/transport/runtime failures are nonzero; absent credentials, non-TTY execution and unknown non-shipped provider credential contracts are warnings/unknowns;
- every launched child is closed after initialize success or failure;
- human text is terminal-sanitized and JSON uses the terminal-safe serializer.

Do not log secrets or hidden reasoning. `/trace` is a normalized observable timeline, not a chain-of-thought viewer. `/agents` follows only publicly observed parent/child relationships reachable from the currently selected root; it does not relabel old-session descendants after `/new`.

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

`pnpm pack:check` enforces the public tarball allowlist. `pnpm test:package`
packs that candidate, installs it globally into an isolated prefix, runs the
installed `--version`, `--help` and initialize-only doctor paths, reinstalls it
as the supported repair/update operation, uninstalls it and verifies the
executable is gone. Required CI runs that installed-package gate on the complete
platform matrix. `pnpm audit:prod` queries the official npm audit endpoint and
blocks known high-severity production dependency advisories; the explicit
registry is intentional because some configured mirrors do not implement the
audit API.

Alpha tags invoke `.github/workflows/release.yml`. It builds one tarball, tests
that exact artifact on every blocking platform, stages subsequent npm versions
through OIDC for human 2FA approval, and creates a draft GitHub prerelease.
`.github/workflows/release-finalize.yml` makes the GitHub prerelease public only
after the exact npm version and `alpha` dist-tag are visible. The first package
version requires the documented interactive 2FA bootstrap because npm cannot
configure trusted or staged publishing for a package that does not yet exist.

Use GitHub Issues for live execution state; do not duplicate task checklists across more documents.
