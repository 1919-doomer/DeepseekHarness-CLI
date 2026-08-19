# Definition of Ready — M1

M1 implementation may begin only when the following are true.

## Product

- [x] Project positioning is explicit and unofficial/community status is clear.
- [x] Product differentiation is documented.
- [x] Alpha scope and non-goals are documented.
- [x] Visual imitation is not treated as a product requirement.

## Architecture

- [x] Harness owns agent semantics; `dshc` owns terminal interaction/presentation.
- [x] Two-process SDK/runtime boundary is the default architecture.
- [x] Upstream-specific code is isolated behind `src/upstream/`.
- [x] Session/transcript state is a projection, not a second authoritative history store.
- [x] Full-screen TUI work is deferred until the runtime/interaction path is proven.

## Upstream contract

Reviewed 2026-08-20:

- [x] DeepSeek Harness baseline is `0.1.0-rc.8`.
- [x] Node/pnpm requirements were re-checked upstream.
- [x] SDK client/runtime boundary was re-checked.
- [x] Protocol methods/notifications were re-checked.
- [x] No prompt cancel/session-close capability is assumed.
- [x] No strict prompt-to-response causality is assumed.

The implementation issue must still pin exact package/runtime versions in the lockfile.

## UX contract

- [x] Runtime states are defined.
- [x] streaming vs committed output semantics are defined.
- [x] tool/subagent visibility requirements are defined.
- [x] Ctrl+C/EOF limitations are explicit.
- [x] terminal rendering is treated as a security boundary.

## Testing

- [x] Unit/fixture/fake-runtime/official-runtime test layers are defined.
- [x] Required CI is credential-free.
- [x] Windows is a blocking target.
- [x] Security fixtures are identified.

## Security

- [x] Threat model exists.
- [x] Credential ownership is intentionally outside `dshc` for alpha.
- [x] terminal escape injection is a release blocker.
- [x] process cleanup and protocol truth are security/reliability invariants.

## Project execution

- [x] GitHub is the source of truth.
- [x] M1 master issue exists (#10).
- [x] M1 is decomposed into executable issues #2–#9.
- [x] Later milestone master issues exist without premature implementation detail.
- [x] Upstream re-check guard issue exists (#17).
- [x] product/security/documentation guardrail issues exist.

## Ready state

When this checklist is committed and M0 issue #1 is closed, the next executable work item is **#2 — M1.1: Scaffold TypeScript/ESM project and pinned toolchain**.

No additional architecture brainstorming is required before starting #2. New information from upstream may still trigger an ADR/update.