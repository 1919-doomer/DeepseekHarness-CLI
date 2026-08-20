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

runtime/         # public Cordis composition / compatibility composition when required
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
- Local slash commands are intercepted before the model boundary; malformed local commands remain local errors.
- `//text` sends a literal slash-prefixed prompt.
- Ctrl+C closes the whole owned runtime while upstream lacks prompt cancellation.
- SIGINT/SIGTERM ownership begins before runtime startup. A close request during workspace/version/launch/initialize work is terminal: startup must not later publish a live client or successful metadata, and repeated close calls remain idempotent.

## First-run product contract

The default product path follows the design rule **Simple by default, Harness-native underneath**.

For a normal user, the intended flow is approximately:

```text
configure a supported provider
cd <repository>
dshc
```

The current directory is the natural default workspace unless explicitly overridden. A first useful repository task must not require the user to hand-edit Cordis configuration or manually assemble a runtime tool tree.

This convenience is a frontend/composition concern, not permission to duplicate Harness semantics. Filesystem/search, shell, skills, sandbox/approval, persistence, jobs, subagents and the agent loop remain DSH-owned.

When the pinned DSH baseline offers a supported profile/bundle/composition mechanism for the required repository capabilities, prefer it over maintaining a parallel `dshc` inventory. If `runtime/` contains a compatibility composition, document why it is necessary, keep it minimal and replaceable, and cover it with upstream-drift/official-runtime tests.

Advanced runtime/profile/configuration overrides are progressive disclosure. Missing capabilities must fail visibly and truthfully rather than being silently reimplemented by terminal code.

## M3 terminal plugin discipline

The terminal plugin API is versioned and first-party only.

Current registries:

- commands;
- event/tool renderers;
- views;
- status segments.

Registration is transactional. Command/alias, view, renderer-id and status-id conflicts are rejected before any part of an incoming plugin mutates the host. Specialized renderers must have a safe generic fallback.

Plugin callbacks are presentation boundaries. Command failures stay local; renderer match/render failures fall back to the generic normalized renderer; view/status failures degrade their own surface. A terminal-plugin exception must not abort an otherwise-valid Harness activity or be classified as an upstream runtime failure.

Plugin code may alter presentation/local navigation only; it must not silently alter Harness model routing, tool semantics, approval/sandbox policy, persistence or subagent scheduling.

Do not add arbitrary package discovery/loading in M3. Third-party extension work requires a reviewed isolation/security design first.

## Local activity and session grouping

The M3 transcript generates a local activity id around each `HarnessRuntime.run()` interval so repeated prompts in one Harness session remain distinct UI groups.

This is a presentation implementation detail, not an upstream id. Tests and diagnostics must not interpret it as protocol causality. Because `subscribeSessionTree()` can interleave root and descendant sessions, `activityId` alone is not a unique transcript identity: assistant/tool blocks also carry session identity, and multiple committed assistant steps inside one activity receive distinct local segments.

Root completion projection is scoped to the session explicitly submitted to `run()`. Descendant output remains observable but cannot overwrite root `finalResponse`, root activity or root turn-error state.

## Test strategy

Required CI remains credential-free where deterministic stubs can cover the contract.

### Unit tests

Cover pure logic including argument/command parsing, malformed slash input, transactional plugin registration/conflicts, renderer fallback on plugin exceptions, session selection, root/descendant normalized projection, same-session activity grouping, multiple assistant steps per activity, cross-session call-id collisions, truthful current-root agent topology, folding and terminal-control sanitization.

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

The deterministic JSON-RPC subprocess suite covers durable receipt ownership, pinned upstream event ordering, descendant-session traffic, unrelated-session filtering, M2 line-mode interaction, `/new`, EOF, POSIX startup and active-turn SIGINT/SIGTERM, close-during-initialize ownership, receipt-to-idle timeout semantics, malformed response, transport loss, crash, redaction and bounded shutdown.

The fake runtime should model the pinned Harness ordering closely enough to catch frontend projection mistakes. In particular, an assembled `assistant/message` precedes tool execution for that step; later steps may produce additional assistant commits in the same run interval. Lifecycle fixtures may deliberately delay initialize so tests can prove that close cannot race startup into resurrecting an owned child.

### Official-runtime smoke

The published Harness runtime is launched through the supported composition boundary selected by the current milestone. The DeepSeek adapter may be routed to a local deterministic HTTP model stub so required CI makes no paid provider call and needs no real key.

Required smoke paths include:

