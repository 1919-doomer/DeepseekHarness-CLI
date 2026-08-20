# DeepSeek Harness CLI

> An unofficial terminal-native console for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**Status: pre-alpha. M1 runtime integration, M2 persistent interaction, and M3 terminal product/first-party plugin plane are implemented and cross-platform validated. M4 reliability/security hardening is next. Not published to npm yet.**

[简体中文](README.zh-CN.md) · [Design](docs/DESIGN.md) · [Protocol](docs/PROTOCOL.md) · [Development](docs/DEVELOPMENT.md) · [Roadmap](docs/ROADMAP.md)

## The idea

DeepSeek Harness is a plugin-first agent runtime. `dshc` is its terminal control plane, not a second agent harness.

> **Harness owns agent semantics; `dshc` owns terminal interaction, projection, observability and presentation.**

`dshc` uses the official Harness SDK/runtime boundary and keeps models, tools, skills, approval, sandboxing, persistence, sessions, subagents and the agent loop upstream-owned.

## What works now

M3 turns the M2 persistent loop into a structured terminal product while preserving the same public Harness contract:

```text
TTY user
 -> Ink terminal product
 -> first-party terminal plugin host
 -> normalized transcript / views / status
 -> one persistent Harness runtime
 -> stable session across prompts
 -> receipt / ordered events / idle
 -> optional /new session
 -> clean terminal + runtime teardown
```

Current capabilities:

- Ink 7 + React 19 structured TTY product on the existing Node 22.19/24 baseline;
- persistent multi-turn conversation with one Harness runtime and stable active session;
- resize-aware transcript, prompt editor, history navigation and adaptive status line;
- `Enter` to submit, `↑/↓` for prompt history, `Ctrl+J` for a newline;
- `/help`, `/status`, `/session`, `/new`, `/clear`, `/plugins`, `/capabilities`, `/trace`, `/agents`, `/exit`;
- first-party terminal plugin API v1 with deterministic command, renderer, view and status registries;
- specialized tool/subagent presentation plus a safe generic event fallback;
- large tool/output folding with explicit disclosure instead of silent loss;
- Capability Explorer that reports verified runtime metadata and clearly marks unavailable runtime-plugin inventory;
- normalized trace and agent topology derived only from public observable events;
- terminal control/bidi sanitization, secret-redacted diagnostics and exception-safe alternate-screen cleanup;
- M1/M2 one-shot, piped stdin, JSON and scripted non-TTY `--interactive` modes retained.

## Source usage

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile

# Configure the normal DeepSeek Harness provider environment first.
# No positional prompt in a TTY => M3 terminal product.
pnpm dev
```

Inside the TTY product:

```text
/help          capability-aware command help
/status        runtime/model/workspace/session status
/session       active Harness session
/new           select a fresh session without restarting Harness
/clear         clear local presentation only
/plugins       Capability Explorer
/capabilities  alias of /plugins
/trace         normalized observable event timeline
/agents        root/subagent topology from public events
/exit          close the owned Harness runtime and exit
```

Use `//...` to send a literal model prompt beginning with `/`.

### One-shot and scripted compatibility

The non-TTY/plain paths remain intentionally independent of Ink:

```bash
pnpm dev -- "inspect this repository"
pnpm dev -- run "inspect this repository"
echo "summarize the project" | pnpm dev -- --json
printf "first prompt\nsecond prompt\n/exit\n" | pnpm dev -- --interactive
```

Useful options:

```text
-C, --workspace <path>
--provider <id>
--model <id>
--session <id>
--max-tokens <n>
--activity-timeout-ms <n>
--request-timeout-ms <n>
--runtime-config <path>
--interactive
--json
--debug
```

## Protocol truth

The validated baseline remains DeepSeek Harness `0.1.0-rc.8`, SDK server `deepseek-harness-sdk-runtime`, protocol `0.0.1`, Node `^22.19.0 || >=24`, pnpm `11.7.0`.

M3 adds no new wire method. The public protocol still has no per-prompt cancel, no per-session close, and no authoritative full runtime-plugin inventory. Therefore:

- `session/prompt` remains an enqueue receipt, not an exact assistant-result RPC;
- activity is observed from the matching durable receipt through root `idle`;
- `/new` changes only the locally selected session;
- Ctrl+C closes the whole owned runtime rather than pretending one prompt was cancelled;
- `/plugins` labels the Harness runtime plugin inventory partial/unavailable instead of guessing it;
- `/trace` never reconstructs or exposes hidden reasoning;
- M3 local `activityId` values group terminal blocks only and are not upstream message/turn/causal ids.

See [Protocol and upstream compatibility](docs/PROTOCOL.md).

## First-party terminal plugins

M3 formalizes the terminal plane after M1/M2 proved the required seams. Built-in commands, event renderers, views and status segments register through one deterministic `TerminalPluginHost`.

This is deliberately **not** a public arbitrary-package plugin ecosystem yet. Loading untrusted Node packages in-process would grant broad machine access; third-party loading remains deferred until M4/M6 security/isolation work can establish a real boundary.

## Validation

Required CI is credential-free and blocking on:

- Windows latest / Node 24;
- macOS latest / Node 24;
- Ubuntu latest / Node 24;
- Ubuntu latest / Node 22.19.0.

Every runtime job builds the Ink/React product. The normal test gate drives the actual Ink product using injected TTY-like streams, covering raw-mode ownership, two same-session turns, Capability Explorer, resize, alternate-screen restoration and clean exit. Existing fake-runtime lifecycle tests and official published-Harness one-shot/two-turn smokes remain in place; official model traffic is routed to a local deterministic stub.

## Architecture

```text
Terminal user
    │
    ▼
 dshc
 ├─ CLI mode routing
 ├─ Ink TTY product / plain fallback
 ├─ first-party terminal plugin host
 ├─ normalized transcript / trace / topology
 ├─ session selection / lifecycle
 └─ terminal security boundary
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

All upstream/version-specific behavior stays under `src/upstream/`.

## Next milestones

- **M4** — reliability, compatibility, security and long-session hardening;
- **M5** — public alpha;
- **M6** — safe community extension ecosystem and advanced capability views.

## License and affiliation

MIT licensed. This is an independent community project and is **not affiliated with, endorsed by, or maintained by DeepSeek AI**. “DeepSeek” and “DeepSeek Harness” are used only to describe interoperability with the upstream project.
