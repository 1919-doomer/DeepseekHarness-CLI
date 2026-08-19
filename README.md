# DeepSeek Harness CLI

> An unofficial terminal-native console for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**Status: pre-alpha. M0 preparation is complete; M1 runtime implementation is ready to start. Not installable yet.**

[简体中文](README.zh-CN.md) · [Design](docs/DESIGN.md) · [Protocol](docs/PROTOCOL.md) · [Development](docs/DEVELOPMENT.md) · [Roadmap](docs/ROADMAP.md)

## The idea

DeepSeek Harness is a plugin-first agent runtime. `dshc` gives it a persistent, terminal-native interactive surface without forking or replacing the Harness core.

> **Harness owns agent semantics; `dshc` owns terminal interaction, observability and presentation.**

And the extension philosophy is deliberately parallel:

> **DSH: Everything is a Plugin.**  
> **dshc: Every terminal surface is pluggable.**

Harness plugins decide what the agent can do. `dshc` terminal plugins decide how supported capabilities are displayed and interacted with: commands, tool/event renderers, views, status segments, diagnostics and later safe community extensions.

## Why it is different

`dshc` is not a raw DeepSeek API chat wrapper and not another independent coding-agent harness.

- Compared with the DSH Web UI, it is shell/editor-terminal native.
- Compared with DSH headless mode, it is designed for persistent multi-turn work.
- Compared with Codex CLI or Claude Code, it keeps DeepSeek Harness as the underlying agent runtime instead of replacing its agent semantics.
- Compared with Pi/OpenCode-style harnesses, it does not build a second model/tool/plugin ecosystem; it exposes the one DSH already has.

The key product goals are **event-native execution visibility**, **Harness-native concepts**, **protocol-truthful UX**, and **capability-driven terminal UI**.

## Architecture

```text
Terminal user
    │
    ▼
 dshc
 ├─ input / commands
 ├─ normalized session projection
 ├─ terminal plugin host
 ├─ renderers / views / trace
 └─ lifecycle controller
    │
    │ stdio JSON-RPC
    ▼
 Official DeepSeek Harness runtime
 ├─ models
 ├─ tools / skills
 ├─ sessions / persistence
 ├─ approval / sandbox
 ├─ subagents / jobs / workflows
 └─ agent loop
```

The rule is simple: terminal code consumes normalized local state; all upstream/version-specific behavior stays behind `src/upstream/`.

## Planned terminal experience

```text
DeepSeek Harness Console                         V4-Pro
workspace  E:\project                     session  8b72…
──────────────────────────────────────────────────────

> inspect the failing tests and explain the root cause

● Exploring repository
  ├─ read package.json
  ├─ search src/
  └─ run pnpm test

● Running 2 subagents
  ├─ researcher       web search · 18s
  └─ tester           tests · 11s

● Found the failure
  ...

> /plugins
> /agents
> /trace
> /status
```

The UI is intended to adapt to active Harness capabilities rather than show a fixed dashboard. Unknown tools/events must still have a safe generic fallback.

## Current upstream constraints

The M1 baseline was reviewed against DeepSeek Harness `0.1.0-rc.8` on 2026-08-20.

The current public JSON-RPC surface includes `initialize`, `session/prompt`, `shutdown`, session event/status notifications and supported subagent notifications. It currently has no per-prompt cancel or per-session close method. `session/prompt` is an enqueue receipt, not a strict prompt-to-response RPC.

`dshc` treats these as real design constraints and will not fake stronger semantics.

See [Protocol and upstream compatibility](docs/PROTOCOL.md).

## Development plan

Development deliberately starts below the UI layer.

**M1 — Runtime vertical slice** ([#10](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/10)):

```text
launch runtime
 -> initialize
 -> enqueue prompt
 -> consume ordered events
 -> normalize/project
 -> plain safe renderer
 -> idle
 -> clean shutdown
 -> cross-platform CI
```

Then:

- M2: persistent interactive terminal loop;
- M3: polished terminal product + first-party plugin plane;
- M4: reliability/security/compatibility hardening;
- M5: public alpha;
- M6: safe community extension ecosystem and advanced capability views.

The first executable task is [#2](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/2).

## Plugin direction

High-value terminal capabilities include:

- Capability Explorer (`/plugins` / `/capabilities`);
- plugin-aware tool/event renderers;
- Session Debugger / `/trace`;
- live agent topology;
- jobs/plan views when those Harness capabilities exist;
- adaptive status/help/commands;
- `dshc doctor` compatibility diagnostics;
- optional future `dshc-bridge` Cordis plugin for richer capability metadata;
- third-party terminal plugins only after credible isolation/permission design.

See [Design](docs/DESIGN.md) and [Roadmap](docs/ROADMAP.md).

## Documentation

Long-lived docs are intentionally limited to four files:

- [Design](docs/DESIGN.md)
- [Protocol and compatibility](docs/PROTOCOL.md)
- [Development, testing and release policy](docs/DEVELOPMENT.md)
- [Roadmap and feature backlog](docs/ROADMAP.md)

Live work belongs in [GitHub Issues](https://github.com/1919-doomer/DeepseekHarness-CLI/issues), not duplicate status/checklist documents.

## Command name

The upstream project already owns `dsh`, so the working executable name is:

```sh
dshc
```

It means **DeepSeek Harness Console**. Package naming will be finalized before public alpha.

## License and affiliation

MIT licensed. This is an independent community project and is **not affiliated with, endorsed by, or maintained by DeepSeek AI**. “DeepSeek” and “DeepSeek Harness” are used only to describe interoperability with the upstream project.
