# Upstream compatibility

DeepSeek Harness CLI is deliberately a thin client of the public DeepSeek Harness runtime boundary. Because upstream is currently in developer preview, compatibility is managed explicitly rather than assumed.

## Compatibility target

At bootstrap, `dshc` targets the public SDK surfaces shipped by `deepseek-ai/deepseek-harness` around the 2026-08-20 developer-preview line.

The exact tested package versions will be pinned once the implementation scaffold lands. Until then, documentation describes capabilities, not a promise of compatibility with every Harness commit.

## Supported boundary

Preferred dependencies:

- `@deepseek-ai/dsh-sdk-client`;
- the official JSON-RPC runtime entry point;
- the official SDK protocol package/types where exported;
- an external Cordis runtime composition built from public Harness plugins.

Avoid:

- private source imports from upstream packages;
- copying the deleted upstream TUI;
- depending on undocumented internal plugin state;
- monkey-patching Harness process internals;
- parsing human-formatted output when a structured SDK event exists.

## Compatibility matrix

This table becomes release-bearing once M1 is implemented.

| dshc version | DeepSeek Harness / SDK | Node | Status | Notes |
|---|---|---|---|---|
| `main` | developer preview | TBD from pinned upstream | bootstrap | Architecture/docs only |

Every public release must update this table.

## Version-drift strategy

Compatibility logic belongs under `src/upstream/` and nowhere else.

The adapter should expose a small terminal-facing interface such as:

```ts
interface HarnessRuntime {
  start(): Promise<void>
  prompt(input: string, sessionId?: string): Promise<PromptReceipt>
  subscribe(): AsyncIterable<NormalizedNotification>
  shutdown(): Promise<void>
}
```

The exact interface may change during M1, but renderer and command code must not consume raw upstream implementation objects directly.

## Startup checks

Before entering an interactive session, the client should eventually verify:

1. runtime executable is resolvable;
2. runtime can complete `initialize`;
3. required protocol methods are available by behavior/contract;
4. configured provider/model route is accepted;
5. workspace path is valid;
6. detected upstream version lies inside a tested range when a reliable version surface exists.

A mismatch should produce a useful error with:

- detected version;
- tested range;
- failing capability;
- link to this compatibility document;
- override instructions only when an override is actually safe.

## CI contract suite

The compatibility suite should contain two layers.

### Protocol fixtures

Fast tests over captured/synthetic JSON-RPC frames:

- initialize success/failure;
- prompt receipt;
- session event ordering;
- running/idle transitions;
- subagent lifecycle;
- unknown notification tolerance;
- malformed frame handling;
- runtime EOF/transport failure.

### Real-runtime smoke tests

Against a pinned official Harness runtime:

- boot;
- initialize;
- one prompt;
- observe durable receipt;
- observe committed assistant output;
- reach idle;
- graceful shutdown.

Real provider calls should not be required for every PR if upstream offers a deterministic/mock provider path. If they are required, they belong in a separately gated integration workflow with secrets protected.

## Breaking-change response

When upstream breaks the supported boundary:

1. reproduce the break against the pinned compatibility test;
2. determine whether upstream changed a documented public contract;
3. patch only `src/upstream/` when possible;
4. update the compatibility matrix;
5. add a regression test;
6. document behavior changes in the release notes;
7. do not silently widen a semver range without testing it.

## Upstream monitoring

Changes most likely to affect this project:

- protocol methods or payload shapes;
- SDK client lifecycle semantics;
- runtime executable/package layout;
- session event vocabulary;
- approval/request direction support;
- cancellation/session-close additions;
- provider/model initialization parameters;
- Cordis configuration required by the JSON-RPC runtime.

Primary source:

https://github.com/deepseek-ai/deepseek-harness

Last reviewed: 2026-08-20.
