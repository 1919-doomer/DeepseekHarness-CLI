# Project status

Current phase: **M1 — Runtime vertical slice (ready to start)**

Updated: 2026-08-20

## M0 status

**Complete.** Development-readiness review is recorded in [M0-REVIEW-2026-08-20.md](M0-REVIEW-2026-08-20.md) and the gate is defined in [DEFINITION-OF-READY.md](DEFINITION-OF-READY.md).

Completed pre-development work includes:

- product positioning, scope and differentiation;
- English and Chinese README;
- runtime/process architecture;
- current JSON-RPC protocol semantics;
- terminal UX contract;
- upstream compatibility policy and final upstream re-review;
- dependency/toolchain policy;
- testing strategy;
- threat model and risk register;
- development, contribution and security policies;
- roadmap, release gates and ADR mechanism;
- GitHub Issue-based source-of-truth tracking;
- executable M1 task decomposition.

## Upstream baseline entering M1

Reviewed 2026-08-20 against DeepSeek Harness `0.1.0-rc.8`.

Important constraints entering implementation:

- official TS SDK/runtime uses stdio JSON-RPC;
- `session/prompt` returns an enqueue receipt, not an exact prompt result;
- current protocol exposes no per-prompt cancellation or session-close request;
- upstream is developer preview, so compatibility is pinned/tested rather than assumed.

## Live execution

Master M1 issue: [#10 — Runtime vertical slice](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/10)

Execution order:

1. [#2](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/2) — scaffold TypeScript/ESM project and pinned toolchain;
2. [#3](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/3) — launch official Harness JSON-RPC runtime;
3. [#4](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/4) — initialize and compatibility handshake;
4. [#5](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/5) — prompt + session notifications;
5. [#6](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/6) — normalized projection + plain renderer;
6. [#7](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/7) — shutdown/process lifecycle;
7. [#8](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/8) — protocol/fake-runtime fixtures;
8. [#9](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/9) — cross-platform CI/smoke gate.

## Immediate next action

Start issue **#2**.

No full-screen TUI framework is selected or required in M1. The first implementation should prove the runtime boundary with a plain event-native renderer.