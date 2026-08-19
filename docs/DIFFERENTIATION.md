# Product differentiation

`dshc` is not intended to be another general-purpose coding agent and it is not a skin over an existing CLI. Its product position is narrower and more defensible:

> **`dshc` is the terminal-native console for DeepSeek Harness.**

DeepSeek Harness owns the agent runtime: models, tools, sessions, plugins, subagents, persistence and the agent loop. `dshc` owns terminal interaction, event projection, observability and terminal-safe presentation.

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
4. **Protocol-truthful UX.** The client never claims stronger semantics than upstream provides. Today, for example, `session/prompt` is an enqueue receipt and there is no per-prompt cancel method.
5. **Thin frontend, replaceable UI.** Agent behavior stays upstream-owned; terminal rendering can evolve without moving the agent loop into this repository.
6. **Terminal observability as a product feature.** The user should be able to understand what the Harness is doing—current activity, tools, descendants, runtime state and failures—without reading raw JSON-RPC.
7. **Cross-platform terminal behavior from day one.** Windows is a blocking target rather than a later port.
8. **Provider/plugin leverage through Harness.** The project should benefit from the Harness provider/plugin model instead of hard-coding one model endpoint into the terminal frontend.

## What would make this project pointless

The project loses its reason to exist if it becomes only:

- a cosmetic copy of Codex/Claude Code;
- a raw DeepSeek API chat client;
- a second independent agent loop;
- a thin wrapper that prints the output of `dsh --profile headless`;
- a TUI that hides Harness-specific concepts instead of making them useful.

Every major feature should therefore answer at least one of these questions:

- Does it expose a real Harness capability more effectively in a terminal?
- Does it make Harness activity more observable or controllable?
- Does it improve terminal-native repository work without duplicating agent semantics?
- Is the behavior backed by a supported upstream contract?

See GitHub issue #15 for the ongoing product-direction guardrail.