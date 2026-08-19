# Testing strategy

## Goal

Test the terminal host as a protocol client, process owner and renderer independently from model quality. Required CI must be deterministic and credential-free.

## Test pyramid

### 1. Pure unit tests

Cover:

- configuration validation;
- upstream version/compatibility guards;
- normalized event reducers/selectors;
- transcript de-duplication;
- tool/subagent projection;
- terminal-control sanitization;
- error classification;
- slash-command parsing;
- lifecycle state transitions.

These tests must not start a Harness runtime.

### 2. Protocol fixture tests

Feed representative newline-delimited JSON-RPC frames into the adapter layer.

Required cases:

- initialize success/error/timeout;
- prompt enqueue receipt;
- session.event ordering;
- running/idle transitions;
- subagent started/finished lineage;
- unrelated-session notifications;
- malformed JSON;
- unknown/extra fields;
- early EOF;
- JSON-RPC error responses;
- protocol drift/unsupported server version.

Fixtures contain no real credentials or private repository data.

### 3. Fake-runtime subprocess tests

Run a controlled child process that behaves like the JSON-RPC runtime. This tests real stdio/process boundaries without using a model.

Cover:

- launch success/failure;
- stderr separation;
- delayed handshake;
- runtime crash;
- shutdown timeout;
- stdin EOF;
- termination escalation;
- cleanup after thrown exceptions;
- Windows/POSIX differences.

### 4. Official-runtime smoke tests

Start the pinned official Harness runtime with the supported configuration. Prefer a no-paid-credential path for startup/initialize/protocol smoke tests.

The required PR gate must not depend on API secrets.

### 5. Credentialed live-model smoke tests

Optional and trusted/manual only. Never expose repository secrets to untrusted fork pull requests.

Use these to verify one real vertical slice, not as the primary correctness suite.

## Cross-platform matrix

Blocking target from M1:

- Windows latest;
- Ubuntu latest.

Add macOS latest where upstream/runtime packaging permits. A platform may not be marked supported solely because TypeScript unit tests pass; process lifecycle and terminal behavior must be exercised.

## M1 release gate

The following path must be repeatable:

`runtime launch -> initialize -> prompt enqueue -> ordered notifications -> committed assistant projection -> idle -> clean shutdown`

## Security tests

Before alpha include adversarial fixtures for:

- ANSI/OSC terminal injection;
- hyperlinks/title/clipboard control sequences;
- secret-looking values in stderr/tool output;
- extremely long lines/output;
- malformed Unicode/control characters;
- filenames containing terminal escapes;
- process failure paths containing environment-derived text.

## Performance tests

Use synthetic event streams to establish bounds for:

- event throughput;
- peak retained streaming buffer;
- large tool-result rendering;
- long-session projection memory;
- resize/re-render cost once full-screen TUI exists.

Performance tests should catch pathological regressions rather than enforce fragile micro-benchmarks.

## Snapshot/golden policy

Golden text output is useful for normalized transcript fixtures. Avoid broad visual snapshots early: they create churn before the terminal layout is stable. At M3, visual/render snapshots may be added selectively for semantic components.

## Definition of a testable feature

A feature is not complete if its behavior can only be verified by manually talking to a paid model. The core contract must be reproducible with fixtures or a fake runtime.