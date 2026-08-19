# ADR 0008 — Terminal plugin plane

Status: accepted
Date: 2026-08-20

## Context

DeepSeek Harness is intentionally plugin-first. `dshc` originally defined itself as a thin terminal frontend, but a fixed monolithic frontend would underuse one of Harness's strongest architectural properties and would make custom Harness capabilities awkward to represent.

At the same time, `dshc` must not become a second agent harness with duplicate model, tool, skill, session, approval or subagent semantics.

## Decision

`dshc` will adopt a separate **terminal plugin plane**.

The boundary is:

- DeepSeek Harness plugins own runtime/agent semantics;
- dshc plugins own terminal interaction, rendering, views and observability.

First-party terminal features should progressively use common registries for commands, tool/event renderers, views, status segments, keybindings, notifications, exporters and diagnostics.

The long-term UI should be capability-driven: when supported metadata is available, active Harness capabilities determine which terminal plugins/views are relevant.

A future optional DSH-side `dshc-bridge` Cordis plugin may expose terminal-oriented capability metadata that is not present in the base SDK, but the standard dshc client must remain usable without it.

M1 will not implement a dynamic third-party plugin system. It will only avoid architectural choices that prevent later extraction. M2/M3 may formalize first-party plugin registries after the runtime and interaction contracts are proven.

## Alternatives considered

### Fixed monolithic TUI

Simpler initially, but every new DSH capability would require core UI edits and the frontend would gradually flatten the Harness plugin model.

### Reuse Cordis directly inside dshc for everything

This risks coupling the terminal frontend to upstream implementation details and effectively turning dshc into another Harness composition. The terminal plugin plane should remain its own narrow client concern.

### Full third-party plugin marketplace from the first release

Rejected because arbitrary Node plugins substantially expand the local security boundary. The internal plugin API must stabilize before public loading is enabled.

## Consequences

Positive:

- custom Harness capabilities can gain custom terminal representations;
- first-party features become more modular;
- capability-aware UX becomes a differentiator;
- the terminal can evolve without moving agent semantics out of Harness;
- observability views become composable rather than hard-coded.

Costs:

- an additional plugin API must eventually be versioned;
- plugin ordering/conflicts require explicit rules;
- third-party loading requires a real isolation/security design;
- capability discovery may require an optional runtime bridge until upstream exposes richer introspection.

## Invariants

- terminal plugins cannot bypass Harness approval/sandbox semantics;
- unknown capabilities must have a generic safe fallback;
- optional dshc extensions cannot become mandatory for basic SDK compatibility;
- the plugin framework must not delay M1's runtime vertical slice.