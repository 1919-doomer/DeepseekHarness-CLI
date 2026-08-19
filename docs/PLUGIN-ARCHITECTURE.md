# Terminal plugin architecture

DeepSeek Harness is built around the idea that capabilities are composable plugins. `dshc` should preserve that philosophy at the terminal layer without building a second agent harness.

> **DSH: Everything is a Plugin.**
>
> **dshc: Everything You See Is a Plugin.**

The runtime remains authoritative for agent behavior. The terminal becomes a composable client whose commands, renderers, views, status segments and event projections can be registered as plugins.

## 1. Two plugin planes

### Runtime plane — owned by DeepSeek Harness

Examples include model adapters, tools, skills, sessions, persistence, approvals, sandboxing, subagents, jobs, workflows, LSP, web providers and other Cordis capability seams.

`dshc` must not duplicate these systems.

### Terminal plane — owned by dshc

The terminal plane is allowed to extend presentation, interaction and observability:

- command providers;
- tool renderers;
- event renderers;
- status-line segments;
- panels/views;
- key bindings;
- notifications;
- transcript projections;
- session inspectors;
- exporters;
- diagnostics views;
- capability-aware UI adapters.

The terminal plane must not silently replace agent semantics, approval policy, sandbox policy, model routing or tool execution rules.

## 2. Capability-driven UI

The long-term product goal is not a fixed UI with every feature always visible. Instead, the terminal should adapt to the active Harness composition.

Conceptually:

```text
Active DSH runtime capabilities
            │
            ▼
   capability discovery
            │
            ▼
      dshc plugin host
            │
   ┌────────┼─────────┐
   ▼        ▼         ▼
commands  renderers  views
   │        │         │
   └────────┼─────────┘
            ▼
       terminal UI
```

Examples:

- if the runtime exposes subagents, `dshc` can activate an agent-tree view;
- if plan mode is present, a plan view can become available;
- if background jobs are present, a jobs view and status segment can appear;
- if a custom tool is installed, a matching tool-renderer plugin can present its output cleanly;
- unknown capabilities still fall back to generic, protocol-truthful rendering.

The terminal should reshape itself around Harness rather than flatten Harness into a generic chat box.

## 3. Proposed dshc plugin seams

The exact API is intentionally deferred until M2/M3, but the architectural seams should remain stable.

### `commands`

Register local terminal commands and, when supported, bridge runtime commands.

Examples:

```text
/help
/status
/plugins
/trace
/agents
/jobs
/export
```

### `toolRenderers`

Map a tool/event shape to a terminal representation.

A custom DSH tool should not require modifications to the core transcript renderer merely to look good.

### `eventRenderers`

Render normalized events or activity groups such as planning, model streaming, errors, tool lifecycle and subagent lifecycle.

### `views`

Provide larger interactive surfaces such as:

- capability explorer;
- session browser;
- subagent tree;
- job monitor;
- trace/debug view;
- diff/change review;
- token/latency telemetry.

### `statusSegments`

Add compact runtime state to the status line without coupling the entire TUI to each feature.

Examples include provider/model, session id, active agents, jobs, plan mode, git branch and runtime compatibility state.

### `keybindings`

Bind terminal actions without hard-coding every shortcut in the host.

### `notifications`

Allow optional integrations such as desktop notifications, terminal title changes or completion signals while preserving privacy and opt-in behavior.

### `exporters`

Export selected transcript/session projections to JSON, Markdown or other representations without making export logic part of the core renderer.

### `diagnostics`

Register health checks and observability panels for protocol/runtime/plugin compatibility.

## 4. First-party plugins

Even built-in product features should eventually be expressed through the same internal plugin seams rather than privileged one-off code.

Candidate first-party plugins:

```text
@dshc/plugin-transcript
@dshc/plugin-status
@dshc/plugin-tools
@dshc/plugin-subagents
@dshc/plugin-sessions
@dshc/plugin-trace
@dshc/plugin-capabilities
@dshc/plugin-notify
@dshc/plugin-export
```

Initially these may live inside the monorepo rather than be independently published packages.

## 5. Optional runtime bridge plugin

A particularly useful future component is an optional **DSH-side Cordis plugin** maintained by this project, tentatively named `dshc-bridge`.

Its purpose would not be to change agent behavior. It would expose terminal-oriented metadata that the current public SDK does not yet provide, for example:

