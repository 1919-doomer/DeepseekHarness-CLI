# Roadmap

This document defines milestone intent. **GitHub Issues are the live execution tracker.** DeepSeek Harness is developer preview, so milestones are contract-gated rather than date-gated.

## M0 — Development readiness — complete

Product boundary, two-process architecture, protocol constraints, security posture, plugin direction and M1 execution backlog are locked well enough to implement. Historical preparation detail is intentionally kept in closed GitHub Issues rather than separate checklist documents.

## M1 — Runtime vertical slice — #10

Prove one complete supported path before building a TUI:

```text
scaffold
 -> launch official Harness runtime
 -> initialize
 -> enqueue one prompt
 -> consume ordered session notifications
 -> normalize/project events
 -> plain safe terminal rendering
 -> idle
 -> clean shutdown
 -> cross-platform CI
```

Executable tasks: #2-#9.

No full-screen TUI and no general plugin framework in M1.

## M2 — Interactive terminal loop — #11

Turn the vertical slice into a persistent multi-turn terminal application:

- prompt loop and session ownership;
- streamed transcript and tool/subagent visibility;
- local command framework;
- `/help`, `/status`, `/session`, `/new`, `/clear`, `/exit`;
- explicit Ctrl+C/EOF semantics under current no-cancel limitations;
- non-interactive mode retained.

M2 should reveal the real stable seams that M3 can make pluggable.

## M3 — Terminal product + first-party plugin plane — #12

Build the polished terminal experience and formalize the terminal plugin host.

Core goals:

- structured transcript/input/status UI;
- terminal resize/output folding and Windows Terminal support;
- first-party registries for commands, tool/event renderers, views and status segments where real behavior justifies them;
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

The strongest differentiators are not decorative TUI features. Priority is:

1. **Capability Explorer** — show what Harness is actually composed of.
2. **Plugin-aware tool/event rendering** — custom capabilities become readable without core switch-statement growth.
3. **Session Debugger / Trace** — execution observability from user-visible runtime/session metadata.
4. **Agent topology** — root/descendant activity made legible.
5. **Adaptive status/help/commands** — UI changes with active capabilities.
6. **`dshc doctor`** — make developer-preview compatibility diagnosable.
7. **Safe extension ecosystem** — only after plugin isolation/permissions are real.

## Admission test for new features

Before creating an implementation Issue, ask:

1. Does it expose or improve a real DSH capability?
2. Does it improve observability, control or terminal workflow?
3. Is it protocol-truthful?
4. Does it belong to the terminal plane rather than the agent-runtime plane?
5. Does it degrade safely when the capability is absent?
6. Does it preserve Windows/cross-platform behavior?
7. Is the security boundary understandable?

If most answers are no, it probably does not belong in `dshc`.

## Stop condition

If upstream ships and maintains an official terminal frontend that fully covers the same terminal-control/observability needs, reassess whether `dshc` still adds meaningful independent value rather than continuing by inertia.
