# ADR 0002 — Keep terminal rendering separate from upstream event semantics

Status: accepted
Date: 2026-08-20

## Context

A coding-agent TUI needs to group, collapse and decorate events for readability. DeepSeek Harness sessions, however, are durable event streams with semantics that must not be rewritten by presentation code.

## Decision

Introduce a local normalized projection layer between upstream notifications and terminal components.

Dependency direction:

```text
upstream SDK/runtime
        ↓
normalized event adapter
        ↓
session projection/reducer
        ↓
terminal renderer
```

The renderer may visually group or collapse events, but it must not alter ordering or claim stronger prompt-response causality than the upstream protocol provides.

Committed transcript data and ephemeral activity state must be represented separately.

## Alternatives considered

### Render raw upstream objects directly

Rejected because it couples UI components to upstream wire/session vocabulary and makes compatibility changes expensive.

### Build a second conversation database

Rejected because Harness already owns durable session history. A second authoritative history risks divergence and incorrect resume behavior.

## Consequences

- renderer framework can be replaced without changing runtime integration;
- event normalization becomes a high-value test target;
- raw upstream semantics remain inspectable for diagnostics;
- local projection bugs can be distinguished from runtime/protocol bugs;
- some additional state/reducer code is required before visual TUI work begins.