- active capability/plugin manifest;
- human-command metadata;
- richer session/query information;
- plugin-owned display metadata;
- safe feature negotiation for optional dshc extensions.

Any extension protocol must be namespaced and optional:

```text
dshc/capabilities
dshc/commands
dshc/features
```

The core terminal must continue to work against the official SDK without this bridge. The bridge is an enhancement, not a fork or mandatory replacement runtime.

Do not implement a bridge by importing private Harness internals unless an explicit ADR justifies the risk. Prefer public Cordis services and supported plugin APIs.

## 6. Capability Explorer

A flagship feature should be a terminal-native view of the active Harness composition.

Possible command:

```text
/plugins
```

or:

```text
/capabilities
```

Example target experience:

```text
Harness capabilities

Models
  deepseek-official        deepseek-v4-pro

Tools
  fs                       active
  terminal                 active
  web                      active
  lsp                      active

Agent capabilities
  subagents                active
  agent-teams              unavailable
  plan-mode                active
  jobs                     active

Persistence
  session                  sqlite
  storage                  sqlite

Terminal adapters
  tools                    8 renderers
  subagents                enabled
  jobs                     enabled
  trace                    enabled
```

This directly turns DSH's plugin architecture into a user-visible product advantage.

## 7. Session debugger / trace mode

Because Harness emits durable session events, `dshc` can eventually offer a session debugger rather than only a chat transcript.

Possible views:

- chronological event timeline;
- tool duration and failures;
- subagent start/finish tree;
- streaming vs committed assistant messages;
- runtime state transitions;
- token/latency metadata when available;
- raw normalized events for troubleshooting;
- compatibility warnings when an unknown event appears.

The goal is observability, not exposing hidden model chain-of-thought.

## 8. Plugin profiles

Users may eventually compose terminal experiences from plugin profiles:

```text
minimal
coding
research
observer
```

For example, `observer` could emphasize trace, session history and subagent activity, while `minimal` shows only transcript and essential status.

Profiles configure the terminal plane only. They do not silently alter Harness agent presets or permissions.

## 9. Third-party plugin security

Third-party terminal plugins are powerful because a Node module can otherwise access the user's machine directly.

Therefore community plugin loading should not be enabled casually.

Recommended progression:

1. define internal plugin seams;
2. implement first-party plugins only;
3. stabilize an API version;
4. design a permission and isolation model;
5. only then support arbitrary third-party packages.

A declarative permission list is not a real security boundary if plugins execute in the main Node process. If third-party plugins are supported, process or worker isolation should be evaluated explicitly.

## 10. Plugin API sketch

Illustrative only:

```ts
export default defineDshcPlugin({
  name: 'subagent-view',
  apiVersion: 1,
  requires: {
    harnessCapabilities: ['subagents'],
  },
  setup(ctx) {
    ctx.commands.register(/* ... */)
    ctx.views.register(/* ... */)
    ctx.statusSegments.register(/* ... */)
    ctx.eventRenderers.register(/* ... */)
  },
})
```

The real API should be designed from proven M1/M2 requirements rather than frozen during M0.

## 11. Architectural invariants

1. DSH plugins own runtime semantics; dshc plugins own terminal experience.
2. Core operation must remain possible without optional dshc-specific runtime extensions.
3. Unknown DSH capabilities must degrade to generic safe rendering rather than crash the terminal.
4. Plugins must consume normalized local interfaces rather than spread developer-preview upstream types throughout the application.
5. A renderer plugin cannot bypass upstream approvals or execute tools on its own merely because it can display them.
6. Plugin discovery and compatibility failures must be visible and diagnosable.
7. First-party features should prefer the same plugin seams that future extensions use.

## 12. Implementation timing

Do not turn the M1 runtime vertical slice into a plugin-framework project.

- **M1:** keep interfaces plugin-shaped where inexpensive, but prove the official runtime boundary first.
- **M2:** extract command/render/event registries from proven interaction behavior.
- **M3:** formalize first-party terminal plugin host and capability-driven UI.
- **M4:** harden compatibility, isolation and plugin security.
- **M6/post-alpha:** evaluate public third-party plugin SDK, profiles and ecosystem tooling.

This preserves the project's current execution discipline while making extensibility a first-class architectural direction.