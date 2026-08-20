# DeepSeek Harness CLI

> An unofficial terminal-native console for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**Status: pre-alpha. M1 runtime integration and M2 persistent terminal interaction are implemented and cross-platform validated. M3 terminal product work is next. Not published to npm yet.**

[简体中文](README.zh-CN.md) · [Design](docs/DESIGN.md) · [Protocol](docs/PROTOCOL.md) · [Development](docs/DEVELOPMENT.md) · [Roadmap](docs/ROADMAP.md)

## The idea

DeepSeek Harness is a plugin-first agent runtime. `dshc` is its terminal control plane, not a second agent harness.

> **Harness owns agent semantics; `dshc` owns terminal interaction, observability and presentation.**

`dshc` talks to the official Harness SDK/runtime, consumes structured session events, and keeps models, tools, skills, approval, sandboxing, sessions, subagents and the agent loop upstream-owned.

## What works now

M1 proved the supported runtime boundary. M2 keeps that same official runtime alive across multiple terminal turns:

```text
start dshc
 -> launch published dsh-jsonrpc-agent
 -> initialize once
 -> keep one active Harness session
 -> prompt / receipt / ordered events / idle
 -> prompt again on the same session
 -> optional /new session without runtime restart
 -> clean shutdown
```

Current capabilities:

- persistent multi-turn terminal loop in a TTY;
- one Harness runtime reused for the whole `dshc` process;
- stable active session across turns;
- `/new` selects a fresh session without restarting Harness;
- `/help`, `/status`, `/session`, `/new`, `/clear`, `/exit`;
- streaming assistant transcript plus tool/subagent activity;
- committed-output de-duplication even when tool activity breaks an assistant display line;
- safe fallback/debug handling for unknown events;
- terminal control/bidi sanitization and secret-redacted child diagnostics;
- explicit EOF and signal semantics;
- M1 one-shot, piped stdin and JSON modes retained.

## Source usage

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile

# Configure the normal DeepSeek Harness provider environment first.
# No positional prompt in a TTY => persistent interactive mode.
pnpm dev
```

Example interaction:

```text
DeepSeek Harness Console 0.0.0-dev · interactive M2
runtime deepseek-harness-sdk-runtime/0.0.1 · deepseek-v4-flash
session session-... · /help for commands

dshc[...]> inspect this repository
assistant> ...

dshc[...]> now explain the previous result
assistant> ...

dshc[...]> /status
status> runtime=ready ...

dshc[...]> /new
session> new session-...

dshc[...]> /exit
```

Interactive commands:

```text
/help       show commands
/status     runtime/model/workspace/session/turn status
/session    show the current Harness session id
/new        select a fresh Harness session without restarting the runtime
/clear      clear local terminal presentation only; Harness history is unchanged
/exit       close the Harness runtime and exit
```

Use `//...` to send a literal model prompt beginning with `/`.

### One-shot compatibility

M1-style execution remains available:

```bash
pnpm dev -- "inspect this repository"
pnpm dev -- run "inspect this repository"
echo "summarize the project" | pnpm dev -- --json
```

`--interactive` forces the persistent line-by-line loop even when stdin is piped, which is also useful for deterministic scripting/tests:

```bash
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

The public protocol still has no per-prompt cancel and no per-session close request. Therefore:

- `session/prompt` is treated as an enqueue receipt, not an exact assistant-result RPC;
- an active turn is observed from its matching durable receipt through root `idle`;
- `/new` changes the locally selected active session but does not close the previous upstream session;
- Ctrl+C during an active turn closes the owned Harness runtime; `dshc` does not claim that a single prompt was cancelled;
- EOF while idle, or after already-read work completes, exits cleanly.

See [Protocol and upstream compatibility](docs/PROTOCOL.md).

## Validation

Required CI is credential-free and blocks on:

- Windows latest / Node 24;
- macOS latest / Node 24;
- Ubuntu latest / Node 24;
- Ubuntu latest / Node 22.19.0.

The gate includes lint, strict typecheck, unit tests, fake-runtime subprocess tests, active-turn SIGINT coverage on POSIX, build, the M1 official-runtime one-shot smoke, and an actual two-turn `dshc --interactive` subprocess through the published Harness runtime using a local deterministic model stub.

## Architecture

```text
Terminal user
    │
    ▼
 dshc
 ├─ one-shot / interactive CLI
 ├─ local command layer
 ├─ session selection / lifecycle
 ├─ normalized event projection
 └─ safe scrollback renderer
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

All upstream/version-specific behavior stays under `src/upstream/`. M3 can now build a richer terminal product and first-party terminal plugin plane on top of seams proven by M1/M2 rather than guessing them in advance.

## Next milestones

- **M3** — polished terminal product + first-party terminal plugin plane, Capability Explorer, renderer registry and trace/debug views;
- **M4** — compatibility, security and reliability hardening;
- **M5** — public alpha;
- **M6** — safe community extension ecosystem and advanced capability views.

## License and affiliation

MIT licensed. This is an independent community project and is **not affiliated with, endorsed by, or maintained by DeepSeek AI**. “DeepSeek” and “DeepSeek Harness” are used only to describe interoperability with the upstream project.
