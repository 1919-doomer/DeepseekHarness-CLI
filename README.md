# DeepSeek Harness CLI

> An unofficial terminal-native console for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**Status: pre-alpha. M1-M4 are complete.** The Harness-native coding baseline, zero-config repository workflow, workspace sandboxing, terminal-security gates, bounded long-session retention, `dshc doctor`, the queryable session trace debugger and the pre-alpha security gate are all in. The M4 acceptance task — inspect a repository, make a change, run its tests — has been executed end to end against the live runtime. Pinned to DeepSeek Harness `0.1.1-rc.1`. **M5, the first installable public alpha, is next; not published to npm yet.**

[简体中文](README.zh-CN.md) · [Design](docs/DESIGN.md) · [Protocol](docs/PROTOCOL.md) · [Development](docs/DEVELOPMENT.md) · [Roadmap](docs/ROADMAP.md)

## The idea

DeepSeek Harness is a plugin-first agent runtime. `dshc` is its terminal control plane, not a second agent harness.

> **Harness owns agent semantics; `dshc` owns terminal interaction, projection, observability and presentation.**

`dshc` uses the official Harness SDK/runtime boundary and keeps models, tools, skills, approval, sandboxing, persistence, sessions, subagents and the agent loop upstream-owned.

## What works now

The M4 default path is a Harness-native coding runtime rather than the old minimal demo composition:

```text
cd repository
 -> dshc
 -> Harness filesystem / search / platform shell / subagents / todo
 -> workspace-write sandbox + ask approval policy
 -> Ink terminal product / plain compatibility paths
 -> bounded local transcript + trace retention
 -> clean runtime teardown
```

Current capabilities:

- Ink 7 + React 19 structured TTY product on the Node 22.19/24 baseline;
- persistent multi-turn conversation with one Harness runtime and stable active session;
- zero-config repository cwd workflow with Harness-owned `read`, `write`, `edit`, `glob`, `grep`, Bash on POSIX / PowerShell on Windows, subagents and todo state;
- shared upstream `workspace-write` sandbox policy for filesystem and shell writes; `danger-full-access` is never an implicit fallback;
- upstream approval policy remains `ask`; protocol `0.0.1` has no dshc server-to-client approval transport, so unavailable escalation fails closed;
- resize-aware transcript, grapheme-safe prompt editor, history navigation and adaptive status line;
- `/help`, `/status`, `/session`, `/new`, `/clear`, `/plugins`, `/capabilities`, `/trace`, `/agents`, `/exit`;
- a slash menu built from the live registry: arrows choose, Tab completes, Enter runs a finished command and completes an unfinished one, and the window scrolls instead of stopping at the fold;
- terminal markdown rendering for assistant prose — headings, emphasis, lists, quotes, fenced code and cell-measured tables — applied through Ink props only, never by emitting escape sequences, and never applied to tool output, which is program output and must survive verbatim (the plain one-shot/piped renderer stays unstyled);
- a token usage readout in the status line and `/status`, in absolute numbers: upstream reports no context window on this transport, so dshc reports no percentage;
- first-party terminal plugin API v1 with deterministic command, renderer, view and status registries;
- specialized coding-tool/subagent presentation plus a safe generic event fallback;
- bounded activity/trace/transcript/topology diagnostic retention with explicit eviction disclosure;
- terminal ESC/CSI/OSC/C1/bidi sanitization, secret-redacted diagnostics and exception-safe alternate-screen cleanup;
- `dshc doctor` compatibility/startup preflight that performs `initialize` only and never issues a model prompt;
- M1/M2 one-shot, piped stdin, JSON and scripted non-TTY `--interactive` modes retained.
- a deployment persona built from the launch itself — host, workspace, proxy and registry configuration, and the two facts upstream cannot know: no client-side approval answerer and no per-request cancel (`DSH_SYSTEM_PROMPT` replaces it wholesale);
- a composition at `<workspace>/.dshc/cordis.yml` is used by every launch in that workspace without a flag, and `doctor` reports which of shipped/workspace/override it resolved;
- `scout` / `planner` / `reviewer` / `oracle` read-only role subagents alongside the general `subagent`, mounted on the upstream delegation seam rather than on a scheduler of our own — see [subagent roles](docs/SUBAGENT-ROLES.md);
- `/config`, `/config fork`, `/model`, `/provider` and `/reload` for inspecting and replacing the composition, each stating the session loss before it acts.

