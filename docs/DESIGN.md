# Design

This document is the long-lived product and architecture contract for DeepSeek Harness Console (`dshc`).

> **DeepSeek Harness: Everything is a Plugin.**
>
> **dshc: Every terminal surface is pluggable.**

The central boundary is:

> **Harness owns agent semantics; `dshc` owns terminal interaction, projection, observability and presentation.**

## Product position

`dshc` is an unofficial terminal-native interactive frontend for the official DeepSeek Harness runtime. It is not a second agent harness and not a raw DeepSeek API chat client.

It exists because the maintained upstream surfaces currently include a Web UI, ACP, a stdio JSON-RPC SDK runtime and one-shot headless execution, but no maintained persistent interactive terminal frontend.

The primary user is a developer who wants to work from a shell/editor terminal, keep a Harness session alive across multiple prompts, and understand tools, sessions, subagents and runtime activity without reading raw JSON-RPC.

### What makes it different

- **DSH-native:** integration is through the official Harness SDK/runtime boundary, not a model API wrapper.
- **Event-native:** terminal state is projected from Harness session/runtime events rather than only final assistant text.
- **Harness concepts stay visible:** sessions, tools, subagents, jobs and runtime state are first-class UI concepts when supported.
- **Protocol-truthful:** the UI never claims cancellation, prompt/result causality or capabilities that the wire does not provide.
- **Observability-first:** a user should be able to understand what the Harness is doing without opening a browser or inspecting protocol frames.
- **Thin frontend:** models, tools, skills, approvals, sandboxing, persistence, subagents and the agent loop remain upstream-owned.
- **Cross-platform from the start:** Windows is a blocking target, not a later port.

The project becomes pointless if it degrades into a cosmetic Codex/Claude-Code clone, a wrapper around `dsh --profile headless`, or a second independent agent ecosystem.

## Scope

Through public alpha, `dshc` should provide:

- runtime launch/connection through supported public Harness interfaces;
- persistent multi-turn terminal interaction;
- event-native transcript and streaming;
- readable tool/subagent/runtime state;
- local terminal commands and capability-aware help;
- deterministic shutdown and actionable failures;
- compatibility diagnostics;
- terminal control-sequence sanitization and secret-safe diagnostics;
- Windows, Linux and macOS support where the pinned upstream runtime supports them.

Before alpha it should not build:

- a replacement agent loop or tool/model/provider system;
- an authoritative parallel chat-history database;
- a custom API-key vault;
- an unsupported remote daemon protocol;
- speculative prompt cancellation;
- a plugin marketplace;
- a browser UI.

## Process architecture

The default architecture uses two processes:

```text
Terminal process: dshc
  input / commands
  normalized session projection
  terminal plugin host
  renderers / views / diagnostics
  lifecycle controller
          │
          │ stdio JSON-RPC
          ▼
Harness process: official DSH runtime
  agent loop
  models
  tools / approvals / sandbox
  sessions / persistence
  subagents / jobs / workflows
```

Why:

1. it follows the public upstream SDK boundary;
2. upstream-specific churn is isolated behind `src/upstream/`;
3. Harness stdout remains protocol-only;
4. runtime crashes and teardown are separated from terminal rendering;
5. the terminal can be replaced without moving agent behavior out of Harness.

The dependency direction is:

```text
terminal UI / commands / plugins
            ↓
normalized session projection
            ↓
      upstream adapter
            ↓
 official SDK / runtime
```

Terminal modules must not import private Harness implementation objects.

## Runtime and local state

`dshc` owns its runtime subprocess and must start, initialize and stop it deterministically. Version/package/config details belong only in `src/upstream/`.

Harness remains authoritative for durable sessions. `dshc` may store small UI preferences or recently used session ids, but it must not create a competing session history store. API credentials remain outside `dshc` unless a future credential design is explicitly reviewed.

## Event and transcript model

The transcript is a projection, not the source of truth.

Two state classes are required:

**Durable:** user messages, committed assistant messages, tool calls/results, errors and subagent lifecycle summaries.

**Ephemeral:** assistant streaming chunks, elapsed time, activity text, active tools/subagents and temporary status.

Rules:

- preserve meaningful upstream order;
- streaming chunks converge to committed assistant output without duplication;
- root and descendant session activity remain distinguishable;
- unknown events degrade safely and remain diagnosable;
- `session.status` drives whole-agent running/idle state where available;
- visual grouping must not invent unsupported causal relationships.

Minimum local lifecycle:

```text
starting -> initializing -> idle -> running -> idle -> shutting-down -> closed
```

Failures should distinguish configuration, transport, protocol, runtime and observable model/tool failures when the upstream contract permits it.

