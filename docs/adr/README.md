# Architecture Decision Records

Use this directory for decisions that materially change project architecture, compatibility boundaries, security posture, or terminal interaction semantics.

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
