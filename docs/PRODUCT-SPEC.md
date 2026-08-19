# Product specification

## Product statement

DeepSeek Harness Console (`dshc`) is an unofficial terminal-native interactive frontend for the official DeepSeek Harness runtime.

The product contract is:

> Harness owns agent semantics; `dshc` owns terminal interaction, projection and presentation.

## Primary user

A developer or technical user who already prefers shell/editor-terminal workflows and wants to use DeepSeek Harness interactively without moving into a browser UI or reducing Harness to a one-shot command.

## Primary jobs to be done

1. Start a Harness-backed coding/repository session from the current working directory.
2. Submit follow-up instructions without restarting the runtime.
3. See assistant streaming, tool activity, errors, session state and subagent activity in a readable terminal transcript.
4. Inspect runtime/session/model/workspace status without reading raw JSON-RPC.
5. Exit predictably without orphaning runtime processes.
6. Use the same conceptual Harness runtime from Windows, Linux and macOS terminals.

## Alpha success criteria

The alpha is successful if a new user can:

- install the package from documented instructions;
- start `dshc` in a repository;
- initialize a supported official Harness runtime;
- complete a multi-turn interaction;
- understand when tools/subagents are active;
- distinguish runtime/transport/model failures;
- exit cleanly;
- identify the exact supported Harness version when compatibility fails.

## Product principles

### 1. Protocol truth before convenience

Do not invent cancellation, prompt/result causality or state transitions that upstream does not provide.

### 2. Observability before decoration

A clear transcript, tool state, runtime state and error model matter more than a visually elaborate dashboard.

### 3. Thin frontend

No custom agent loop, model router, tool registry or authoritative chat-history database before alpha.

### 4. Terminal-native

The product must behave well as a command-line program: stdin/stdout/stderr discipline, exit codes, keyboard behavior, resize behavior, piping/non-interactive modes where appropriate, and clean process ownership.

### 5. Safe rendering

All model/tool/repository text is untrusted terminal content and must be sanitized before display.

### 6. Upstream-first compatibility

Prefer documented official SDK/runtime surfaces. Isolate compatibility work behind the upstream adapter.

## Product scope through alpha

In scope:

- runtime launch/connection through supported official interfaces;
- multi-turn terminal session;
- event-native transcript;
- tool/subagent/runtime state presentation;
- local slash commands;
- explicit session/workspace/model status;
- deterministic shutdown/error behavior;
- cross-platform CI;
- compatibility reporting;
- terminal safety and secret redaction.

Out of scope before alpha:

- replacing DSH's agent loop;
- arbitrary custom providers implemented by `dshc` itself;
- plugin marketplace;
- browser UI;
- remote daemon protocol not supported upstream;
- custom API-key vault;
- speculative prompt cancellation;
- reproducing every Harness Web feature;
- graphical dashboard for its own sake.

## Non-functional requirements

### Correctness

Event order is preserved. Committed assistant messages are not duplicated by streaming chunks. Unknown upstream events degrade explicitly rather than silently changing meaning.

### Reliability

The client owns its runtime subprocess deterministically. Startup, request and shutdown operations have bounded failure behavior. Orphaned child processes are release blockers.

### Security

Credentials are not logged by default. Terminal control sequences from untrusted content are neutralized. `dshc` must not silently weaken upstream sandbox/approval behavior.

### Performance

Streaming remains responsive under large tool output. Buffers are bounded. The TUI must not require retaining the entire raw session indefinitely just to render the current screen.

### Compatibility

Windows is first-class. The tested Node/package-manager range follows the pinned Harness baseline unless an ADR documents a deliberate difference.

## Metrics for development

Before public alpha, track engineering metrics rather than vanity usage metrics:

- M1/M2 smoke path pass rate by OS;
- number of known upstream compatibility breaks not caught at startup (target: zero);
- orphan-process failures (target: zero);
- terminal injection findings (target: zero open at release);
- fixture coverage of protocol methods/notifications;
- time from runtime start to usable first prompt under local test conditions;
- memory behavior on long synthetic event streams.

## Product guardrail

If a feature is mainly 'because Codex/Claude Code has it', that is not sufficient justification. It should solve a concrete terminal workflow problem or expose a real Harness capability.