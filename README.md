# DeepSeek Harness CLI

> An unofficial terminal-native console for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**Status: pre-alpha. M1 runtime vertical slice is implemented and cross-platform validated. M2 persistent interaction is next. Not published to npm yet.**

[简体中文](README.zh-CN.md) · [Design](docs/DESIGN.md) · [Protocol](docs/PROTOCOL.md) · [Development](docs/DEVELOPMENT.md) · [Roadmap](docs/ROADMAP.md)

## The idea

DeepSeek Harness is a plugin-first agent runtime. `dshc` is its terminal control plane, not a second agent harness.

> **Harness owns agent semantics; `dshc` owns terminal interaction, observability and presentation.**

The extension philosophy follows the same split:

> **DSH: Everything is a Plugin.**  
> **dshc: Every terminal surface is pluggable.**

DSH plugins decide what the agent can do. Future `dshc` terminal plugins decide how supported capabilities are displayed and interacted with: commands, tool/event renderers, views, status segments and diagnostics.

## What makes it different

- **DSH-native** — talks to the official Harness SDK/runtime instead of wrapping the raw model API.
- **Event-native** — projects Harness session/runtime notifications rather than reducing execution to `prompt -> text`.
- **Protocol-truthful** — does not fake prompt cancellation or strict prompt/response causality that upstream does not provide.
- **Observable** — tools, descendants, runtime state, failures and unknown event vocabulary are terminal-facing concepts.
- **Capability-driven direction** — later UI surfaces should appear because the active Harness composition supports them, not because a static dashboard lists everything.
- **Thin frontend** — models, tools, skills, approval, sandboxing, sessions, subagents and the agent loop remain upstream-owned.

## M1 is complete

M1 proves the entire public runtime boundary before any full-screen TUI work:

```text
launch published dsh-jsonrpc-agent
 -> initialize
 -> enqueue one prompt
 -> observe matching durable receipt
 -> consume ordered session-tree notifications
 -> normalize/project events
 -> render safe plain terminal output
 -> root session idle
 -> bounded clean shutdown
```

Implemented M1 pieces include:

- TypeScript/ESM package and `dshc` executable;
- exact `0.1.0-rc.8` DeepSeek Harness dependency baseline + committed lockfile;
- public `dsh-jsonrpc-agent` launcher and external `runtime/cordis.yml` composition;
- startup/runtime protocol identity checks;
- receipt-to-idle activity collection matching official SDK semantics;
- normalized assistant/tool/subagent/error projection;
- streaming/committed assistant de-duplication;
- terminal control-sequence and bidi-control neutralization;
- explicit timeout/SIGINT/SIGTERM behavior without fake prompt cancellation;
- secret-redacted child-process diagnostics;
- deterministic fake-runtime contract/lifecycle tests;
- credential-free official Harness runtime smoke tests;
- GitHub Actions gates on Windows, macOS and Ubuntu, including Node 22.19 and Node 24.

See [Protocol](docs/PROTOCOL.md) and M1 tracking issue [#10](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/10).

## Current source usage

M1 is intentionally one-shot. Persistent multi-turn interaction belongs to M2.

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile

# configure the normal DeepSeek Harness provider environment first
pnpm dev -- "inspect this repository and summarize the architecture"
```

Useful M1 options:

```text
-C, --workspace <path>
--provider <id>
--model <id>
--session <id>
--max-tokens <n>
--activity-timeout-ms <n>
--request-timeout-ms <n>
--runtime-config <path>
--json
--debug
```

Stdin is also supported for non-TTY one-shot use:

```bash
echo "summarize the project" | pnpm dev -- --json
```

## Architecture

```text
Terminal user
    │
    ▼
 dshc
 ├─ CLI / lifecycle
 ├─ normalized session projection
 ├─ safe plain renderer          (M1)
 └─ terminal plugin plane        (formalized later)
    │
    │ stdio JSON-RPC
    ▼
 Official DeepSeek Harness runtime
 ├─ models / tools / skills
 ├─ sessions / persistence
 ├─ approval / sandbox
 ├─ subagents / jobs / workflows
 └─ agent loop
```

All upstream/version-specific behavior stays under `src/upstream/`. Terminal code consumes local normalized events, not private Harness implementation objects.

## Current upstream constraints

The validated M1 baseline is DeepSeek Harness `0.1.0-rc.8` with SDK server protocol `0.0.1`.

The public wire currently exposes `initialize`, `session/prompt`, `shutdown`, session event/status notifications and supported subagent notifications. There is no per-prompt cancel or per-session close request, and `session/prompt` is an enqueue receipt rather than an exact assistant-response RPC.

`dshc` treats those as product constraints instead of hiding them. See [Protocol](docs/PROTOCOL.md).

## Next milestones

- **M2** — persistent multi-turn terminal loop and local commands;
- **M3** — polished terminal product + first-party terminal plugin plane, Capability Explorer, renderer registry and trace/debug views;
- **M4** — compatibility, security and reliability hardening;
- **M5** — public alpha;
- **M6** — safe community extension ecosystem and advanced capability views.

High-value later features include `/plugins` / Capability Explorer, plugin-aware tool renderers, `/trace`, live agent topology, adaptive status/help, `dshc doctor`, and an optional DSH-side `dshc-bridge` for richer supported capability metadata.

## Documentation

Long-lived technical docs are intentionally limited to:

- [Design](docs/DESIGN.md)
- [Protocol and compatibility](docs/PROTOCOL.md)
- [Development, testing and release policy](docs/DEVELOPMENT.md)
- [Roadmap and feature backlog](docs/ROADMAP.md)

Live execution state belongs in [GitHub Issues](https://github.com/1919-doomer/DeepseekHarness-CLI/issues).

## License and affiliation

MIT licensed. This is an independent community project and is **not affiliated with, endorsed by, or maintained by DeepSeek AI**. “DeepSeek” and “DeepSeek Harness” are used only to describe interoperability with the upstream project.
