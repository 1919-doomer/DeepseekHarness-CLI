# Documentation

This directory contains the design contract for DeepSeek Harness CLI (`dshc`). Until the first runnable release, these documents are the source of truth for scope and implementation order.

## Core documents

| Document | Purpose |
|---|---|
| [PRODUCT-SPEC.md](PRODUCT-SPEC.md) | Product scope, users, principles, alpha success criteria and non-goals |
| [DIFFERENTIATION.md](DIFFERENTIATION.md) | Why `dshc` exists and how it differs from DSH Web/headless and other coding-agent CLIs |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Process boundaries, modules, event flow, terminal host responsibilities and safety boundaries |
| [PLUGIN-ARCHITECTURE.md](PLUGIN-ARCHITECTURE.md) | Terminal plugin plane, capability-driven UI and future plugin SDK direction |
| [FEATURE-LAB.md](FEATURE-LAB.md) | Brainstorm reservoir and feature-admission criteria |
| [PROTOCOL.md](PROTOCOL.md) | Upstream stdio JSON-RPC surface and how it maps into terminal state |
| [UX-CONTRACT.md](UX-CONTRACT.md) | Terminal behavior, event/transcript semantics, tools, subagents and interruption behavior |
| [UPSTREAM-COMPATIBILITY.md](UPSTREAM-COMPATIBILITY.md) | Version pinning and policy for upstream developer-preview changes |
| [DEPENDENCY-POLICY.md](DEPENDENCY-POLICY.md) | Runtime/toolchain/dependency admission and TUI-framework timing |
| [TESTING-STRATEGY.md](TESTING-STRATEGY.md) | Unit, protocol fixture, fake-runtime, real-runtime, security and cross-platform testing |
| [THREAT-MODEL.md](THREAT-MODEL.md) | Assets, trust boundaries, threats, controls and pre-alpha security gates |
| [RISK-REGISTER.md](RISK-REGISTER.md) | Technical, product and upstream risks with mitigation strategy |
| [DEFINITION-OF-READY.md](DEFINITION-OF-READY.md) | M1 development-readiness gate |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Development workflow, repository layout and testing |
| [ROADMAP.md](ROADMAP.md) | Milestones and exit criteria |
| [IMPLEMENTATION-ORDER.md](IMPLEMENTATION-ORDER.md) | Dependency-driven implementation order |
| [RELEASE-CRITERIA.md](RELEASE-CRITERIA.md) | First-alpha release blockers |
| [STATUS.md](STATUS.md) | Current phase and immediate next work |
| [TRACKING.md](TRACKING.md) | GitHub Issue-based work tracking model |
| [PROJECT-GOVERNANCE.md](PROJECT-GOVERNANCE.md) | GitHub source-of-truth policy |
| [NAMING.md](NAMING.md) | Project, package and executable naming policy |
| [M0-CHECKLIST.md](M0-CHECKLIST.md) | Bootstrap/development-readiness checklist |
| [M0-REVIEW-2026-08-20.md](M0-REVIEW-2026-08-20.md) | Final upstream/product/security review before M1 |
| [adr/](adr/) | Architecture Decision Records |

Repository-level policies:

- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)

## Authority order

When documents disagree, use this order:

1. current official DeepSeek Harness source and documentation;
2. `UPSTREAM-COMPATIBILITY.md` for the exact upstream version targeted by this repository;
3. accepted ADRs and `ARCHITECTURE.md` for local design decisions;
4. `PROTOCOL.md` and `UX-CONTRACT.md` for adapter/product semantics;
5. GitHub Issues for live execution state;
6. `ROADMAP.md` for milestone intent and sequencing.

The upstream project is in developer preview. A stale assumption must be corrected here rather than preserved merely because older documentation said otherwise.

## Live execution tracker

- M0 closure record: [#1](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/1)
- M1 runtime vertical slice: [#10](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/10)
- M2 interactive terminal loop: [#11](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/11)
- M3 terminal product layer: [#12](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/12)
- M4 hardening: [#13](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/13)
- M5 public alpha: [#14](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/14)
- Product-direction guardrail: [#15](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/15)
- Upstream contract re-check: [#17](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/17)

## Upstream primary sources

- [DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness)
- [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [Capability seams](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/capability-seams.md)
- [SDK protocol](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)
- [TypeScript SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)
- [JSON-RPC server](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/server/README.md)
- [JSON-RPC demo runtime](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/examples/jsonrpc-demo/README.md)
- [Headless bundle](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
- [TUI removal decision](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/simplification/2026-08-04-remove-tui-package.md)

## Documentation policy

Technical claims about DeepSeek Harness should link to an upstream primary source whenever practical. Community tutorials may be useful for debugging, but they are not normative for this project.

Any change that modifies supported upstream versions, protocol/event handling, lifecycle semantics, plugin boundaries, tool/approval UX, supported platforms, install/release procedure or milestone exit criteria must update the relevant document in the same PR.