1. one-shot: build `dist`, launch the actual `dist/cli/bin.js` -> initialize -> prompt -> events -> idle -> shutdown;
2. persistent line mode: one built `dshc --interactive` process -> two prompts on one named session -> expanded second provider history -> clean shutdown;
3. once M4 adopts the daily-use composition, a repository-capability smoke proving the active DSH runtime—not duplicated terminal code—owns representative workspace/tool execution used by the supported default path.

The Ink product itself may still use injected TTY streams for deterministic rendering tests, while the official-runtime smokes validate the published upstream process/composition boundary and built distribution entrypoint.

### First-run E2E before public alpha

M5 requires a fresh-environment path on supported platforms that resembles:

```text
install dshc
configure provider
cd <real-repository>
dshc
 -> inspect repository
 -> perform a safe code change
 -> run relevant tests
 -> exit cleanly
```

This is a release gate, not a README-only example. It must demonstrate that the default runtime exposes the intended DSH-backed repository capabilities without hand-editing composition and that all observed state-changing activity remains inspectable in the terminal.

## Cross-platform rules

Windows is first-class. Do not assume `/bin/sh`, POSIX paths/quoting, Unix-only signals, identical ANSI behavior or POSIX Ctrl+C injection semantics.

Required matrix:

- Windows latest / Node 24 — blocking;
- macOS latest / Node 24 — blocking;
- Ubuntu latest / Node 24 — blocking;
- Ubuntu latest / Node 22.19.0 — blocking lower-bound coverage.

Every Runtime matrix job must build the Ink/React product before running tests. Official-runtime tests also build first so smoke commands are valid outside CI.

Platform-specific shell behavior belongs to the active DSH runtime/composition. `dshc` must not turn Windows support into a separate terminal-owned shell implementation.

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
- arbitrary unisolated third-party plugin loading;
- onboarding shortcuts that bypass or duplicate upstream security/tool semantics.

Large output may be folded with visible disclosure, never silently deleted. `dshc` should not own provider credentials; prefer upstream/environment mechanisms and scrub diagnostics.

See root `SECURITY.md`.

## Diagnostics

Debug output must never corrupt Harness stdout JSON-RPC. Useful scrubbed metadata includes dshc/upstream versions, runtime/config resolution, session ids, public event categories/counts, lifecycle transitions and process exit reason/code.

Do not log secrets or hidden reasoning. `/trace` is a normalized observable timeline, not a chain-of-thought viewer. `/agents` follows only publicly observed parent/child relationships reachable from the currently selected root; it does not relabel old-session descendants after `/new`.

A later `dshc doctor` should diagnose runtime resolution, Node/pnpm compatibility, Harness/SDK versions, protocol handshake, provider configuration presence, terminal capabilities and optional bridge/profile compatibility without printing secrets.

For M4+, diagnostics should also make it clear which supported runtime/profile/composition path is active and whether expected repository capabilities are actually available. It must not invent an authoritative plugin inventory when the public protocol does not expose one.

## Pull requests and definition of done

A feature PR should state the Issue/milestone advanced, upstream contract relied on, user-visible behavior, tests run, compatibility/security implications and documentation changes.

A task is done when its Issue acceptance criteria are met, required tests pass, protocol/security/cross-platform implications are covered, long-lived docs match actual behavior and no known blocker is hidden by a renderer or compatibility shim.

For changes to runtime composition or default capabilities, the PR must additionally state whether the behavior is upstream-owned, what public DSH contract is relied on, how upstream drift is detected, and why the change does not create a second Harness inside `dshc`.

Suggested commit prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Public-alpha release gates

The first public alpha requires at minimum:

- fresh documented install/start path;
- M1-M4 blockers closed;
- pinned compatibility statement;
- Windows/Linux/macOS validation for supported paths;
- zero known terminal-injection or credential-leak blockers;
- deterministic child-process and terminal-state cleanup;
- required CI independent of secrets where deterministic stubs are sufficient;
- unofficial/community status clear in package/repository docs;
- update/uninstall and diagnostics instructions;
- a verified `cd repo && dshc` first-run path that does not require manual Cordis composition;
- an end-to-end real-repository task showing DSH-owned workspace/tool execution and truthful `dshc` observation;
- no duplication of Harness filesystem, shell, skill, sandbox/approval, persistence, jobs, subagent or agent-loop semantics for onboarding convenience.

Use GitHub Issues for live execution state; do not duplicate task checklists across more documents.
