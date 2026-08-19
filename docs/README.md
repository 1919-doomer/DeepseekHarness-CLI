# Documentation

This directory contains the design contract for DeepSeek Harness CLI (`dshc`). Until the first runnable release, these documents are the source of truth for scope and implementation order.

## Core documents

| Document | Purpose |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Process boundaries, modules, event flow, terminal host responsibilities and safety boundaries |
| [PROTOCOL.md](PROTOCOL.md) | The upstream stdio JSON-RPC surface we depend on and how it maps into terminal state |
| [UPSTREAM-COMPATIBILITY.md](UPSTREAM-COMPATIBILITY.md) | Version pinning, compatibility rules and policy for upstream developer-preview changes |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Local development workflow, repository layout, testing and release engineering |
| [ROADMAP.md](ROADMAP.md) | Milestones, dependency order and exit criteria |

## Authority order

When documents disagree, use this order:

1. current official DeepSeek Harness source and documentation;
2. `UPSTREAM-COMPATIBILITY.md` for the exact upstream version targeted by this repository;
3. `ARCHITECTURE.md` for local design decisions;
4. `PROTOCOL.md` for the adapter contract;
5. `ROADMAP.md` for sequencing.

The upstream project is in developer preview. A stale assumption must be corrected in this repository rather than preserved for compatibility with our own documentation.

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

Any commit that changes one of the following should update the relevant document in the same pull request:

- supported upstream DSH version;
- JSON-RPC method/event handling;
- process lifecycle or shutdown behavior;
- tool/approval UX semantics;
- supported platforms;
- release/install procedure;
- milestone exit criteria.
