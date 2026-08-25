# Protocol and upstream compatibility

This document records the public DeepSeek Harness boundary that `dshc` depends on. Upstream documentation remains authoritative.

Last reviewed and exercised locally: **2026-08-24**.

## Validated runtime baseline

The current terminal product remains pinned to:

- DeepSeek Harness packages: `0.1.1-rc.2`;
- `@deepseek-ai/cordis`: `4.0.1`;
- SDK server name: `deepseek-harness-sdk-runtime`;
- SDK protocol version: `0.0.1`;
- Node: `^22.19.0 || >=24.0.0`;
- pnpm: `11.7.0`.

The exact dependency closure is committed in `pnpm-lock.yaml`. Startup rejects unexpected SDK/runtime package versions or server protocol identity instead of guessing compatibility.

Required credential-free validation targets Windows latest / Node 24, macOS latest / Node 24, Ubuntu latest / Node 24, and Ubuntu latest / Node 22.19.0.

`dshc` uses public package/runtime surfaces only: `@deepseek-ai/dsh-sdk-client`, the public JSON-RPC server, and `@deepseek-ai/dsh-app-boot`'s patch-aware `boot`/config APIs. The small wrapper in `runtime/jsonrpc-agent.mjs` preserves the official stdio lifecycle while passing workspace patch layers and an installed-plugin module anchor into public app-boot.

### rc.2 compatibility evidence

Batch 3 compared official tags `dsh-v0.1.1-rc.1` (`528c682`) and
`dsh-v0.1.1-rc.2` (`b150a55`) before moving the compatibility gate. The SDK
client/protocol/server, core agent/session/tool event producers and session
projection contain no non-manifest source change between those tags. rc.2's
runtime change is concentrated in image normalization and DeepSeek Files API
upload/reuse. `read_image` can now report optional `originalDimensions`, while
the public `tool/result` envelope remains the nested shape consumed here.

`tests/integration/official-event-contract.spec.ts` breaks the fixture/parser
closed loop: it launches the published rc.2 runtime, drives one successful and
one failed real `read` call through a local model endpoint, captures the raw SDK
notifications, and asserts:

- `tool/call` carries `callId`, `name` and serialized `arguments` in event data;
- `tool/result` links through `message.source.callId`, while the nested
  `tool-result` block owns `toolCallId`, output content and `isError`;
- `seq`, `time` and `sourceEventSeqs` preserve the upstream causal link;
- durable assistant `usage` remains a sibling of `message`;
- projection preserves both call ids and distinguishes success from failure.

All direct `@deepseek-ai/dsh-*` packages are exact `0.1.1-rc.2` dependencies,
the lockfile contains no rc.8 residue, and `pnpm peers check` is a CI gate. This
prevents a leaf-plugin upgrade from silently retaining an older service/brand
closure.

The provider-backed gates were also repeated on 2026-08-24 against this exact
closure: Web Search and Web Fetch, a real JPEG through the vision subagent and
`read_image`, the official stdio MCP everything server, and exact installation
plus trial initialization of `dsh-repeat-tool-reminder@0.1.1-rc.2` all passed.

## Session persistence and identity

Sessions are persisted by `@deepseek-ai/dsh-session-persistence-jsonl` under the root configured in `runtime/cordis.yml`, which defaults to `$DSH_SESSION_ROOT` and otherwise to `<home>/sessions/dshc`. The store is therefore **user-global and shared across workspaces**, not per repository.

Since `0.1.1-rc.1` a persisted session id is bound to the working directory it was created in. Reusing that id from a different cwd fails the turn with an `id collision` error rather than resuming or forking. Consequences:

- `dshc --session <id>` only resumes inside the directory the session was created in;
- default session ids are random per process, so ordinary use is unaffected;
- anything that pins a session id across directories — tests especially — must set `DSH_SESSION_ROOT` to its own scratch root, or it will both pollute the user store and eventually collide.

## Process and transport

```text
dshc process
    │
    │ newline-delimited JSON-RPC 2.0 over stdin/stdout
    ▼
dshc patch-aware JSON-RPC wrapper
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

### M6 Cordis lifecycle remains tool-driven

Developer mode adds no request method. The official `0.1.1-rc.2`
`dsh-tool-cordis` package exposes seven model tools:
`cordis_inspect_list`, `cordis_inspect_query`, `cordis_inspect_self`,
`cordis_define`, `cordis_run`, `cordis_stop` and `cordis_undefine`. Their calls
and results arrive through the existing `session.event` `tool/call` and
`tool/result` vocabulary.

The real rc.2 wire puts lifecycle presentation identity in
`tool/result.data.meta`. dshc allowlists `pluginId`, `packageId` and
`pluginRunId` from that public structure; it does not parse rendered result text
to reconstruct them. `/workbench` and the Cordis trace filters remain bounded
local projections, not authoritative inventories or direct control surfaces.

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

Because completion is session-scoped, `HarnessRuntime.run()` enforces one
in-flight activity per session id. Different sessions may run concurrently and
a session may be reused after its root `idle` is observed. If an activity
throws or times out after its prompt may have crossed the transport but before
root `idle`, that session remains quarantined for the lifetime of the runtime:
protocol `0.0.1` has no cancellation or later message-scoped completion signal
that could prove reuse safe. Start a new session or restart the runtime instead.

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

**Official-runtime smoke tests** launch the published runtime with the real Harness composition and route the DeepSeek adapter to a local deterministic HTTP model stub. CI retains one-shot and two-turn persistent subprocess smokes, proves the second provider request carries expanded same-session history, and captures successful/failed rc.2 tool events from the real wire. No paid provider call or real API key is required.

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
