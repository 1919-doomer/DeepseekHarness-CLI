# Roadmap

This document defines milestone intent. **GitHub Issues are the live execution tracker.** DeepSeek Harness is developer preview, so milestones are contract-gated rather than date-gated.

## M0 — Development readiness — complete

Product boundary, two-process architecture, protocol constraints, security posture, plugin direction, and executable milestone discipline were established before implementation.

## M1 — Runtime vertical slice — complete — #10

Completed on 2026-08-20 through PR #38.

Validated path:

```text
scaffold
 -> launch official Harness runtime
 -> initialize
 -> enqueue one prompt
 -> observe matching durable receipt
 -> consume ordered session-tree notifications
 -> normalize/project events
 -> plain safe terminal rendering
 -> root idle
 -> clean shutdown
 -> cross-platform CI
```

Required CI validates the official Harness runtime and actual one-shot `dshc` command without provider secrets.

## M2 — Interactive terminal loop — complete — #11

Completed on 2026-08-20 through PR #44.

M2 added one persistent runtime/session loop, local commands, multi-turn transcript behavior, `/new`, truthful Ctrl+C/EOF semantics, and credential-free cross-platform runtime gates while retaining one-shot compatibility.

## M3 — Terminal product + first-party plugin plane — complete — #12

Completed on 2026-08-20 through PR #48.

M3 turns the proven M1/M2 seams into the first structured terminal product without moving agent semantics out of Harness:

```text
TTY user
 -> Ink 7 + React 19 terminal product
 -> deterministic first-party terminal plugin host
 -> normalized transcript / views / status
 -> persistent Harness runtime + selected session
 -> receipt / ordered events / idle
 -> clean terminal/runtime teardown
```

Delivered behavior:

- Ink structured TTY product while preserving the validated Node 22.19/24 baseline;
- resize-aware transcript, prompt editor/history and adaptive status line;
- first-party terminal plugin API v1 for commands, event renderers, views and status segments;
- deterministic registry conflict handling and generic safe event fallback;
- specialized tool/subagent rendering and visible large-output folding;
- `/plugins` / `/capabilities` Capability Explorer with explicit partial/unavailable upstream inventory when protocol metadata is missing;
- `/trace` normalized observable timeline without hidden-reasoning reconstruction;
- `/agents` root/subagent topology from public events only;
- local activity grouping that keeps repeated same-session turns distinct without pretending to create upstream causal ids;
- exception-safe alternate-screen lifecycle and preserved whole-runtime Ctrl+C semantics;
- one-shot, JSON, piped and M2 non-TTY scripted interaction retained;
- credential-free product tests that drive the Ink layer with TTY-like streams on the blocking Windows/macOS/Ubuntu matrix;
- published Harness one-shot and persistent runtime smokes retained.

M3 intentionally does **not** load arbitrary third-party Node plugins. The first-party plugin plane proves the API shape; isolation/security remains later work.

Issue #35 continues into M4 for deeper trace/debugger hardening rather than being treated as fully closed by the initial M3 trace/topology slice.

## M4 — Reliability, security and compatibility — complete — #13

Completed on 2026-08-21. Made daily use dependable and prepared the terminal/plugin boundaries for alpha-quality scrutiny:

