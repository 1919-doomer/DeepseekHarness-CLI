# ADR 0005 — Defer full-screen TUI framework until M3

Status: accepted
Date: 2026-08-20

## Context

The highest-risk parts of `dshc` are the DeepSeek Harness runtime boundary, protocol/event semantics, process lifecycle, cross-platform behavior and terminal-safe rendering. Selecting a full-screen TUI framework before these are proven would couple UI-framework behavior to unresolved runtime problems and make failures harder to isolate.

## Decision

M1 uses a plain event-native terminal renderer. M2 proves persistent interaction semantics. A full-screen TUI framework is evaluated and selected only at M3 entry.

The M3 decision must evaluate Windows Terminal support, input/editing, resize behavior, accessibility, testability, performance, ESM/Node compatibility, maintenance quality and dependency surface.

## Alternatives considered

- Select Ink immediately: rejected because it adds product-layer complexity before the runtime contract is proven.
- Reuse/copy the removed upstream TUI: rejected because upstream explicitly removed that product surface and current host requirements should be designed against the current public SDK/runtime boundary.
- Build a custom terminal renderer from scratch immediately: rejected as premature; M1 only needs a simple renderer and M3 should choose the smallest adequate product-layer solution.

## Consequences

- M1 remains focused on protocol/lifecycle correctness.
- TUI framework lock-in is delayed until real behavior is known.
- M1/M2 renderer/projection interfaces must be replaceable by M3 without changing the upstream adapter.