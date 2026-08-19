# ADR 0007 — Align the M1 toolchain with the pinned upstream Harness baseline

Status: accepted
Date: 2026-08-20

## Context

`dshc` drives a developer-preview DeepSeek Harness runtime. Using a Node/package-manager baseline outside the range supported by the pinned upstream version would introduce avoidable compatibility ambiguity during the first vertical slice.

At the M0 final review, upstream DeepSeek Harness `0.1.0-rc.8` declares Node `^22.19.0 || >=24.0.0` and pnpm `11.7.0`.

## Decision

M1 will align its Node/package-manager baseline with the pinned upstream Harness release unless a later ADR documents a deliberate exception. The exact installed Harness SDK/runtime versions will be pinned in the M1 lockfile and compatibility document.

Required CI will be credential-free and will include Windows as a blocking platform.

## Alternatives considered

- Use the newest Node/pnpm independently of upstream: rejected because compatibility failures would be harder to attribute.
- Support older Node versions for broader reach immediately: rejected until the official runtime itself supports them or a tested compatibility layer justifies the divergence.

## Consequences

- M1 development has a single known toolchain baseline;
- future Harness bumps require compatibility review rather than blind dependency updates;
- supported Node ranges may evolve with upstream releases.