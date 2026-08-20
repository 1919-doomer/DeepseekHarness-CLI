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

## M4 — Reliability, security and compatibility — next — #13

Make daily use dependable and prepare the terminal/plugin boundaries for alpha-quality scrutiny:

- compatibility/startup diagnostics and `dshc doctor` direction;
- long-session memory/backpressure/output hardening;
- deterministic process and terminal-state cleanup under failures;
- structured secret-safe diagnostics/support data;
- terminal-injection and alternate-screen security review;
- Session Debugger/trace filtering, durations and failure inspection (#35 continuation);
- first-party plugin boundary/API hardening and isolation research;
- Windows/POSIX lifecycle coverage, including host-specific interrupt semantics;
- upstream contract re-validation before alpha.

Security gate: #18. Third-party plugin isolation research: #37.

## M5 — Public alpha — #14

Ship the first installable community preview:

- finalize package/binary naming;
- release/npm automation;
- installation/update/uninstall docs;
- compatibility statement;
- demo/screenshots;
- changelog/release notes;
- public alpha tag.

Release requires the gates in `DEVELOPMENT.md` to pass.

## M6 — Post-alpha capability growth — #16

Candidate work, promoted only when backed by a real user problem and supported upstream contract:

- public third-party terminal plugin SDK after isolation design is credible;
- terminal profiles: minimal / coding / research / observer;
- richer agent topology and future Agent Teams views;
- background jobs monitor;
- session browser/resume/time navigation using Harness persistence/query capabilities;
- change review/diff view;
- exporter/support-bundle plugins;
- notification plugins;
- shell completion/additional distribution channels;
- remote runtime console only if upstream exposes a supported secure transport;
- graceful per-prompt cancel only if upstream adds a real cancel contract;
- performance work for very long sessions;
- plugin replay/development harness and optional hot reload.

Research: #36 explores an optional DSH-side `dshc-bridge` Cordis plugin for capability metadata and feature negotiation. Base `dshc` must remain usable without it.

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
