# Protocol and upstream compatibility

This document records the public DeepSeek Harness boundary that `dshc` depends on. Upstream documentation remains authoritative.

Last reviewed and exercised in CI: **2026-08-20**.

## Validated M1/M2 baseline

M1 and M2 are pinned to:

- DeepSeek Harness packages: `0.1.0-rc.8`;
- `@deepseek-ai/cordis`: `4.0.1`;
- SDK server name: `deepseek-harness-sdk-runtime`;
- SDK protocol version: `0.0.1`;
- Node: `^22.19.0 || >=24.0.0`;
- pnpm: `11.7.0`.

The exact dependency closure is committed in `pnpm-lock.yaml`. Startup rejects unexpected SDK/runtime package versions or server protocol identity instead of guessing compatibility.

Required credential-free runtime validation is green on Windows latest / Node 24, macOS latest / Node 24, Ubuntu latest / Node 24, and Ubuntu latest / Node 22.19.0.

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

## Public request surface used by dshc

| Method | Purpose | Semantics used by dshc |
|---|---|---|
| `initialize` | configure workspace/provider/model | one runtime handshake; returns server identity |
| `session/prompt` | queue a user message | enqueue receipt (`messageId`), not an assistant result |
| `shutdown` | request runtime shutdown | followed by bounded SDK/process teardown where necessary |

The runtime emits `session.event`, `session.status`, `subagent.started`, and `subagent.finished` notifications used by the M1/M2 projection.

## Activity ownership is receipt-to-idle, not prompt/result RPC

For each turn `dshc` subscribes before prompting, captures the returned `messageId`, waits until the matching durable `agent/inbox/spliced` receipt is observed, then consumes the ordered session-tree stream until the root session reports `idle`.

```text
subscribe session tree
 -> enqueue prompt
 -> observe matching durable inbox receipt
 -> consume ordered root/descendant notifications
 -> stop at root session.status(idle)
```

The receipt does not identify a later assistant message. Steering, injected context, queued work, tools, or descendants may contribute before idle. UI wording must not imply a stronger one-request/one-response contract.

## M2 multi-turn semantics

M2 reuses one initialized `HarnessRuntime` and repeatedly calls the same supported session/prompt path.

- The active session id remains stable across ordinary turns, so Harness reconstructs prior conversation state for later requests.
- `/new` creates a new local session id and selects it for future prompts without restarting the runtime.
- The old session is **not** closed by `/new`; protocol `0.0.1` exposes no per-session close method, so it remains runtime-owned until process shutdown.
- Local commands (`/help`, `/status`, `/session`, `/new`, `/clear`, `/exit`) are intercepted before the Harness boundary and are never sent as model prompts.
- `//text` is the explicit escape for a literal prompt beginning with `/`.
- Piped `--interactive` input is processed line-by-line in the same persistent runtime and is used by deterministic CI.

## Event and renderer rules

1. Preserve SDK notification order.
2. Scope unrelated global session traffic out of the active session tree.
3. Render text deltas as visible ephemeral output; do not surface reasoning deltas as normal assistant text.
4. Treat committed assistant messages as authoritative while avoiding duplicate text already streamed.
5. A display-line break caused by tool/subagent output must **not** discard the accumulated streamed assistant prefix; otherwise the later committed message would be printed twice.
6. Keep tool call/result and subagent lifecycle visible.
7. Retain turn failures separately from later `idle` state.
8. Unknown vocabulary degrades safely and is available in debug diagnostics.
9. Sanitize untrusted terminal control and bidi sequences at the rendering boundary.

## Cancellation, EOF, timeout, and shutdown

The validated protocol still has **no per-prompt cancel** and **no per-session close** request.

Therefore:

- activity timeout reports an unresolved turn without claiming cancellation;
- Ctrl+C during an active interactive turn closes the entire owned Harness runtime and exits with signal-style status where the host exposes POSIX signals;
- Ctrl+C must never be described as successful prompt cancellation;
- EOF while idle exits cleanly; already-read scripted work is allowed to finish before clean exit;
- `/clear` affects local terminal presentation only and does not delete Harness history;
- `/exit` performs the normal whole-runtime close path;
- transport/runtime failure remains distinct from a model turn error.

A future official prompt-cancel or session-close method should be implemented behind `src/upstream/` and then exposed truthfully by the terminal layer.

## Credential-free contract gates

Required CI has three layers:

**Unit/projection tests** cover command parsing, session selection, normalized events, terminal sanitization, and streamed/committed folding.

**Fake-runtime subprocess tests** cover initialize validation, receipt ownership, ordering, unrelated-session filtering, multi-turn same-session reuse, `/new`, EOF, POSIX active-turn SIGINT, activity timeout, malformed protocol, child crash/EOF, secret redaction, and bounded shutdown.

**Official-runtime smoke tests** launch the published `dsh-jsonrpc-agent` with a real Harness composition and route the DeepSeek adapter to a local deterministic HTTP model stub. CI exercises both the M1 one-shot path and an actual two-turn `dshc --interactive` subprocess, verifying that the second provider request carries expanded same-session history. No paid provider call or real API key is required.

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