- compatibility/startup diagnostics and `dshc doctor` direction;
- long-session memory/backpressure/output hardening;
- deterministic process and terminal-state cleanup under failures;
- structured secret-safe diagnostics/support data;
- terminal-injection and alternate-screen security review;
- Session Debugger/trace filtering, durations and failure inspection (#35 continuation);
- first-party plugin boundary/API hardening and isolation research;
- Windows/POSIX lifecycle coverage, including host-specific interrupt semantics;
- upstream contract re-validation before alpha.

Security gate: #18, recorded in [SECURITY-REVIEW.md](SECURITY-REVIEW.md) — no open release blocker. Third-party plugin isolation design: #37, recorded in [PLUGIN-ISOLATION.md](PLUGIN-ISOLATION.md).

The acceptance gate in #13 was executed against the live runtime rather than argued on paper: a real repository was inspected, a bug fixed and its tests run, with DSH owning the tool execution path throughout. Two defects that only that run could expose were fixed as part of it — tool results were parsed against a payload shape the runtime never sends (#84), and one stdin chunk was treated as one keystroke (#86).

## M4.5 — Daily-use polish — complete — #97

Completed on 2026-08-23. Not a planned milestone: it came out of the first real
sessions with `0.1.0-preview.1`, where the product was correct and still
unpleasant to use.

- tool activity framed and given a persistent sidebar, condensed while scrolled back;
- transcript scrolling, page keys, and a slash-command menu built from the live registry;
- compaction made visible instead of silently shrinking the context at 80% pressure;
- `/config`, `/config fork`, `/model`, `/provider`, `/reload` — composition inspection and
  replacement, each stating the session loss before acting, with no upstream settings
  schema encoded in dshc;
- a deployment persona built from the launch itself, and `scout` / `planner` / `reviewer` /
  `oracle` read-only role subagents mounted on the upstream delegation seam (#111).

Shipped as `0.1.0-preview.4`. Every defect this milestone fixed was found by running the
product, not by reading it; the recurring lesson is recorded in #97 and
[SUBAGENT-ROLES.md](SUBAGENT-ROLES.md).

## M5 — Public alpha — complete — #14

Ship the first installable community preview:

- finalize package/binary naming;
- release/npm automation;
- installation/update/uninstall docs;
- compatibility statement;
- demo/screenshots;
- changelog/release notes;
- public alpha tag.

Completed on 2026-08-24 with `@liaosiyuan123/dshc@0.1.0-alpha.2`, the npm
`alpha` tag and matching GitHub prerelease. npm necessarily created `latest`
for the first package publication, so supported installation and updates always
name `@alpha` explicitly.

## M6 — Plugin Workbench — implemented for alpha.3–alpha.5 — #57

The first capability admitted from #16 is the trusted DSH/Cordis Plugin
Workbench:

- interactive-TTY-only `dshc --dev` and initialize-only `doctor --dev`;
- official `0.1.1-rc.2` Cordis runner/tool packages behind an ordered built-in
  developer patch that ordinary mode never loads;
- explicit process-wide trust warning and developer persona;
- `/workbench`, dedicated lifecycle rendering and structured `/trace` filters;
- real official-runtime inspect/define/run/dynamic-call/update/stop/undefine
  acceptance plus credential-free replay;
- guidance from temporary in-memory prototype to ordinary source package,
  workspace patch and post-restart verification.

The pinned package exports seven lifecycle tools (`cordis_inspect_list`,
`cordis_inspect_query`, `cordis_inspect_self`, `cordis_define`, `cordis_run`,
`cordis_stop`, `cordis_undefine`). This measured contract supersedes the older
five-tool planning shorthand. See [PLUGIN-WORKBENCH.md](PLUGIN-WORKBENCH.md).

## M7 — History, context, prompt and permissions — implementation in progress

The source tree now contains the protocol-independent M7.0–M7.3 slices:

- corrected cache accounting and Windows workspace-local TEMP diagnosis;
- an official JSONL `listSnapshots()`/`inspect()` history reader with bounded,
  rebuildable memory projection and workspace scope by default;
- `/history` browsing and review-first Ask History into a fresh session, with
  exact source session/message sequence labels and no resume fabrication;
- `/context`, `/prompt` and `/permissions` views that mark local/requested,
  runtime/observed and unavailable facts explicitly;
- durable approval audit projection while the shipped policy remains `never`.

M7.4 is a deliberate upstream compatibility gate. Protocol `0.0.1` has no
versioned extension router, approval answerer handshake or authoritative final
prompt inspection. Consequently the exact M7.5 permission controls and complete
runtime Prompt inspection remain `requires-upstream`: this repository does not
replace the official server, import private subpaths or add a private side
protocol. See
[HISTORY-CONTEXT-PERMISSIONS.md](HISTORY-CONTEXT-PERMISSIONS.md).

## Post-M6 candidate pool — #16

Candidate work, promoted only when backed by a real user problem and supported upstream contract:

- public third-party terminal plugin SDK after isolation design is credible;
- terminal profiles: minimal / coding / research / observer;
- richer agent topology and future Agent Teams views;
- background jobs monitor;
- formal session resume/time navigation only after Harness exposes a supported
  resume contract (read-only history browsing is now M7);
- change review/diff view;
- exporter/support-bundle plugins;
- notification plugins;
- shell completion/additional distribution channels;
- remote runtime console only if upstream exposes a supported secure transport;
- graceful per-prompt cancel only if upstream adds a real cancel contract;
- performance work for very long sessions;
- optional hot reload only after an upstream contract exists.

Research: #36 explores an optional DSH-side `dshc-bridge` Cordis plugin for capability metadata and feature negotiation. Base `dshc` and the M6 Workbench remain usable without it.

## Feature priorities after M3

The highest-value next work is no longer visual polish for its own sake. Priority is:

1. **Reliability under long sessions and failures.**
2. **Security review of the terminal/plugin boundary.**
3. **Session Debugger / Trace hardening.**
4. **`dshc doctor` and compatibility diagnostics.**
5. **Capability metadata improvements when supported upstream.**
6. **Safe extension isolation before any community package loading.**

## Admission test for new features

Before creating an implementation Issue, ask whether the feature exposes or improves a real DSH capability, improves observability/control/terminal workflow, is protocol-truthful, belongs to the terminal plane, degrades safely when absent, preserves cross-platform behavior, and has an understandable security boundary.

If most answers are no, it probably does not belong in `dshc`.

## Stop condition

If upstream ships and maintains an official terminal frontend that fully covers the same terminal-control/observability needs, reassess whether `dshc` still adds meaningful independent value rather than continuing by inertia.
