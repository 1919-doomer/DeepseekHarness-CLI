# Development roadmap

This roadmap is milestone-driven rather than date-driven. DeepSeek Harness is still in developer preview, so progress is gated by verified contracts and exit criteria, not calendar promises.

GitHub Issues are the live execution tracker. This document defines milestone intent and acceptance criteria.

## M0 — Contract and architecture lock

**Goal:** remove ambiguity before runtime code begins.

Deliverables:

- README and project boundaries;
- architecture document;
- protocol notes;
- upstream compatibility policy;
- development guide;
- GitHub issue-based work tracking;
- initial choice of package/binary naming strategy.

Exit criteria:

- public/private upstream boundaries are clearly separated;
- no document assumes prompt-level cancellation or strict prompt/result causality;
- runtime process model is agreed;
- first vertical-slice scope is fixed.

Status: **in progress**.

## M1 — Runtime vertical slice

**Goal:** prove the upstream boundary before building a TUI.

Deliverables:

- TypeScript project scaffold;
- package scripts and CI;
- pinned tested DeepSeek Harness SDK/runtime version;
- `src/upstream/` adapter;
- runtime launcher and Cordis configuration strategy;
- `initialize` handshake;
- one prompt submission;
- streamed session notifications;
- final committed assistant text projection;
- clean shutdown;
- basic diagnostics.

Required platforms:

- Windows;
- Ubuntu;
- macOS where CI/runtime support allows.

Exit criteria:

```text
clone -> install -> run smoke command
      -> runtime starts
      -> initialize succeeds
      -> prompt is queued
      -> events stream
      -> assistant output is rendered
      -> agent reaches idle
      -> child process exits cleanly
```

No full-screen TUI is required for M1.

## M2 — Interactive terminal loop

**Goal:** turn the vertical slice into a usable multi-turn CLI.

Deliverables:

- persistent prompt loop;
- session id ownership;
- streamed assistant output;
- tool call/result rendering;
- root vs descendant event distinction;
- local slash-command framework;
- `/help`, `/status`, `/session`, `/new`, `/clear`, `/exit`;
- robust EOF and Ctrl+C behavior;
- readable runtime failures.

Exit criteria:

- user can hold a multi-turn coding conversation without reopening the process;
- transcript remains correct under streaming/tool activity;
- no duplicated committed assistant output;
- Ctrl+C semantics are explicit and tested;
- non-interactive invocation remains possible.

## M3 — TUI product layer

**Goal:** deliver the Codex/Claude-Code-class terminal experience.

Deliverables:

- structured transcript renderer;
- input editor;
- persistent status line;
- tool blocks;
- subagent tree/activity view;
- terminal resize support;
- bounded output folding/expansion;
- model/session/workspace indicators;
- terminal escape-sequence sanitization;
- first-class Windows Terminal support.

Candidate commands:

- `/agents`;
- `/model` where supported safely;
- `/resume` where runtime persistence guarantees are verified;
- `/compact` only if backed by an explicit upstream capability;
- `/debug` for protocol/runtime diagnostics.

Exit criteria:

- stable rendering in common terminal widths;
- no protocol data written directly as UI noise;
- large tool output does not destroy responsiveness;
- hostile terminal control sequences are neutralized;
- Windows/POSIX behavior is intentionally tested.

## M4 — Safety, reliability and compatibility

**Goal:** make the tool dependable enough for daily repository work.

Deliverables:

- protocol fixture suite;
- real-runtime smoke suite;
- compatibility matrix;
- startup compatibility checks;
- structured debug logging with secret redaction;
- process-tree cleanup tests;
- memory/backpressure limits for long sessions;
- crash-recovery UX;
- approval-state rendering when upstream supports the required client-facing flow;
- security review of terminal rendering and subprocess surfaces.

Exit criteria:

- CI covers supported OS matrix;
- known protocol drift fails clearly;
- secrets are not logged by default;
- runtime crashes produce actionable errors;
- no known terminal escape injection issue remains.

## M5 — Public alpha

**Goal:** publish an installable community preview.

Deliverables:

- finalized package name and `dshc` binary;
- installation documentation;
- release workflow;
- changelog/release notes;
- compatibility table for the pinned upstream release;
- example screenshots/recording;
- contribution templates;
- issue templates;
- alpha tag/release.

Exit criteria:

- fresh install works from documented instructions;
- M1–M4 release blockers are closed;
- repository clearly states unofficial/community status;
- users can diagnose unsupported Harness versions;
- uninstall/update path is documented.

## M6 — Post-alpha capabilities

These are intentionally deferred until the core is reliable:

- richer session browser/resume flow;
- configurable themes;
- pluggable renderers;
- remote/external runtime connection if an upstream-supported transport exists;
- terminal-native approval prompts if the SDK gains server-to-client request semantics;
- graceful prompt cancellation when upstream exposes a cancel contract;
- richer subagent orchestration views;
- performance work for very long sessions;
- shell completion and package-manager distribution beyond npm.

## Explicit non-goals before alpha

Do not block the first alpha on:

- reproducing every Web UI feature;
- building a custom agent loop;
- custom model-provider implementations;
- plugin marketplace UX;
- graphical terminal dashboards;
- speculative features not represented by a stable upstream contract.

## Priority rule

When visual polish conflicts with protocol correctness, lifecycle correctness, security or cross-platform behavior, the latter wins.

The shortest path to a good product is not “build the TUI quickly”; it is “prove the runtime boundary once, then keep the UI thin.”
