# Development

GitHub is the project source of truth. Long-lived design lives in `docs/`; executable work and current status live in GitHub Issues; implementation changes should reference the smallest relevant Issue.

## Validated toolchain

Use the toolchain supported by the pinned DeepSeek Harness baseline unless a documented compatibility problem requires a change:

- TypeScript / ESM;
- Node `^22.19.0 || >=24.0.0`;
- pnpm `11.7.0`;
- DeepSeek Harness `0.1.0-rc.8` public SDK/runtime surfaces;
- Vitest for deterministic unit/integration tests;
- GitHub Actions with Windows, macOS, and Ubuntu blocking the supported runtime path.

Exact dependencies are locked. M1/M2 deliberately use Node's built-in readline/stream/process primitives rather than adding a full-screen TUI dependency. Rich TUI framework selection remains an M3 decision.

## Source layout

```text
src/
├─ cli/          # executable, mode routing, one-shot + persistent loop
├─ commands/     # local/capability-aware commands
├─ config/       # local configuration
├─ lifecycle/    # signals, shutdown, process ownership
├─ session/      # session selection, normalized events/projection/reducers
├─ terminal/     # safe scrollback renderer; richer TUI later
└─ upstream/     # all DSH SDK/runtime/version-specific adaptation

runtime/         # public Cordis composition
tests/           # unit, fixtures, fake-runtime, official-runtime integration
docs/            # compact long-lived documentation
```

Dependency direction:

```text
terminal / commands / future plugins
                 ↓
       normalized session state
                 ↓
         upstream adapter
                 ↓
    official DSH SDK/runtime
```

## Milestone sequence

M1 proved the official runtime boundary. M2 proved persistent multi-turn terminal interaction on that boundary. The next implementation layer is M3: richer terminal presentation and first-party plugin seams extracted from behavior that now exists.

Do not move agent semantics into the terminal process and do not implement UI affordances for protocol capabilities that upstream does not expose.

## Current interaction invariants

- A TTY invocation with no one-shot prompt enters the persistent loop.
- Positional prompts, `run`, piped stdin, and `--json` preserve one-shot behavior.
- `--interactive` forces line-by-line persistent input for scripts/tests.
- One runtime is initialized once and reused across interactive turns.
- The active session id remains stable until `/new`.
- `/new` selects a fresh session id but cannot close the old upstream session under protocol `0.0.1`.
- Local slash commands are intercepted before the model boundary.
- Ctrl+C during an active turn closes the whole runtime; it is not prompt cancellation.
- EOF is a normal interactive exit boundary.

## Test strategy

Required CI must remain credential-free.

### Unit tests

Cover pure logic including argument/command parsing, session selection, normalized reducers, compatibility checks, output folding, and terminal-control sanitization.

### Fake-runtime integration

A deterministic newline-delimited JSON-RPC subprocess exercises lifecycle and protocol behavior without API credentials. M2 coverage includes:

- same-session reuse across multiple prompts;
- `/new` session rotation without runtime restart;
- local commands not reaching the model;
- tool/subagent transcript visibility;
- stream/commit de-duplication across interleaved activity;
- EOF behavior;
- active-turn POSIX SIGINT whole-runtime teardown;
- timeout, malformed response, transport loss, crash, redaction, and bounded shutdown.

### Official-runtime smoke

The published Harness runtime is launched with the repository Cordis composition. The DeepSeek adapter is routed to a local deterministic HTTP model stub so tests make no paid call and require no real key.

Required smoke paths now include:

1. M1 one-shot: launch -> initialize -> prompt -> events -> idle -> shutdown;
2. M2 interactive: one `dshc --interactive` process -> two prompts on one named session -> expanded second provider history -> exit -> clean shutdown.

### Terminal/product tests

M3 should add narrow/wide terminal, resize, folding, interactive editing, Windows Terminal/ConPTY, and richer presentation coverage. Do not claim Windows Ctrl+C injection semantics are identical to POSIX signals; test host-specific behavior honestly.

## Cross-platform rules

Windows is first-class. Do not assume `/bin/sh`, POSIX paths/quoting, Unix-only signals, or identical ANSI behavior.

Required matrix:

- Windows latest / Node 24 — blocking;
- macOS latest / Node 24 — blocking;
- Ubuntu latest / Node 24 — blocking;
- Ubuntu latest / Node 22.19.0 — blocking lower-bound coverage.

## Security engineering

Treat terminal-bound content as hostile. Model text, tool output, filenames, repository content, and diagnostics may contain active control sequences.

Release blockers include terminal escape/control injection, credential leakage, hidden state-changing tool activity, weakening of upstream approval/sandbox semantics, orphaned processes, unbounded practical output growth, or unsafe third-party plugin loading.

`dshc` should not own provider credentials. Prefer upstream/environment credential mechanisms and scrub diagnostics.

Third-party plugins must not be described as sandboxed unless isolation is actually enforced. Community package loading remains deferred beyond the first-party plugin plane.

See root `SECURITY.md`.

## Diagnostics

Debug output must never corrupt Harness stdout JSON-RPC. Useful scrubbed metadata includes dshc/upstream versions, runtime/config resolution, session ids, method/event counts, lifecycle transitions, and process exit reason/code. Do not log raw secrets or raw model/repository content by default.

A later `dshc doctor` should diagnose runtime resolution, Node/pnpm compatibility, Harness/SDK versions, protocol handshake, provider configuration presence, terminal capabilities, and optional bridge/plugin compatibility without printing secrets.

## Pull requests and definition of done

A feature PR should state the Issue/milestone advanced, upstream contract relied on, user-visible behavior, tests run, compatibility/security implications, and documentation changes.

A task is done when its Issue acceptance criteria are met, relevant tests pass, protocol/security/cross-platform implications are covered, long-lived docs match actual behavior, and no known blocker is hidden by a renderer or compatibility shim.

Suggested commit prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Public-alpha release gates

The first public alpha requires at minimum:

- fresh documented install/start path;
- M1-M4 blockers closed;
- pinned compatibility statement;
- Windows/Linux/macOS validation for supported paths;
- zero known terminal-injection or credential-leak blockers;
- deterministic child-process cleanup;
- required CI independent of secrets;
- unofficial/community status clear in package/repository docs;
- update/uninstall and diagnostics instructions.

Roadmap prose does not duplicate live task status; use GitHub Issues for execution state.
