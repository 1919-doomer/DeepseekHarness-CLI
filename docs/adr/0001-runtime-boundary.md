# ADR 0001 — Use the official out-of-process SDK runtime boundary

Status: accepted
Date: 2026-08-20

## Context

DeepSeek Harness is in developer preview and changes quickly. The project needs a terminal frontend without coupling presentation code to private Harness internals or reviving the deleted upstream TUI implementation.

The public upstream SDK exposes a subprocess-driven stdio JSON-RPC boundary via the TypeScript client and JSON-RPC runtime.

## Decision

`dshc` will treat the official out-of-process SDK runtime boundary as its primary integration seam.

The terminal process owns:

- input and slash commands;
- transcript projection;
- terminal rendering;
- local UI state;
- process lifecycle orchestration around the official client.

The Harness runtime owns:

- agent loop semantics;
- model/provider routing;
- tools;
- session/event persistence;
- subagent execution;
- runtime plugins.

All version-specific compatibility code stays behind `src/upstream/`.

## Alternatives considered

### Import Harness internals directly

Rejected because private package/plugin internals create a much larger compatibility surface during developer preview.

### Fork DeepSeek Harness

Rejected because the project goal is a frontend, not a divergent Harness distribution.

### Copy/revive the removed upstream TUI

Rejected as the default because upstream explicitly removed that product surface and the new frontend should be designed around current host requirements and current public runtime boundaries.

### Wrap the Web UI

Rejected because it would not provide a terminal-native interaction model and would preserve unnecessary browser/runtime complexity.

## Consequences

Positive:

- narrow compatibility seam;
- renderer can evolve independently;
- runtime crashes are process-isolated;
- upstream cancellation/approval additions can be adopted through the adapter;
- testing can focus on a structured protocol contract.

Negative:

- runtime process management becomes a core responsibility;
- current protocol limitations such as no prompt cancellation are inherited;
- TypeScript runtime launch resolution is not fully packaged for this consumer yet;
- protocol drift must be actively monitored and tested.
