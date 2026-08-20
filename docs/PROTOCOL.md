# Protocol and upstream compatibility

This document records the public DeepSeek Harness boundary that `dshc` depends on. Upstream documentation remains authoritative.

Last reviewed and exercised in CI: **2026-08-20**.

## Validated M1 baseline

M1 is pinned to DeepSeek Harness `0.1.0-rc.8` and the current SDK server protocol identity:

- DeepSeek Harness packages: `0.1.0-rc.8`;
- `@deepseek-ai/cordis`: `4.0.1`;
- SDK server name: `deepseek-harness-sdk-runtime`;
- SDK protocol version: `0.0.1`;
- Node: `^22.19.0 || >=24.0.0`;
- pnpm: `11.7.0`.

The exact dependency closure is committed in `pnpm-lock.yaml`. Startup checks reject an unexpected SDK/runtime package version or server protocol identity instead of silently guessing compatibility.

The credential-free official-runtime smoke is green on:

- Windows latest / Node 24;
- macOS latest / Node 24;
- Ubuntu latest / Node 24;
- Ubuntu latest / Node 22.19.0.

M1 uses only public package/runtime surfaces: `@deepseek-ai/dsh-sdk-client`, the published `dsh-jsonrpc-agent` entry point from `@deepseek-ai/dsh-sdk-jsonrpc-demo`, the public JSON-RPC server, and a small external Cordis composition under `runtime/cordis.yml`.

## Transport

The SDK protocol uses newline-delimited JSON-RPC 2.0 over caller-owned stdin/stdout. Harness stdout is protocol-only; human diagnostics belong on the `dshc` side or stderr.

The M1 process model is:

```text
dshc process
    │
    │ stdin/stdout JSON-RPC
    ▼
official dsh-jsonrpc-agent
    │
    └─ runtime/cordis.yml
```

`src/upstream/` owns all launch/version/wire adaptation. Terminal code consumes normalized local events instead of private Harness objects.

## Request surface

At the validated baseline the public client-to-runtime requests are:

| Method | Purpose | Semantics used by dshc |
|---|---|---|
| `initialize` | configure workspace/provider/model | handshake; returns server identity |
| `session/prompt` | queue a user message | returns an enqueue receipt (`messageId`), not an assistant result |
| `shutdown` | request runtime shutdown | followed by bounded SDK process teardown when needed |

## Notification surface

The runtime can emit:

| Method | Purpose |
|---|---|
| `session.event` | durable session-log event envelope |
| `session.status` | whole-agent `running` / `idle` transition |
| `subagent.started` | descendant start notification |
| `subagent.finished` | descendant completion notification where supported |

M1 subscribes before prompting, waits for the matching durable `agent/inbox/spliced` receipt, then projects subsequent root/descendant notifications until the root session reports `idle`. This mirrors the ownership interval used by the official high-level SDK without inventing strict prompt/response causality.

## Event projection rules

M1 normalizes the public event stream into terminal-facing state.

Rules:

1. preserve SDK notification order;
2. scope unrelated global session traffic out of the active session tree;
3. render `text-delta` streaming as ephemeral visible output;
4. treat the committed assistant message as authoritative and avoid duplicate rendering;
5. keep tool call/result and subagent lifecycle visible;
6. do **not** surface reasoning deltas as normal assistant text;
7. retain terminal turn failures separately from later `idle` state;
8. count unknown event vocabulary for diagnostics and degrade safely;
9. never invent an event merely because the UI would like one.

## Prompt ownership is not prompt/result RPC

`session/prompt` confirms that a user message was queued. Its `messageId` does not identify a later assistant message.

The M1 activity interval is:

```text
subscribe session tree
 -> enqueue prompt
 -> observe matching durable inbox receipt
 -> consume ordered notifications
 -> stop at root session.status(idle)
```

Steering, injected context, queued work or descendants can contribute before idle. `dshc` therefore uses terms such as activity/turn interval rather than exposing a false `prompt -> exact response` protocol abstraction.

## Cancellation, timeout and shutdown

The validated public protocol still has **no per-prompt cancel** and **no per-session close** request.

Therefore M1:

- bounds request and activity waits;
- reports activity timeout without claiming the model turn was cancelled;
- makes SIGINT/SIGTERM close the owned Harness runtime, not a fictitious single prompt;
- relies on the official SDK shutdown sequence and bounded process escalation;
- treats transport/runtime failure separately from a model turn error.

A future official cancel method belongs behind `src/upstream/` and must replace, not disguise, the current coarse process-level fallback.

## Compatibility policy

DeepSeek Harness remains developer preview. Before each milestone, issue #17 requires a fresh upstream check.

When the public boundary changes:

1. reproduce the change in fixture/official-runtime tests;
2. update only `src/upstream/` where possible;
3. add a regression test;
4. update this validated baseline;
5. fail clearly on unsupported identities instead of silently reinterpreting fields.

## M1 contract tests

Required CI is credential-free and contains two layers:

**Fake-runtime subprocess tests** cover initialize validation, receipt ownership, ordering, unrelated-session filtering, text vs reasoning chunks, tool/subagent projection, activity timeout, malformed protocol, child crash/EOF, secret redaction and bounded shutdown.

**Official-runtime keyless smoke** launches the published `dsh-jsonrpc-agent`, initializes the real Harness composition, routes the DeepSeek adapter to a local deterministic HTTP model stub, observes committed output and idle, then performs clean shutdown. No provider secret or paid model call is required.

## Primary upstream sources

- `deepseek-ai/deepseek-harness/package.json`
- `packages/sdk/protocol/README.md`
- `packages/sdk/client/README.md`
- `packages/sdk/server/README.md`
- `packages/examples/jsonrpc-demo/README.md`
- `examples/jsonrpc-agent/`
