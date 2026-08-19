# Documentation

This directory contains the design contract for DeepSeek Harness CLI (`dshc`). Until the first runnable release, these documents are the source of truth for scope and implementation order.

## Core documents

| Document | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Process boundaries, modules, event flow, terminal host responsibilities and safety boundaries |
| [PROTOCOL.md](PROTOCOL.md) | Upstream stdio JSON-RPC surface and how it maps into terminal state |
| [UPSTREAM-COMPATIBILITY.md](UPSTREAM-COMPATIBILITY.md) | Version pinning and policy for upstream developer-preview changes |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Development workflow, repository layout and testing |
| [ROADMAP.md](ROADMAP.md) | Milestones and exit criteria |
| [IMPLEMENTATION-ORDER.md](IMPLEMENTATION-ORDER.md) | Dependency-driven implementation order |
| [RELEASE-CRITERIA.md](RELEASE-CRITERIA.md) | First-alpha release blockers |
| [STATUS.md](STATUS.md) | Current phase and immediate next work |
| [TRACKING.md](TRACKING.md) | GitHub Issue-based work tracking model |
| [PROJECT-GOVERNANCE.md](PROJECT-GOVERNANCE.md) | GitHub source-of-truth policy |
| [NAMING.md](NAMING.md) | Project, package and executable naming policy |
| [M0-CHECKLIST.md](M0-CHECKLIST.md) | Bootstrap completion checklist |
| [adr/](adr/) | Architecture Decision Records |

Repository-level policies:

- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)

## Authority order

When documents disagree, use this order:

1. current official DeepSeek Harness source and documentation;
2. `UPSTREAM-COMPATIBILITY.md` for the exact upstream version targeted by this repository;
3. accepted ADRs and `ARCHITECTURE.md` for local design decisions;
4. `PROTOCOL.md` for adapter semantics;
5. GitHub Issues for live execution state;
6. `ROADMAP.md` for milestone intent and sequencing.

The upstream project is in developer preview. A stale assumption must be corrected here rather than preserved merely because older documentation said otherwise.

## Upstream primary sources

- [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness)
- [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [SDK protocol](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)
- [TypeScript SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)
- [JSON-RPC server](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/server/README.md)
- [JSON-RPC demo runtime](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/examples/jsonrpc-demo/README.md)
- [Headless bundle](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
- [TUI removal decision](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/simplification/2026-08-04-remove-tui-package.md)

## Documentation policy

Technical claims about DeepSeek Harness should link to an upstream primary source whenever practical. Community tutorials may be useful for debugging, but they are not normative for this project.

Any change that modifies supported upstream versions, protocol/event handling, lifecycle semantics, tool/approval UX, supported platforms, install/release procedure or milestone exit criteria must update the relevant document in the same PR.
