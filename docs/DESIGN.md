# Design

This document is the long-lived product and architecture contract for DeepSeek Harness Console (`dshc`).

> **DeepSeek Harness: Everything is a Plugin.**
>
> **dshc: Every terminal surface is pluggable.**

The central boundary is:

> **Harness owns agent semantics; `dshc` owns terminal interaction, projection, observability and presentation.**

## Product position

`dshc` is an unofficial terminal-native frontend for the official DeepSeek Harness runtime. It is not a second agent harness and not a raw DeepSeek API chat client.

The product is deliberately event-native and protocol-truthful:

- integration goes through the supported Harness SDK/runtime boundary;
- sessions, tools and subagents remain visible terminal concepts;
- the UI never invents cancellation, causal ids or capabilities absent from the wire;
- models, tools, skills, approvals, sandboxing, persistence, subagents and the agent loop remain upstream-owned;
- Windows is a blocking target rather than a later port.

## Process architecture

```text
Terminal process: dshc
  CLI mode selection
  persistent terminal product
  first-party terminal plugin host
  normalized transcript / trace / topology
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

The dependency direction is:

```text
terminal product / commands / plugins
                 ↓
       normalized projection
                 ↓
          upstream adapter
                 ↓
       official SDK / runtime
```

All Harness/version-specific adaptation stays behind `src/upstream/`. Terminal modules consume local normalized types and must not import private Harness implementation objects.

## Terminal modes

M3 has two presentation paths with the same runtime contract.

**TTY product mode** uses Ink 7 + React 19 for a structured transcript, prompt editor, views and adaptive status line.

**Plain mode** remains the required path for one-shot commands, piped stdin, JSON output, deterministic scripted `--interactive` use and fallback/non-TTY environments.

The Ink choice preserves the validated Node `^22.19.0 || >=24.0.0` Harness baseline. A TUI framework must not force an unrelated runtime upgrade merely for presentation.

## Runtime and session ownership

`dshc` owns one Harness subprocess per terminal process and starts, initializes and closes it deterministically.

Harness remains authoritative for durable sessions. M2/M3 reuse a stable session id across ordinary prompts; `/new` selects a fresh session without restarting the runtime. Because protocol `0.0.1` has no per-session close request, earlier sessions remain runtime-owned until shutdown.

`dshc` does not create a competing durable chat-history database.

## Event and transcript model

The transcript is a terminal projection, not the source of truth.

Durable-looking terminal blocks include committed assistant messages, tool call/result summaries, errors and subagent lifecycle summaries. Ephemeral state includes assistant deltas, running status and active tool/subagent presentation.

Rules:

- preserve observed notification order;
- streaming converges to the committed assistant message without duplication;
- multiple activities in one Harness session remain distinct in terminal scrollback;
- tool/subagent activity remains inspectable;
- unknown events degrade safely and remain diagnosable under debug mode;
- large output may be folded, never silently discarded;
- visual grouping must not claim unsupported protocol causality.

### Local activity ids

M3 creates a local `activityId` for each `HarnessRuntime.run()` interval so transcript blocks from repeated prompts in the same session do not overwrite one another.

`activityId` is **presentation-only**. It is not an upstream message id, turn id, request id or causal identifier and must never be exposed as one.

## First-party terminal plugin plane

M3 formalizes terminal extension seams only after M1/M2 proved the behavior they need to represent.

`TerminalPluginHost` API v1 supports deterministic registries for:

- local commands;
- event/tool renderers;
- views;
- status segments.

Registration rules are deterministic: duplicate plugin ids, commands, aliases or views fail loudly; renderer/status ordering is explicit by priority and registration order.

Built-in plugins currently provide the core commands/views and specialized tool/subagent rendering. A generic sanitized event fallback remains available when no specialized renderer matches.

This is a **first-party/internal plugin plane**. M3 does not load arbitrary third-party Node packages.

## Two plugin planes

### Harness runtime plugins

Harness decides what the agent can do: models, tools, skills, persistence, approval, sandbox, subagents, jobs, workflows and other runtime capabilities.

### dshc terminal plugins

`dshc` decides how supported capabilities are presented and interacted with in the terminal.

A terminal plugin may improve display or local navigation. It must not silently change model routing, tool semantics, approval policy, sandbox policy, persistence or subagent scheduling.

## Capability-driven UI

The product should expose verified capabilities rather than a static dashboard.

M3 `/plugins` (`/capabilities`) shows:

- verified runtime/server/protocol/provider/model/workspace metadata;
- active dshc terminal plugins and specialized renderers;
- local commands;
- explicit absence of prompt cancel and per-session close.

Protocol `0.0.1` does not expose an authoritative runtime plugin inventory, so M3 labels that information partial/unavailable rather than guessing.

A later optional DSH-side `dshc-bridge` may expose namespaced capability metadata, but base `dshc` must remain useful without it.

## Trace and agent topology

M3 `/trace` is a normalized user-visible event timeline. It may report event kinds, ids already public in the event stream, lengths and lifecycle transitions. It must not reconstruct or reveal hidden reasoning.

`/agents` derives root/descendant topology only from public normalized subagent events. Missing events produce an explicit partial view rather than inferred hidden state.

M4 may add filtering, duration analysis and stronger diagnostics without changing these truthfulness rules.

## Terminal UX invariants

- submitted prompts are enqueue operations, not guaranteed one-request/one-response RPCs;
- `/clear` clears local presentation only;
- `/new` changes the selected session only;
- `/exit` closes the owned runtime cleanly;
- Ctrl+C closes the whole runtime while upstream lacks prompt cancellation;
- non-TTY/one-shot behavior remains supported;
- narrow terminals preserve the newest useful activity rather than corrupting the input area;
- alternate-screen teardown must be exception-safe;
- correctness cannot depend on color or icon-only meaning;
- all untrusted model/tool/repository text is sanitized before terminal rendering.

## Third-party plugin security

Loading an untrusted Node package in-process effectively grants filesystem, environment, network and process access. A decorative permission manifest is not a security boundary.

A future public plugin SDK therefore requires a credible isolation model, likely separate-process/worker execution plus capability-based RPC, secret redaction, crash containment and API-version negotiation. Until then, the plugin host is first-party only.

## Architectural decisions

1. Use an out-of-process official Harness runtime.
2. Keep upstream adaptation separate from terminal rendering.
3. Keep `dshc` as the working binary name because upstream owns `dsh`.
4. GitHub Issues track executable work; long-lived contracts stay in the compact docs set.
5. Use Ink 7 + React 19 for the M3 TTY product while retaining the plain fallback.
6. Treat terminal rendering as a security boundary.
7. Keep the toolchain aligned with the pinned Harness baseline.
8. Preserve two plugin planes: Harness runtime plugins and dshc terminal plugins.
9. Keep the terminal plugin API first-party until isolation/permissions are credible.
10. Treat local activity ids as presentation grouping only.

## Non-negotiable invariants

1. `dshc` does not fork or replace the Harness agent loop.
2. Harness stdout is protocol-only when using stdio JSON-RPC.
3. Renderer/plugin code consumes normalized local types, not private Harness objects.
4. Upstream-specific code stays behind `src/upstream/`.
5. Protocol truth wins over UX convenience.
6. User-visible state-changing tool activity remains inspectable.
7. Terminal control-sequence sanitization is a release blocker.
8. Windows remains first-class and blocking.
9. Terminal plugins cannot silently weaken Harness security semantics.
10. Capabilities absent from the active runtime degrade explicitly rather than being faked.
