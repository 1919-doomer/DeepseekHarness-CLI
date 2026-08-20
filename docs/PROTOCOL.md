# Protocol and upstream compatibility

This document records the public DeepSeek Harness boundary that `dshc` depends on. Upstream documentation remains authoritative.

Last reviewed and exercised in CI: **2026-08-20**.

## Validated M1-M3 baseline

The current terminal product remains pinned to:

- DeepSeek Harness packages: `0.1.0-rc.8`;
- `@deepseek-ai/cordis`: `4.0.1`;
- SDK server name: `deepseek-harness-sdk-runtime`;
- SDK protocol version: `0.0.1`;
- Node: `^22.19.0 || >=24.0.0`;
- pnpm: `11.7.0`.

The exact dependency closure is committed in `pnpm-lock.yaml`. Startup rejects unexpected SDK/runtime package versions or server protocol identity instead of guessing compatibility.

Required credential-free validation targets Windows latest / Node 24, macOS latest / Node 24, Ubuntu latest / Node 24, and Ubuntu latest / Node 22.19.0.

`dshc` uses public package/runtime surfaces only: `@deepseek-ai/dsh-sdk-client`, the published `dsh-jsonrpc-agent` entry point from `@deepseek-ai/dsh-sdk-jsonrpc-demo`, the public JSON-RPC server, and the external Cordis composition in `runtime/cordis.yml`.

## Process and transport

```text
dshc process
    │
    │ newline-delimited JSON-RPC 2.0 over stdin/stdout
    ▼
official dsh-jsonrpc-agent
    │
    └─ runtime/cordis.yml
```

Harness stdout is protocol-only. Human terminal output belongs to `dshc`; runtime diagnostics belong on stderr. `src/upstream/` owns launch/version/wire adaptation, while terminal code consumes normalized local events.

M3 adds **no new wire method**. Ink, the terminal plugin host, Capability Explorer, trace and agent topology all sit above the same M1/M2 public protocol boundary.

## Public request surface used by dshc

| Method | Purpose | Semantics used by dshc |
|---|---|---|
| `initialize` | configure workspace/provider/model | one runtime handshake; returns server identity |
| `session/prompt` | queue a user message | enqueue receipt (`messageId`), not an assistant result |
| `shutdown` | request runtime shutdown | followed by bounded SDK/process teardown where necessary |

The runtime emits `session.event`, `session.status`, `subagent.started`, and `subagent.finished` notifications consumed by the normalized projection.

## Activity ownership is receipt-to-idle, not prompt/result RPC

For each prompt `dshc` subscribes before enqueueing, captures the returned `messageId`, waits until the matching durable `agent/inbox/spliced` receipt is observed, then consumes ordered session-tree notifications until the root session reports `idle`.

```text
subscribe session tree
 -> enqueue prompt
 -> observe matching durable inbox receipt
 -> consume ordered root/descendant notifications
 -> stop at root session.status(idle)
```

The receipt does not identify a later assistant message. Steering, injected context, queued work, tools, or descendants may contribute before idle. UI wording must not imply a stronger one-request/one-response contract.

## Persistent session semantics

M2/M3 reuse one initialized `HarnessRuntime` and repeatedly call the same supported prompt path.

- The active session id remains stable across ordinary prompts, so Harness reconstructs prior conversation state for later requests.
- `/new` selects a fresh local session id without restarting the runtime.
- The previous session is **not** closed by `/new`; protocol `0.0.1` has no per-session close request.
- Local commands are intercepted before the Harness boundary and are never sent as model prompts.
- `//text` sends a literal slash-prefixed prompt.
- Non-TTY `--interactive` remains a deterministic line-oriented persistent mode.

## Local M3 activity ids are not protocol ids

The structured M3 transcript needs distinct presentation blocks for multiple prompt intervals that share one Harness session. `dshc` therefore generates a local `activityId` per `HarnessRuntime.run()` call.

This id exists only in terminal projection state. It is **not**:

- the `session/prompt` receipt `messageId`;
- a Harness turn id;
- an assistant message id;
- a JSON-RPC request id;
- proof of strict causal ownership.

Terminal plugins may use it to group observed UI mutations, but must not expose it as upstream protocol identity.

## Event and renderer rules

