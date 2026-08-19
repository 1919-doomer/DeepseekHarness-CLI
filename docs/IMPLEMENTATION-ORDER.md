# Implementation order

The implementation sequence is intentionally dependency-driven.

## Phase 1 — Prove the wire

Do not build the visual TUI yet.

1. TypeScript package and build/test scripts.
2. Pin official DeepSeek Harness SDK/runtime versions.
3. Resolve and launch the runtime.
4. Complete `initialize`.
5. Submit one prompt.
6. Capture and print ordered notifications.
7. Detect committed assistant output and idle.
8. Shut down cleanly.

Success means a boring command-line smoke test can complete the whole lifecycle reliably.

## Phase 2 — Normalize events

1. Define terminal-facing event types.
2. Normalize upstream notifications.
3. Build a deterministic session reducer.
4. Separate durable transcript from ephemeral activity.
5. Add fixture-driven contract tests.
6. Add unknown-event and transport-failure handling.

Success means the same event fixture always produces the same transcript projection without a TUI framework.

## Phase 3 — Interactive REPL

1. Persistent runtime/session ownership.
2. Multi-turn input.
3. Streaming activity.
4. Local slash-command router.
5. Tool/subagent transcript rendering in plain terminal form.
6. Ctrl+C/EOF lifecycle policy.

Success means the tool is useful even without full-screen rendering.

## Phase 4 — TUI

1. Select/validate terminal UI framework.
2. Input component.
3. transcript component.
4. status/activity component.
5. tool/subagent components.
6. resize and large-output handling.
7. terminal sanitization.

Success means presentation adds clarity without changing event semantics.

## Phase 5 — Hardening

1. OS matrix.
2. process-tree cleanup.
3. compatibility checks.
4. diagnostics/redaction.
5. memory/backpressure.
6. packaging/install/release workflow.

This order is a constraint. If a later UI task requires changing protocol assumptions, return to the relevant earlier layer and document the change rather than patching around it in presentation code.
