# Protocol and upstream compatibility

This document records the public DeepSeek Harness boundary that `dshc` depends on. Upstream documentation remains authoritative.

Last reviewed: **2026-08-20**.

## Current baseline

M1 targets the DeepSeek Harness developer-preview line around `0.1.0-rc.8`.

Current upstream toolchain baseline:

- Node: `^22.19.0 || >=24.0.0`;
- pnpm: `11.7.0`.

The implementation lockfile must pin the exact packages actually tested. Public releases must state their tested Harness/SDK range.

Preferred public dependencies are the official TypeScript SDK client, official JSON-RPC runtime entry point/protocol types where exported, and a public Cordis runtime composition. Avoid private source imports, copied upstream TUI code, undocumented plugin internals and parsing human-formatted output when structured events exist.

## Transport

The SDK protocol uses newline-delimited JSON-RPC 2.0 over caller-owned stdin/stdout.

Harness stdout is therefore protocol-only. Human diagnostics belong on the `dshc` side, stderr, or a separate scrubbed log.

## Request surface

At the current baseline the public client-to-runtime requests are:

| Method | Purpose | Important semantics |
|---|---|---|
| `initialize` | Initialize workspace/provider/model configuration | handshake, not protocol-version negotiation |
| `session/prompt` | Queue a user message into a session | returns an enqueue receipt (`messageId`), not an assistant result |
| `shutdown` | Request runtime shutdown | process teardown still requires bounded escalation |

## Notification surface

The runtime can emit:

| Method | Purpose |
|---|---|
| `session.event` | durable session-log event envelope |
| `session.status` | whole-agent `running` / `idle` transition |
| `subagent.started` | child-agent start notification |
| `subagent.finished` | child completion for supported in-process descendants |

Notifications may be global to the runtime; client-side projection must scope root and descendant sessions correctly.

## Prompt ownership is not prompt/result RPC

`session/prompt` confirms that a message was queued. Its `messageId` does not identify a later assistant message and does not establish strict one-request/one-response causality.

The high-level activity interval is approximately:

1. enqueue prompt;
2. observe durable receipt;
3. consume subsequent events;
4. finish when the whole agent becomes idle.

Steering, queued work, injected context or descendants may contribute before idle. `dshc` must not invent stronger causality in its state model or labels.

## Event handling rules

1. Preserve upstream wire order.
2. Keep enough durable envelope data for projection/debugging.
3. Treat streaming chunks as ephemeral until committed output arrives.
4. Avoid duplicate output when a committed assistant message replaces streaming text.
5. Track root and descendant session activity separately.
6. Use `session.status` for whole-agent running/idle state when available.
7. Unknown event types should degrade safely and remain visible in diagnostics.
8. Do not infer protocol events merely because the UI would like them to exist.

## Cancellation and interruption

The current public protocol has **no per-prompt cancel request** and **no per-session close request**.

Therefore:

- clearing local input is not runtime cancellation;
- `dshc` must not print “cancelled” unless a real terminal condition is known;
- abandoning active work may require explicit runtime-process termination;
- destructive process termination must be described truthfully;
- a future official cancel method should replace the fallback behind `src/upstream/` without forcing a UI rewrite.

## Shutdown

Prefer the official SDK lifecycle: protocol `shutdown`, then bounded teardown/escalation where necessary.

Important test cases:

- normal exit while idle;
- Ctrl+C while idle and while running;
- runtime crash/EOF;
- transport failure;
- Windows process-tree behavior;
- SIGTERM/EOF behavior on POSIX.

## Compatibility strategy

DeepSeek Harness is developer preview and the current wire does not negotiate a protocol version. Compatibility must therefore be explicit.

`dshc` will:

- pin and test an upstream range;
- isolate all version-specific behavior under `src/upstream/`;
- expose detected versions in diagnostics where available;
- run synthetic/fake-runtime contract tests without credentials;
- run official-runtime smoke tests against the pinned baseline;
- fail clearly when required behavior changes;
- never silently reinterpret a changed wire field or widen a version range without tests.

### Startup checks

As implementation matures, startup should validate as much as the public boundary permits:

1. runtime executable/config resolution;
2. successful `initialize`;
3. workspace validity;
4. provider/model configuration acceptance;
5. detected Harness/SDK version against the tested range;
6. optional terminal/bridge capabilities.

A mismatch should report detected version, tested range and failing capability without leaking credentials.

### CI compatibility layers

**Protocol/fake-runtime tests:** initialize success/failure, prompt receipt, event ordering, running/idle transitions, subagent lifecycle, malformed frames, unknown notifications, timeout and EOF/transport loss.

**Official-runtime smoke:** boot -> initialize -> enqueue prompt or deterministic mock path -> observe events -> idle -> graceful shutdown. Credentialed live-provider tests must remain optional/trusted, never required on untrusted PRs.

### Breaking upstream change response

1. reproduce against a contract/smoke test;
2. verify whether a documented public boundary changed;
3. patch `src/upstream/` when possible;
4. add a regression fixture/test;
5. update the tested compatibility range and release notes;
6. avoid leaking raw upstream types into renderer/plugin code.

## Upstream areas to monitor

- protocol methods/payload shapes;
- SDK lifecycle behavior;
- runtime package/executable layout;
- session event vocabulary;
- cancellation/session-close additions;
- client-facing approval/question semantics;
- provider/model initialization parameters;
- Cordis config required by the JSON-RPC runtime;
- public capability/plugin metadata useful for `dshc`.

## Primary upstream sources

- DeepSeek Harness repository: `deepseek-ai/deepseek-harness`
- `docs/architecture.md`
- `docs/capability-seams.md`
- `packages/sdk/protocol/README.md`
- `packages/sdk/client/README.md`
- `packages/sdk/server/README.md`
- `packages/examples/jsonrpc-demo/README.md`
