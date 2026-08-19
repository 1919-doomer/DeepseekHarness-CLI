# Development

GitHub is the project source of truth. Long-lived design lives in `docs/`; executable work and current status live in GitHub Issues; implementation changes should reference the smallest relevant Issue.

## M1 toolchain

Use the toolchain supported by the pinned DeepSeek Harness baseline unless an implementation problem justifies a documented change:

- TypeScript / ESM;
- Node `^22.19.0 || >=24.0.0` at the current upstream baseline;
- pnpm `11.7.0` at the current upstream baseline;
- official DeepSeek Harness SDK/runtime surfaces;
- no full-screen TUI framework during M1;
- tests based on Vitest or an equivalent deterministic Node test runner;
- GitHub Actions with Windows as a blocking target.

Exact dependencies must be locked. Avoid adding convenience packages unless they materially reduce complexity or cross-platform risk.

## Planned source layout

```text
src/
├─ cli/          # executable, args, one-shot commands
├─ commands/     # local/capability-aware command registry
├─ config/       # local config schema/load
├─ lifecycle/    # signals, shutdown, process ownership
├─ session/      # normalized events/projection/reducers
├─ terminal/     # plain renderer first; TUI/plugin host later
└─ upstream/     # all DSH SDK/runtime/version-specific adaptation

runtime/         # public Cordis composition if required
tests/           # unit, fixtures, fake-runtime, integration
docs/            # compact long-lived documentation
```

The dependency direction remains:

```text
terminal / commands / plugins
            ↓
    normalized projection
            ↓
      upstream adapter
            ↓
 official DSH SDK/runtime
```

## Implementation order

Do not start with visual TUI work.

1. scaffold TypeScript/ESM package and CI;
2. launch the official JSON-RPC runtime;
3. implement `initialize` and compatibility diagnostics;
4. submit one prompt and consume ordered notifications;
5. build normalized local event/projection types;
6. render through a plain safe terminal renderer;
7. implement bounded shutdown/process cleanup;
8. add deterministic fake-runtime/fixture tests;
9. establish cross-platform smoke gates;
10. only then build the persistent interactive loop;
11. extract stable terminal plugin seams from real behavior;
12. choose/full-screen TUI implementation in M3.

GitHub Issue #10 is the M1 master tracker; #2-#9 are its current executable tasks.

## Test strategy

Required CI must be credential-free.

### Unit tests

Pure logic such as config validation, command parsing, normalized reducers, compatibility checks, output folding and terminal-control sanitization.

### Protocol fixtures

Synthetic newline-delimited JSON-RPC sequences covering success, errors, malformed frames, ordering, unknown notifications, timeouts and transport loss.

### Fake-runtime integration

Launch a deterministic subprocess that behaves like the current protocol so lifecycle/process tests run offline on every PR.

### Official-runtime smoke

Use the pinned official Harness runtime to prove launch -> initialize -> events -> idle -> shutdown. Prefer a public deterministic/mock path where available. Live provider/API-key tests are optional trusted/manual workflows only.

### Terminal/product tests

From M2/M3 onward cover narrow/wide terminals, resize, Ctrl+C/EOF, large output, non-TTY output, Windows Terminal/ConPTY behavior, plugin fallback behavior and hostile control sequences.

## Security engineering

Treat the terminal boundary as hostile input. Model text, tool output, filenames, repository content and diagnostics may contain active control sequences.

Release blockers include:

- terminal escape/control injection;
- API keys or sensitive environment values in normal logs/support bundles;
- hidden or misleading state-changing tool activity;
- UI behavior that silently weakens upstream approval/sandbox semantics;
- orphaned runtime/child processes;
- unbounded output buffers causing practical denial of service;
- arbitrary third-party terminal plugin loading without a credible isolation model.

`dshc` should not own API credentials for alpha. Prefer environment/upstream credential mechanisms and scrub diagnostics.

Third-party plugins must not be described as sandboxed unless isolation is actually enforced. First-party/internal plugin seams can land earlier; community package loading is deferred.

See root `SECURITY.md` for reporting policy.

## Cross-platform rules

Windows is first-class from M1. Do not assume Unix-only signals, `/bin/sh`, POSIX paths/quoting or identical ANSI behavior.

Required CI direction:

- Windows latest — blocking;
- Ubuntu latest — blocking;
- macOS latest — blocking when the pinned upstream runtime supports the tested path.

Keep repository text LF-normalized through `.gitattributes`/`.editorconfig` to avoid cross-platform churn.

## Diagnostics

Debug output must never corrupt Harness stdout JSON-RPC. Useful scrubbed metadata includes:

- dshc/upstream version;
- runtime command/config path;
- method names/ids;
- session ids;
- event counts/types;
- lifecycle transitions;
- process exit reason/code.

Do not log raw model/tool/repository content by default.

A later `dshc doctor` should diagnose runtime resolution, Node/pnpm compatibility, Harness/SDK versions, protocol handshake, provider configuration presence, terminal capabilities and optional bridge/plugin compatibility without printing secrets.

## Pull requests and changes

Prefer small issue-scoped changes. A feature PR should state:

- Issue/milestone advanced;
- upstream contract relied on;
- user-visible behavior changed;
- tests run;
- compatibility/security implications;
- docs changed when design/protocol behavior changed.

Suggested commit prefixes: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Definition of done

A task is done when:

- acceptance criteria in its GitHub Issue are met;
- relevant tests pass;
- protocol/security/cross-platform implications are covered;
- long-lived docs are updated if the contract changed;
- no known blocker is being hidden by a renderer or compatibility shim.

## Release gates

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

Roadmap prose does not duplicate live task status: use GitHub Issues for that.