## Source usage

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile

# Preflight is safe before a provider key exists: it reports credential presence only.
pnpm dev -- doctor
pnpm dev -- doctor --json

# Configure the normal DeepSeek Harness provider environment for model-backed work.
# No positional prompt in a TTY => terminal product.
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

### Doctor

`dshc doctor` checks the supported local path without creating a session or sending `session/prompt`. It reports PASS/WARN/FAIL/UNKNOWN findings for Node/workspace/config/package compatibility, provider/model selection, DeepSeek credential presence, TTY/raw-mode facts, the initialize handshake, server/protocol identity, shipped M4 sandbox/approval defaults and dshc retention policy.

```bash
pnpm dev -- doctor
pnpm dev -- doctor --workspace ./some-repo
pnpm dev -- doctor --json
```

The command never prints credential values, lengths, prefixes, fingerprints or environment dumps. A runtime-config override is labelled explicitly because its capability/sandbox/approval composition may differ from the shipped default. Hard configuration/compatibility failures return nonzero; missing credentials and non-TTY execution are warnings rather than invented runtime failures.

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

The validated baseline remains DeepSeek Harness `0.1.1-rc.1`, SDK server `deepseek-harness-sdk-runtime`, protocol `0.0.1`, Node `^22.19.0 || >=24`, pnpm `11.7.0`.

`dshc` adds no private wire method. The public protocol still has no per-prompt cancel, no per-session close, no active server-to-client approval request flow, and no authoritative full runtime-plugin inventory. Therefore:

- `session/prompt` remains an enqueue receipt, not an exact assistant-result RPC;
- activity is observed from the matching durable receipt through root `idle`;
- `/new` changes only the locally selected session;
- Ctrl+C closes the whole owned runtime rather than pretending one prompt was cancelled;
- `doctor` stops after the public `initialize` handshake and never uses `session/prompt`;
- unavailable permission escalation fails closed rather than being fabricated by the terminal frontend;
- `/plugins` labels the Harness runtime plugin inventory partial/unavailable instead of guessing it;
- `/trace` never reconstructs or exposes hidden reasoning;
- local `activityId` values group terminal blocks only and are not upstream message/turn/causal ids.

See [Protocol and upstream compatibility](docs/PROTOCOL.md).

## First-party terminal plugins

The terminal plane is first-party only. Built-in commands, event renderers, views and status segments register through one deterministic `TerminalPluginHost`.

This is deliberately **not** a public arbitrary-package plugin ecosystem yet. Loading untrusted Node packages in-process would grant broad machine access; third-party loading remains deferred until the M4/M6 isolation work establishes a real boundary.

## Validation

Required CI is credential-free and blocking on:

- Windows latest / Node 24;
- macOS latest / Node 24;
- Ubuntu latest / Node 24;
- Ubuntu latest / Node 22.19.0.

Every runtime job builds the Ink/React product. The normal gate drives injected TTY product tests, fake-runtime lifecycle/security tests and bounded-retention regressions. Official published-Harness smokes cover one-shot, persistent interaction, repository read/edit/search/shell, workspace sandbox denial/escalation, and built `dshc doctor --json`. The doctor smoke deliberately removes `DEEPSEEK_API_KEY` and uses an unreachable model endpoint; success proves preflight does not issue a model request.

## Architecture

```text
Terminal user
    │
    ▼
 dshc
 ├─ CLI mode routing + doctor preflight
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

- **M5** — public alpha: package/binary naming, release automation, install/update docs and a compatibility statement;
- **M6** — safe community extension ecosystem and advanced capability views.

## License and affiliation

MIT licensed. This is an independent community project and is **not affiliated with, endorsed by, or maintained by DeepSeek AI**. “DeepSeek” and “DeepSeek Harness” are used only to describe interoperability with the upstream project.
