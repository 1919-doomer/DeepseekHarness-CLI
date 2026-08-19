# Development guide

This document describes how development should proceed once implementation begins.

## Repository rule

GitHub is the project's source of truth.

- architecture and protocol decisions live under `docs/`;
- work items live in GitHub Issues;
- implementation changes should reference the issue they advance;
- meaningful behavior changes update documentation in the same PR;
- `main` should remain buildable once M1 scaffolding lands.

## Planned stack

Initial implementation direction:

- TypeScript;
- Node.js version aligned with the pinned DeepSeek Harness release;
- official `@deepseek-ai/dsh-sdk-client` for runtime control;
- React/Ink or an equivalent terminal renderer only after the vertical protocol slice is proven;
- Vitest or Node's test runner for unit/contract tests;
- GitHub Actions on Ubuntu, macOS and Windows.

The TUI framework is not an architectural dependency. If Ink creates lifecycle, performance or Windows-terminal problems, the rendering layer may change without changing the upstream adapter or session projection model.

## Planned repository layout

```text
.
├─ src/
│  ├─ cli/
│  ├─ commands/
│  ├─ config/
│  ├─ lifecycle/
│  ├─ session/
│  ├─ tui/
│  └─ upstream/
├─ runtime/
│  └─ cordis.yml
├─ tests/
│  ├─ contract/
│  ├─ integration/
│  └─ unit/
├─ docs/
├─ .github/
│  └─ workflows/
├─ package.json
└─ tsconfig.json
```

## Development order

Do not start with the visual TUI.

The required order is:

1. project scaffold and CI;
2. runtime launcher;
3. JSON-RPC initialize;
4. single prompt and streamed event capture;
5. deterministic event normalization/projection;
6. lifecycle/shutdown tests;
7. interactive REPL;
8. full terminal renderer;
9. sessions/subagents/commands;
10. packaging and public alpha.

This order prevents a polished terminal shell from hiding an unstable runtime contract.

## Local development target

Once M1 lands, the expected workflow should converge toward:

```bash
npm install
npm run build
npm test
npm run dev
```

A later developer command may accept an explicit runtime path/config while upstream package resolution remains pre-release.

## Testing strategy

### Unit tests

Cover pure logic:

- slash-command parsing;
- event reducers;
- transcript projection;
- terminal control-sequence sanitization;
- config validation;
- compatibility-range checks.

### Protocol contract tests

Feed JSON-RPC fixtures into the adapter and assert normalized behavior.

### Runtime integration tests

Boot the pinned official Harness runtime and exercise initialize → prompt → events → idle → shutdown.

### Terminal behavior tests

After M2/M3:

- narrow and wide terminals;
- resize behavior;
- Ctrl+C semantics;
- input while agent is active;
- large tool output;
- malformed/untrusted ANSI escape sequences;
- Windows Terminal / ConPTY behavior;
- non-TTY stdout for one-shot commands.

## Code-quality gates

Before M1 exits, CI should enforce at least:

- typecheck;
- tests;
- formatting/linting;
- build;
- platform matrix smoke test where practical.

No release should depend on manual local-only validation.

## Security-sensitive areas

Treat these as engineering requirements:

- terminal escape injection;
- accidental credential logging;
- subprocess command/environment leakage;
- tool execution visibility;
- approval state presentation;
- runtime process-tree cleanup;
- unbounded transcript/tool-output memory growth.

A security-related bug that can execute terminal control sequences or leak credentials blocks release.

## Commit and PR guidance

Prefer small, issue-scoped changes.

Suggested commit prefixes:

```text
feat:
fix:
docs:
test:
refactor:
chore:
```

A feature PR should explain:

- which issue/milestone it advances;
- what upstream contract it relies on;
- what user-visible behavior changed;
- how it was tested;
- whether compatibility documentation needs an update.

## Architecture decision changes

If implementation reveals that a documented invariant is wrong, change the document deliberately instead of working around it silently.

For large decisions, add an ADR under `docs/adr/` with:

- context;
- decision;
- alternatives considered;
- consequences;
- date/status.

## Definition of done

A task is not done because code exists. It is done when:

- behavior is implemented;
- tests cover the relevant contract;
- docs are updated if behavior/architecture changed;
- cross-platform implications are considered;
- the linked GitHub Issue's exit criteria are satisfied.
