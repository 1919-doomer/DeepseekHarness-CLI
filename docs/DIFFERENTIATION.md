# Product differentiation

`dshc` is not intended to be another general-purpose coding agent and it is not a skin over an existing CLI. Its product position is narrower and more defensible:

> **`dshc` is the terminal-native console for DeepSeek Harness.**

DeepSeek Harness owns the agent runtime: models, tools, sessions, plugins, subagents, persistence and the agent loop. `dshc` owns terminal interaction, event projection, observability and terminal-safe presentation.

A second principle now makes the relationship explicit:

> **DSH: Everything is a Plugin.**
>
> **dshc: Everything You See Is a Plugin.**

This does not mean dshc creates a competing model/tool/agent plugin ecosystem. It means the terminal experience itself becomes composable: commands, renderers, views, status segments, diagnostics and capability adapters can evolve independently while the runtime remains upstream-owned.

## The gap we fill

DeepSeek Harness currently exposes several surfaces: a Web UI, a one-shot headless mode, ACP, and a stdio JSON-RPC SDK runtime. The headless path is useful for automation, but it is not a persistent interactive terminal product. The Web UI is interactive, but it is not terminal-native. The upstream project removed its earlier TUI and explicitly left terminal frontend concerns outside the current maintained product surface.

`dshc` fills that exact gap without forking the Harness core.

## How this differs from neighboring tools

### Versus DeepSeek Harness Web UI

The Web UI is a browser application. `dshc` is keyboard-first and repository-local: it should feel natural inside a shell, Windows Terminal, SSH session, editor terminal, tmux-like workflow, or automation pipeline. It must not be a browser page embedded in a terminal.

### Versus the official DSH headless CLI

Headless mode is one submitted task followed by a final result. `dshc` targets persistent multi-turn work: live events, sessions, tools, subagents, slash commands, status, and terminal lifecycle behavior.

### Versus Codex CLI or Claude Code

Codex CLI and Claude Code are complete agent products with their own agent semantics. `dshc` deliberately does not replace DeepSeek Harness semantics. It is a thin client over the official Harness runtime boundary.

This gives `dshc` a different architectural promise: when Harness gains a supported capability, the terminal should expose it rather than reimplement it. Conversely, `dshc` should not fake capabilities the Harness protocol does not expose.

### Versus Pi/OpenCode-style hackable harnesses

Those tools are themselves agent harnesses or extensible agent applications. `dshc` is a host/front-end for DSH. Its extensibility should come primarily from DeepSeek Harness plugins/providers and from terminal presentation extensions, not from duplicating a second tool/model/plugin ecosystem.

## Core differentiators

1. **DSH-native rather than DeepSeek-themed.** The integration boundary is the official Harness SDK/runtime, not a raw model API adapter.
2. **Event-native transcript.** The terminal is projected from durable Harness session events and runtime notifications instead of treating the final assistant string as the whole product.
3. **Harness concepts are first-class.** Sessions, tools, subagents, runtime state and future supported Harness capabilities should be visible rather than flattened into generic chat.
4. **Capability-driven UI.** The terminal should adapt to the active Harness composition: subagents, jobs, plan mode, custom tools and future capabilities can activate matching terminal views/renderers when supported metadata exists.
5. **Plugin-shaped terminal experience.** First-party commands, tool renderers, views, status segments and diagnostics should use common terminal plugin seams rather than accumulate as privileged one-off UI code.
6. **Protocol-truthful UX.** The client never claims stronger semantics than upstream provides. Today, for example, `session/prompt` is an enqueue receipt and there is no per-prompt cancel method.
7. **Thin frontend, replaceable UI.** Agent behavior stays upstream-owned; terminal rendering can evolve without moving the agent loop into this repository.
8. **Terminal observability as a product feature.** The user should be able to understand what the Harness is doing—current activity, tools, descendants, runtime state and failures—without reading raw JSON-RPC.
9. **Cross-platform terminal behavior from day one.** Windows is a blocking target rather than a later port.
10. **Provider/plugin leverage through Harness.** The project should benefit from the Harness provider/plugin model instead of hard-coding one model endpoint into the terminal frontend.

## A stronger long-term differentiator: the terminal mirrors the runtime

The ideal dshc is not a fixed chat client with a few extra panels. It is a terminal control plane whose surface reflects the Harness that is actually running.

Conceptually:

```text
DSH composition                  dshc surface
---------------                  ------------
subagents       ───────────────►  agent tree
jobs            ───────────────►  jobs monitor
plan mode       ───────────────►  plan view
custom tool     ───────────────►  matching tool renderer
session query   ───────────────►  session browser / trace
unknown plugin  ───────────────►  generic safe fallback
```

That is more defensible than merely recreating another coding-agent shell.

See [PLUGIN-ARCHITECTURE.md](PLUGIN-ARCHITECTURE.md) and [FEATURE-LAB.md](FEATURE-LAB.md).

## What would make this project pointless

The project loses its reason to exist if it becomes only:

- a cosmetic copy of Codex/Claude Code;
- a raw DeepSeek API chat client;
- a second independent agent loop;
- a thin wrapper that prints the output of `dsh --profile headless`;
- a TUI that hides Harness-specific concepts instead of making them useful;
- a second plugin ecosystem that duplicates DSH models/tools/skills instead of exposing them.

Every major feature should therefore answer at least one of these questions:

- Does it expose a real Harness capability more effectively in a terminal?
- Does it make Harness activity more observable or controllable?
- Does it improve terminal-native repository work without duplicating agent semantics?
- Is the behavior backed by a supported upstream contract?
- Can a custom Harness capability gain a useful terminal representation without editing core dshc code?

See GitHub issue #15 for the ongoing product-direction guardrail.