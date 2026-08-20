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

Tasks #2-#9 are closed. Required CI validates the official Harness runtime and actual `dshc` one-shot command without provider secrets.

## M2 — Interactive terminal loop — complete — #11

Completed on 2026-08-20 through PR #44.

M2 turns the validated vertical slice into a persistent terminal session while keeping the same public upstream contract:

```text
launch + initialize once
 -> persistent active session
 -> prompt / receipt / events / idle
 -> repeat on the same session
 -> local commands
 -> /new session without runtime restart
 -> EOF / signal / exit lifecycle
 -> clean shutdown
```

Delivered behavior:

- TTY-default persistent prompt loop;
- one Harness runtime reused across turns;
- stable active session with `/new` rotation;
- `/help`, `/status`, `/session`, `/new`, `/clear`, `/exit`;
- assistant/tool/subagent scrollback;
- stream/commit de-duplication across interleaved tool activity;
- truthful Ctrl+C and EOF semantics under the current no-cancel/no-session-close protocol;
- M1 one-shot, piped stdin, and JSON compatibility retained;
- credential-free fake-runtime and official-runtime two-turn CI on Windows, macOS, and Ubuntu.

No full-screen TUI or general plugin framework was introduced in M2.

## M3 — Terminal product + first-party plugin plane — next — #12

Build the polished terminal experience and formalize terminal extension seams from behavior proven in M1/M2.

Core goals:

- structured transcript/input/status UI;
- terminal resize, output folding, and Windows Terminal support;
- first-party registries for commands, tool/event renderers, views, and status segments where real behavior justifies them;
- capability-driven UI activation;
- Capability Explorer/plugin-aware help when public metadata permits;
- agent/subagent activity view;
- generic safe fallback for unknown tools/events;
- choose the full-screen TUI framework only at M3 entry.

Key Issues: #32 first-party plugin host, #33 Capability Explorer, #34 renderer registry, #35 trace/debugger.

Third-party arbitrary package loading is **not** an M3 requirement.

## M4 — Reliability, security and compatibility — #13

Make daily use dependable:

- compatibility/startup guards;
- fake-runtime + official-runtime regression suite;
- process cleanup and long-session/backpressure hardening;
- structured secret-safe diagnostics;
- terminal-injection/security review;
- Session Debugger/trace hardening;
- plugin boundary/security review;
- Windows/POSIX lifecycle coverage.

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

## Feature priorities

1. **Capability Explorer** — show what Harness is actually composed of.
2. **Plugin-aware tool/event rendering** — custom capabilities become readable without core switch-statement growth.
3. **Session Debugger / Trace** — execution observability from user-visible runtime/session metadata.
4. **Agent topology** — root/descendant activity made legible.
5. **Adaptive status/help/commands** — UI changes with active capabilities.
6. **`dshc doctor`** — make developer-preview compatibility diagnosable.
7. **Safe extension ecosystem** — only after plugin isolation/permissions are real.

## Admission test for new features

Before creating an implementation Issue, ask whether the feature exposes or improves a real DSH capability, improves observability/control/terminal workflow, is protocol-truthful, belongs to the terminal plane, degrades safely when absent, preserves cross-platform behavior, and has an understandable security boundary.

If most answers are no, it probably does not belong in `dshc`.

## Stop condition

If upstream ships and maintains an official terminal frontend that fully covers the same terminal-control/observability needs, reassess whether `dshc` still adds meaningful independent value rather than continuing by inertia.