1. Preserve observed SDK notification order.
2. Scope unrelated global session traffic out of the active session tree.
3. Render text deltas as visible ephemeral output; do not surface reasoning deltas as normal assistant text.
4. Treat committed assistant messages as authoritative while avoiding duplicate text already streamed.
5. Tool/subagent interleaving must not erase an already-streamed assistant prefix.
6. Multiple prompt intervals in one session remain separate terminal blocks through local activity grouping.
7. Keep tool call/result and subagent lifecycle visible.
8. Retain turn failures separately from later `idle` state.
9. Unknown vocabulary degrades safely and is available under debug mode.
10. Sanitize untrusted terminal-control and bidi sequences at the rendering boundary.

## Capability Explorer truthfulness

Protocol `0.0.1` does not expose an authoritative full runtime plugin/capability inventory. M3 `/plugins` / `/capabilities` therefore combines only:

- verified handshake/runtime metadata already available to `dshc`;
- active dshc first-party terminal plugins/renderers/commands;
- explicitly known protocol absences such as prompt cancel and per-session close.

The Harness runtime plugin inventory is labelled **partial/unavailable** instead of inferred from local assumptions or the Cordis configuration. A future supported capability manifest belongs behind `src/upstream/` or an optional namespaced bridge.

## Trace and topology truthfulness

M3 `/trace` displays a local timeline derived from normalized public notifications. It may show observable event categories, public ids, lengths and lifecycle transitions.

It must never reconstruct, infer or display hidden chain-of-thought/reasoning content. Reasoning deltas remain excluded from ordinary normalized assistant output.

M3 `/agents` derives topology only from observed `subagent.started` / `subagent.finished` data. Missing metadata remains missing rather than being guessed.

## Cancellation, EOF, timeout, and shutdown

The validated protocol still has **no per-prompt cancel** and **no per-session close** request.

Therefore:

- activity timeout reports an unresolved activity without claiming cancellation;
- Ctrl+C during an active terminal interaction closes the entire owned Harness runtime and returns signal-style status where supported;
- Ctrl+C must never be described as successful prompt cancellation;
- EOF in line-oriented non-TTY mode remains a clean exit boundary;
- `/clear` affects local presentation only;
- `/exit` uses the whole-runtime close path;
- alternate-screen teardown is a terminal lifecycle concern and must execute even if product rendering fails;
- transport/runtime failure remains distinct from a model/tool turn error.

A future official prompt-cancel or session-close method should be implemented behind `src/upstream/` before the terminal exposes corresponding controls.

## Credential-free contract gates

Required CI has four layers:

**Unit/projection tests** cover command/plugin registration, normalized events, same-session activity grouping, Capability Explorer truthfulness, trace formatting, folding and terminal sanitization.

**Injected terminal-product integration** drives Ink with TTY-like streams through raw-mode ownership, two same-session prompts, local views, resize, alternate-screen teardown and `/exit`. It uses the deterministic fake Harness runtime and runs without provider credentials.

**Fake-runtime subprocess tests** cover initialize validation, receipt ownership, ordering, unrelated-session filtering, M2 line-mode interaction, `/new`, EOF, POSIX active-turn SIGINT, timeout, malformed protocol, child crash/EOF, secret redaction and bounded shutdown.

**Official-runtime smoke tests** launch the published `dsh-jsonrpc-agent` with the real Harness composition and route the DeepSeek adapter to a local deterministic HTTP model stub. CI retains both the one-shot path and two-turn persistent subprocess smoke, including proof that the second provider request carries expanded same-session history. No paid provider call or real API key is required.

## Compatibility policy

DeepSeek Harness remains developer preview. Before each milestone, perform a fresh upstream contract check. If the public boundary changes:

1. reproduce it in fixture/official-runtime tests;
2. isolate adaptation under `src/upstream/` where possible;
3. add a regression test;
4. update the validated range here;
5. fail clearly on unsupported identities rather than silently reinterpreting fields.

## Primary upstream sources

- `deepseek-ai/deepseek-harness/package.json`
- `packages/sdk/protocol/README.md`
- `packages/sdk/client/src/api.ts`
- `packages/sdk/client/README.md`
- `packages/sdk/server/README.md`
- `packages/examples/jsonrpc-demo/README.md`
- `examples/jsonrpc-agent/`
