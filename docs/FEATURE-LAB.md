# Feature Lab

This document is a product-idea reservoir, not a commitment list. Ideas graduate into GitHub Issues only when they have a clear user problem, an upstream-backed contract and a milestone fit.

The guiding product idea is:

> **DeepSeek Harness is composable at runtime; dshc should be composable at the terminal.**

## Tier A — High-value differentiators

### 1. Capability Explorer

A `/plugins` or `/capabilities` view that explains the active Harness composition: providers, tools, skills, subagents, jobs, plan mode, persistence, sandbox/approval capabilities and the dshc adapters currently rendering them.

Why it matters: turns DSH's plugin architecture into something users can see and understand.

### 2. Plugin-aware tool rendering

Tool output should be renderable by registered adapters rather than one generic JSON/text block.

Examples:

- filesystem edits -> compact diff;
- terminal commands -> command + exit status + folded output;
- web search -> source list;
- subagent control -> child activity card;
- custom third-party DSH tools -> custom renderer if installed, generic safe fallback otherwise.

### 3. Session Debugger / Trace Mode

A `/trace` view for the normalized event timeline:

```text
12:40:01  session running
12:40:02  assistant stream start
12:40:03  tool fs.read start
12:40:03  tool fs.read complete  84 ms
12:40:05  subagent researcher started
12:40:11  subagent researcher finished
12:40:12  assistant committed
12:40:12  session idle
```

This is execution observability, not hidden chain-of-thought exposure.

### 4. Dynamic command palette

Merge local dshc commands and discoverable runtime commands into one searchable command palette. Help text should be generated from active capabilities rather than a static list.

### 5. Adaptive status line

Status segments are plugins. A minimal session may show model + workspace; a complex runtime may add active subagents, jobs, plan mode, compatibility warnings or sandbox state.

## Tier B — Strong power-user features

### 6. Agent topology view

Show root agent, subagents and future agent-team relationships as a live tree with state, duration and recent activity.

Potential interaction:

```text
/agents

root                 running
├─ researcher        running   18s
├─ tester            idle       4s
└─ reviewer          running    7s
```

### 7. Background jobs monitor

If Harness jobs are present, add `/jobs`, a status indicator and completion notifications.

### 8. Change review view

A terminal-native summary of files changed during the current activity/session, backed by actual repository state and tool events rather than guessed model claims.

Possible features:

- changed-file list;
- diff preview;
- jump to file;
- group changes by tool/activity when evidence exists.

### 9. Session browser / time navigation

Browse persisted sessions, titles and traces when supported by the runtime composition. The terminal should not create a parallel authoritative session database.

### 10. Compatibility Doctor

`dshc doctor` diagnoses:

- Node/pnpm compatibility;
- Harness runtime version;
- SDK/protocol mismatch;
- required executable/config resolution;
- provider configuration presence without printing secrets;
- terminal capabilities;
- optional bridge/plugin compatibility.

This can become one of the most useful support tools during Harness developer preview.

## Tier C — Terminal-native convenience

### 11. Notification plugins

Optional completion/failure notifications through:

- terminal bell;
- Windows/macOS/Linux desktop notification;
- terminal tab/title update;
- user-defined command hook.

Disabled or conservative by default to avoid leaking task content.

### 12. Export plugins

Export selected session projections to:

- Markdown;
- normalized JSON;
- event trace bundle;
- debug support bundle with secrets removed.

### 13. Workspace lenses

Optional read-only status modules such as Git branch, dirty state, test status or current package. These are terminal-context helpers, not agent semantics.

### 14. Search-anything palette

One palette that can search local commands, sessions, active agents, tools and capability names depending on what the runtime exposes.

### 15. Minimal / Coding / Research / Observer terminal profiles

Profiles determine terminal plugins and layout, not Harness permissions or agent composition.

## Tier D — Experimental / post-alpha

### 16. Optional `dshc-bridge` DSH plugin

A Cordis plugin running inside Harness that exposes namespaced terminal metadata and feature negotiation not present in the base SDK.

Must remain optional.

### 17. Community terminal plugin SDK

Allow third parties to add renderers/views/commands. Do not expose arbitrary package loading until isolation and permission boundaries are credible.

### 18. Plugin hot reload during UI development

Useful for renderer/theme/plugin authors; low priority for normal users.

### 19. Remote runtime console

Connect to a remote Harness only if upstream exposes a supported secure transport. Do not invent an unauthenticated remote protocol.

### 20. Session replay simulator

Replay recorded normalized event fixtures through the terminal UI for debugging, demos and renderer development without model/API usage.

This may become useful much earlier as a developer tool even if user-facing replay comes later.

## Feature admission test

Before promoting an idea to implementation, ask:

1. Does it expose or improve a real DSH capability?
2. Does it improve observability, control or terminal workflow?
3. Can it be implemented without inventing false protocol semantics?
4. Does it belong to the terminal plane rather than the agent-runtime plane?
5. Can it degrade safely when the capability is absent?
6. Does it preserve Windows as a first-class target?
7. Does the security boundary remain understandable?

If most answers are no, the feature probably does not belong in dshc.