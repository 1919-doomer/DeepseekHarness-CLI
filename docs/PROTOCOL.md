# Protocol notes

This document records the public DeepSeek Harness SDK wire contract that `dshc` depends on. It is not a replacement for upstream documentation.

## Transport

The official SDK protocol uses newline-delimited JSON-RPC 2.0 over caller-owned stdin/stdout streams. One compact JSON frame is written per newline.

The terminal frontend must therefore treat the Harness child process stdout as protocol-only. Human-readable diagnostics belong on stderr or in a separate log file.

## Current request surface

At project bootstrap, the public protocol exposes three client-to-runtime requests:

| Method | Purpose | Important semantics |
|---|---|---|
| `initialize` | Configure workspace/provider/model and initialize the runtime client | Handshake only; not a protocol-version negotiation |
| `session/prompt` | Enqueue a user message into a session | Returns an enqueue receipt (`messageId`), not a prompt result |
| `shutdown` | Ask the runtime to shut down | Process lifecycle still needs timeout/escalation handling |

## Current notification surface

The runtime can emit:

| Method | Purpose |
|---|---|
| `session.event` | Durable session-log event envelope |
| `session.status` | Whole-agent `running` / `idle` transition |
| `subagent.started` | Announces a child agent |
| `subagent.finished` | Announces completion for supported in-process children |

The runtime emits session notifications globally. Session-tree scoping is performed by the client.

## Prompt ownership is not prompt/result RPC

`session/prompt` acknowledges that a user message was durably queued. The returned `messageId` does not identify a later assistant message and does not establish a strict request/response pair.

The official high-level TypeScript client defines an activity interval roughly as:

1. enqueue prompt;
2. observe its durable receipt;
3. collect the subsequent event stream;
4. finish when the whole agent becomes idle.

Even the final assistant text in that interval is not a formally prompt-attributed response. Steering, injected context, queued work, or descendants may contribute before idle.

`dshc` must therefore avoid inventing stronger causality than upstream provides.

## Event handling rules

The adapter and renderer must obey these rules:

1. Preserve upstream wire order.
2. Keep the durable event envelope available to the projection layer.
3. Do not infer missing event types from presentation needs.
4. Treat streaming chunks as ephemeral until a durable committed message arrives.
5. Track root-session events separately from descendant-session events.
6. Use `session.status` for runtime activity state rather than guessing from spinner/tool output.
7. Make unknown event types visible in diagnostics and safe to ignore in the renderer when possible.

## Cancellation

The current public protocol has no prompt-cancel request and no per-session close request.

Therefore a reliable mid-turn cancellation cannot be represented as a normal protocol operation today. The only coarse fallback is terminating/closing the owned runtime process.

Initial product behavior:

- do not claim that Ctrl+C cancelled a model turn unless the runtime actually terminated or a future upstream cancel contract confirms cancellation;
- distinguish clearing local input from interrupting runtime activity;
- make destructive runtime termination explicit;
- keep cancellation behavior isolated behind the upstream adapter so it can be replaced when the protocol grows a cancel method.

## Shutdown

The official TypeScript SDK attempts protocol `shutdown`, then escalates through process teardown when required. `dshc` should rely on the official client lifecycle where possible and add terminal-level signal handling around it.

Critical cases to test:

- normal `/exit` while idle;
- Ctrl+C while idle;
- Ctrl+C while running;
- runtime exits unexpectedly;
- stdin closes;
- Windows console close / process-tree behavior;
- SIGTERM on POSIX.

## Protocol drift policy

DeepSeek Harness is currently pre-release. The wire has no negotiated compatibility version.

`dshc` will therefore:

- pin a tested upstream version range;
- expose the detected upstream/runtime version in diagnostics;
- run protocol contract tests in CI;
- fail clearly when required methods or payload assumptions no longer hold;
- keep all compatibility shims under `src/upstream/`;
- never silently reinterpret a changed wire field.

See [UPSTREAM-COMPATIBILITY.md](UPSTREAM-COMPATIBILITY.md).

## Upstream sources

- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/server/README.md

Last reviewed: 2026-08-20.
