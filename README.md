# DeepSeek Harness CLI

> An unofficial terminal-native console for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

**Status: public-alpha release candidate (`0.1.0-alpha.1`). M1-M4.6 are complete.** The coding baseline includes composition patches, vision, web research, MCP bridging and restricted self-service Harness plugin installation. The full Harness dependency closure and compatibility gate are pinned to `0.1.1-rc.2`.

[简体中文](README.zh-CN.md) · [Install](docs/INSTALLATION.md) · [Compatibility](docs/COMPATIBILITY.md) · [Demo](docs/DEMO.md) · [Changelog](CHANGELOG.md) · [Extensions](docs/EXTENSIONS.md) · [Design](docs/DESIGN.md) · [Protocol](docs/PROTOCOL.md) · [Development](docs/DEVELOPMENT.md) · [Roadmap](docs/ROADMAP.md)

## Install the public alpha

```bash
npm install --global dshc@alpha
dshc doctor
cd /path/to/repository
dshc
```

The npm package and installed command are both `dshc`. The unscoped package
`deepseek-harness-cli` is unrelated to this repository. See
[installation and lifecycle](docs/INSTALLATION.md) for provider configuration,
pinning, update, uninstall and diagnostics.

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
 -> workspace-write sandbox + never approval policy
 -> Ink terminal product / plain compatibility paths
 -> bounded local transcript + trace retention
 -> clean runtime teardown
```

Current capabilities:

- Ink 7 + React 19 structured TTY product on the Node 22.19/24 baseline;
- persistent multi-turn conversation with one Harness runtime and stable active session;
- zero-config repository cwd workflow with Harness-owned `read`, `write`, `edit`, `glob`, `grep`, Bash on POSIX / PowerShell on Windows, subagents and todo state;
- shared upstream `workspace-write` sandbox policy for filesystem and shell writes; `danger-full-access` is never an implicit fallback;
- upstream approval policy is `never`; protocol `0.0.1` has no dshc server-to-client approval transport, so the model is not promised an unavailable escalation path;
- `vision` routes image inspection to `deepseek-v4-flash-vision-exp`; `web_search`, `web_fetch` and the read-only `researcher` role use Harness-owned seams and timeout policy;
- workspace MCP servers can be enabled by patch; calls retain `mcp__<server>__<tool>` provenance in `/tools` and activity views;
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
- the shipped composition remains authoritative; `<workspace>/.dshc/cordis.patch.yml` is the only automatic workspace layer, and `/config` separates base, patch and effective requested configuration;
- `scout` / `planner` / `reviewer` / `oracle` read-only role subagents alongside the general `subagent`, mounted on the upstream delegation seam rather than on a scheduler of our own — see [subagent roles](docs/SUBAGENT-ROLES.md);
- `/config`, `/config fork`, `/model`, `/provider` and `/reload` for inspecting and patching composition, each stating the session loss before it acts;
- `/plugin search` and `/plugin install` for `@deepseek-ai/` packages only, with exact named confirmation, trial initialization before live replacement and patch rollback on failure.

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
/config        base, patch and effective requested configuration
/plugin        search/install restricted Harness plugins
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

## Taking this over

[docs/HANDOVER.md](docs/HANDOVER.md) is written for whoever picks this up: how
to verify a change (a green suite is not enough, and the reasons are specific),
the failure modes this project has actually hit, what lives where on a working
machine, and the decisions that are the owner's alone.

## Protocol truth

The validated baseline is DeepSeek Harness `0.1.1-rc.2`, SDK server `deepseek-harness-sdk-runtime`, protocol `0.0.1`, Node `^22.19.0 || >=24`, pnpm `11.7.0`.

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

The terminal plane is deliberately **not** an arbitrary-package ecosystem. `/plugin install` affects the child Harness composition only, accepts `@deepseek-ai/` npm packages, requires an exact-version confirmation, installs with lifecycle scripts disabled, and trial-boots before replacing the live runtime. Installed plugin code still executes with the Harness child process's OS authority. See [Extensions and composition](docs/EXTENSIONS.md).

## Validation

Required CI is credential-free and blocking on:

- Windows latest / Node 24;
- macOS latest / Node 24;
- Ubuntu latest / Node 24;
- Ubuntu latest / Node 22.19.0.

Every runtime job builds the Ink/React product. The normal gate drives injected TTY product tests, fake-runtime lifecycle/security tests and bounded-retention regressions. Official published-Harness smokes cover one-shot, persistent interaction, repository read/edit/search/shell, workspace sandbox denial/escalation, built `dshc doctor --json`, and the raw rc.2 event contract for successful and failed tool results. The doctor smoke deliberately removes `DEEPSEEK_API_KEY` and uses an unreachable model endpoint; success proves preflight does not issue a model request.

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

- **M5** — publish the verified `0.1.0-alpha.1` candidate through the owner-side npm 2FA gate;
- **M6** — safe community extension ecosystem and advanced capability views.

## License and affiliation

MIT licensed. This is an independent community project and is **not affiliated with, endorsed by, or maintained by DeepSeek AI**. “DeepSeek” and “DeepSeek Harness” are used only to describe interoperability with the upstream project.
