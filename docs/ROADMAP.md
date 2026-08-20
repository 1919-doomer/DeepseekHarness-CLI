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

## M4 — Simple-by-default daily-use baseline + hardening — next — #13

M4 turns the M3 terminal product into a practical daily repository frontend while preserving the central architecture rule: DSH owns agent semantics and runtime capabilities; `dshc` owns the terminal control plane.

The product principle for M4 and later is:

> **Simple by default, Harness-native underneath.**

The intended normal-user path is:

```text
install / configure provider
 -> cd <repository>
 -> dshc
 -> use the active DSH runtime through the terminal
```

A first useful coding task must not require the user to understand Cordis, edit `cordis.yml`, or manually assemble a Harness plugin tree.

### M4.0 — Upstream-native runtime baseline

- validate the pinned DSH profile/bundle/composition contracts used for real repository work;
- prefer consuming/following official DSH composition over maintaining a parallel handwritten `dshc` tool inventory;
- replace the intentionally minimal M1-M3 runtime composition as the product default once the supported upstream boundary is proven;
- retain a minimal composition only where it is useful for deterministic fixtures and contract tests;
- add upstream-drift/compatibility tests around the chosen composition boundary.

### M4.1 — Zero-config repository workflow

- current working directory is the default workspace;
- `cd repo && dshc` exposes the verified DSH-backed repository baseline;
- use upstream-owned workspace context, filesystem/search, shell, skills, jobs/subagents and related capabilities where supported by the chosen runtime composition;
- preserve DSH ownership of platform-specific shell execution, sandbox, approvals, persistence and tool semantics;
- keep profile/runtime overrides as advanced configuration rather than first-run requirements;
- missing capabilities degrade visibly and truthfully rather than being guessed or emulated.

### M4.2 — Capability-driven terminal control plane

- render observed DSH tool/skill/subagent activity clearly without redefining it;
- keep unknown-capability/event generic fallbacks safe and inspectable;
- improve capability discovery and diagnostics only from supported/public metadata;
- keep first-party terminal plugins limited to interaction, projection, observability and presentation.

### M4.3 — Reliability and security

- compatibility/startup guards;
- long-session memory/backpressure/output hardening;
- deterministic process and terminal-state cleanup under failures;
- structured secret-safe diagnostics/support data;
- terminal-injection and alternate-screen security review;
- credential redaction;
- Windows/POSIX lifecycle coverage, including host-specific interrupt semantics.

### M4.4 — Diagnose and recover

- `dshc doctor` direction and implementation as supported by the active runtime contract;
- runtime/config/version/protocol/provider/terminal capability diagnostics without printing secrets;
- Session Debugger/trace filtering, durations and failure inspection (#35 continuation);
- crash/recovery diagnostics;
- upstream contract re-validation before alpha.

M4 completion requires an end-to-end real-repository task proving that DSH owns the workspace/tool execution path while `dshc` truthfully renders it and exits cleanly.

Security gate: #18. Third-party terminal plugin isolation research: #37.

## M5 — Public alpha — #14

Ship the first installable community preview only after both reliability and first-run usability are proven:

- finalize package/binary naming;
- release/npm automation;
- installation/update/uninstall docs;
- compatibility statement;
- demo/screenshots;
- changelog/release notes;
- public alpha tag;
- fresh-environment first-run validation on supported platforms.

The release-blocking user path is approximately:

```text
install dshc
configure a supported provider
cd <real-repository>
dshc
 -> inspect repository
 -> perform a safe change
 -> run relevant tests
 -> observe DSH-owned tool activity
 -> clean shutdown
```

The normal path must not require hand-editing Harness composition. Advanced runtime/profile configuration remains progressive disclosure.

Release requires the gates in `DEVELOPMENT.md` to pass.

## M6 — Post-alpha capability growth — #16

M6 grows the already-working M4 repository baseline; it is not where basic coding capability begins.

Candidate work, promoted only when backed by a real user problem and supported upstream contract:

- public third-party terminal plugin SDK after isolation design is credible;
- advanced terminal profiles such as minimal / research / observer and an explicitly tuned coding profile beyond the default M4 baseline;
- richer agent topology and future Agent Teams views;
- richer background jobs/workflow monitor;
- session browser/resume/time navigation using Harness persistence/query capabilities;
- change review/diff-oriented terminal surfaces;
- deeper LSP-aware presentation where supported by the active DSH composition;
- exporter/support-bundle plugins;
- notification plugins;
- shell completion/additional distribution channels;
- remote runtime console only if upstream exposes a supported secure transport;
- graceful per-prompt cancel only if upstream adds a real cancel contract;
- performance work for very long sessions;
- plugin replay/development harness and optional hot reload.

Research: #36 explores an optional DSH-side `dshc-bridge` Cordis plugin for capability metadata and feature negotiation. Base `dshc` must remain useful without it.

## Feature priorities after M3

The highest-value next work is:

1. **Prove the upstream-native DSH composition boundary for real repository work.**
2. **Make `cd repo && dshc` the simple default path.**
3. **Keep DSH capabilities visible and controllable without duplicating their semantics.**
4. **Harden reliability, security, long-session behavior and cleanup.**
5. **Strengthen Session Debugger / Trace and `dshc doctor`.**
6. **Prepare the installable public alpha.**
7. **Only then grow advanced profiles and third-party extension surfaces.**

## Admission test for new features

Before creating an implementation Issue, ask whether the feature exposes or improves a real DSH capability, improves observability/control/terminal workflow, reduces first-run complexity, is protocol-truthful, belongs to the terminal plane, degrades safely when absent, preserves cross-platform behavior, and has an understandable security boundary.

If most answers are no, it probably does not belong in `dshc`.

## Stop condition

If upstream ships and maintains an official terminal frontend that fully covers the same terminal-control/observability needs, reassess whether `dshc` still adds meaningful independent value rather than continuing by inertia.
