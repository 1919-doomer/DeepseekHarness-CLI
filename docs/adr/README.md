# Architecture Decision Records

Use this directory for decisions that materially change project architecture, compatibility boundaries, security posture, or terminal interaction semantics.

## Accepted ADRs

- [ADR 0001 — Runtime boundary](0001-runtime-boundary.md)
- [ADR 0002 — Terminal renderer separation](0002-terminal-renderer-separation.md)
- [ADR 0003 — Binary name](0003-binary-name.md)
- [ADR 0004 — GitHub source of truth](0004-github-source-of-truth.md)
- [ADR 0005 — Defer full-screen TUI until M3](0005-defer-full-screen-tui-until-m3.md)
- [ADR 0006 — Terminal rendering is a security boundary](0006-terminal-rendering-is-a-security-boundary.md)
- [ADR 0007 — Align M1 toolchain with upstream](0007-align-m1-toolchain-with-upstream.md)

## Format

Suggested filename format:

```text
0001-short-decision-title.md
```

Template:

```markdown
# ADR 0001 — Decision title

Status: proposed | accepted | superseded
Date: YYYY-MM-DD

## Context

What problem or constraint requires a decision?

## Decision

What are we choosing?

## Alternatives considered

What else was considered and why was it rejected?

## Consequences

What becomes easier, harder, or constrained because of this decision?
```

Do not use ADRs for routine implementation detail. Use them when reversing the choice later would affect multiple modules or public behavior.