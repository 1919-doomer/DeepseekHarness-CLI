# Proposal: versioned SDK capabilities and server-to-client requests

Status: [proposed upstream on 2026-08-26](https://github.com/deepseek-ai/deepseek-harness/discussions/4583).
This document is a downstream design request, not an implemented or private
dshc protocol.

## Motivation

The public SDK protocol at `@deepseek-ai/dsh-sdk-protocol@0.1.1-rc.2` exposes
three client requests (`initialize`, `session/prompt`, `shutdown`) and four
server notifications. A real request to a namespaced method is rejected by the
pinned server with JSON-RPC `-32603` and
`unknown DeepSeek Harness SDK runtime method: dshc/capabilities`.

This boundary is healthy for compatibility, but an out-of-process SDK client
cannot currently implement truthful interactive approvals, authoritative model
context capacity, final system-prompt inspection, or supported session resume.
In-process Cordis services do not solve this for an SDK client and should not be
accessed through private package subpaths.

## Requested public contract

The exact names are open to upstream design. The required semantics are:

1. A versioned, namespace-isolated extension router declared during
   `initialize`, with capabilities negotiated in both directions. Unknown or
   unsupported versions must be rejected explicitly.
2. Typed server-to-client requests, starting with an approval request/response.
   Every request must carry a session ID, approval request ID, tool name, tool
   call ID and reason. The only initial positive decision should be
   `allow-once`; reject, timeout, disconnect, duplicate and late answers must
   fail closed.
3. Authoritative model limits in initialized/session capabilities: context
   window, maximum output and any reserved-output or compaction threshold that
   the runtime can promise.
4. Read-only metadata for the final assembled prompt: ordered section IDs,
   source, sizes and tool-schema sizes. Raw text should require an explicit
   reveal capability and must never expose hidden reasoning.
5. The effective approval policy and its source.
6. Optional, explicitly capability-gated session resume. Absence of the
   capability must remain distinguishable from an empty or missing session.

## Compatibility and safety constraints

- Additive negotiation must leave protocol `0.0.1` clients working unchanged.
- Extensions must be root-exported, typed and covered by wire fixtures; clients
  must not import internal classes or private subpaths.
- Capability absence is authoritative. Clients must not infer support from
  prose, package presence or in-process Cordis services.
- Approval responses are correlated to exactly one pending request. Replays,
  cross-session responses and responses after cancellation are rejected.
- A client that advertises no approval answerer cannot select `ask`; the runtime
  remains `never`/fail-closed.
- Prompt inspection is observational and read-only. It must not mutate prompt
  assembly or disclose hidden reasoning.

## Minimal acceptance fixtures

An upstream implementation would be usable once public tests demonstrate:

- old-client initialization with no extension fields;
- negotiated initialization with a versioned capability set;
- one approval request answered `allow-once` and one answered `reject`;
- timeout, disconnect, duplicate, replay and cross-session answers all reject;
- authoritative context/model-limit metadata;
- redacted prompt-section metadata with explicit reveal handling;
- optional resume advertised and rejected cleanly when not advertised.

Until such a contract ships, dshc will continue to label these surfaces
`requires-upstream`, keep approval policy `never`, and expose only local or
observed non-authoritative projections.