## Terminal UX invariants

- submitted prompts are enqueue operations, not guaranteed one-request/one-response RPCs;
- `/clear` clears local presentation only, never upstream history silently;
- state-changing tool activity remains inspectable;
- large output may be folded, not silently lost;
- correctness cannot depend on color or icon-only meaning;
- non-TTY/one-shot output remains possible;
- Ctrl+C must not claim prompt cancellation while upstream has no prompt-cancel contract;
- destructive runtime termination is explicit;
- untrusted model/tool/repository text is sanitized before reaching the terminal.

## Two plugin planes

### Runtime plugin plane — DeepSeek Harness

Harness already treats major capabilities as composable seams: models, tools, skills, sessions, persistence, approval, sandbox, subagents, jobs, workflows, web, LSP, commands, projections, storage and more.

`dshc` must reuse those capabilities rather than reimplement them.

### Terminal plugin plane — dshc

`dshc` makes terminal experience composable. Stable seams should emerge from real M1/M2 behavior, then be formalized in M3.

Candidate terminal plugin registries:

- commands;
- tool renderers;
- event renderers;
- views/panels;
- status-line segments;
- key bindings;
- notifications;
- exporters and diagnostics;
- capability-aware UI adapters.

A dshc plugin may change how a Harness capability is displayed or interacted with. It must not change model routing, tool semantics, approval policy, sandbox policy or subagent scheduling behind the user's back.

## Capability-driven UI

The long-term UI should be a function of the active Harness composition rather than a fixed dashboard.

Examples:

- subagents available -> agent tree becomes available;
- jobs available -> `/jobs` and a jobs status segment can appear;
- plan mode available -> plan view can appear;
- custom tool available -> matching renderer can improve presentation;
- unknown capability -> generic safe fallback remains usable.

A future Capability Explorer (`/plugins` or `/capabilities`) should show what the active runtime exposes and which terminal adapters are active, but only from public/verified metadata.

## Optional `dshc-bridge`

If the base SDK does not expose enough capability metadata, a later optional Cordis plugin may run inside Harness and expose namespaced, versioned, read-mostly metadata for the terminal.

Possible uses:

- capability/plugin manifest;
- feature negotiation;
- human-command metadata;
- session/query metadata;
- plugin-owned display hints.

The bridge must remain optional. Base `dshc` must work without it, and it must not weaken approval/sandbox/security policy or require a Harness fork.

## Third-party plugin security

First-party terminal plugin seams may ship before arbitrary third-party package loading.

Loading an untrusted Node package in-process effectively grants filesystem, environment, network and process access. A decorative permission manifest is not a security boundary.

A public community plugin SDK therefore requires a credible isolation design, likely involving a separate process/worker plus capability-based RPC, secret redaction, crash containment and API-version negotiation.

## First-party feature direction

High-value features that fit the design:

- Capability Explorer and plugin-aware help;
- plugin-aware tool/event rendering with safe fallback;
- Session Debugger / trace timeline;
- live agent topology/subagent tree;
- background jobs monitor when supported;
- adaptive status line;
- change review/diff view backed by repository/tool evidence;
- session browser using Harness persistence/query capabilities;
- `dshc doctor` compatibility diagnostics;
- export/support bundles with secret redaction;
- terminal profiles such as minimal/coding/research/observer that alter presentation, not Harness permissions.

## Architectural decisions

The following decisions are considered part of this document rather than maintained as separate ADR files during pre-alpha:

1. use an out-of-process official Harness runtime;
2. keep terminal rendering separate from upstream adaptation;
3. use `dshc` as the working binary name because upstream owns `dsh`;
4. GitHub is the project source of truth; Issues track executable work;
5. defer full-screen TUI framework choice until runtime and interaction semantics are proven;
6. treat terminal rendering as a security boundary;
7. align M1 toolchain with the pinned upstream Harness baseline;
8. preserve two plugin planes: Harness runtime plugins and dshc terminal plugins.

Any future reversal that materially affects multiple modules should update this document in the same PR and explain the reason in the linked GitHub Issue/PR.

## Non-negotiable invariants

1. `dshc` does not fork or replace the Harness agent loop.
2. Harness stdout is protocol-only when using stdio JSON-RPC.
3. renderer/plugin code consumes normalized local types, not private Harness objects.
4. upstream-specific code stays behind `src/upstream/`.
5. protocol truth wins over UX convenience.
6. user-visible state-changing tool activity remains inspectable.
7. terminal control-sequence sanitization is a release blocker.
8. Windows remains a first-class target.
9. terminal plugins cannot silently weaken Harness security semantics.
10. capabilities absent from the active runtime degrade explicitly rather than being faked.
