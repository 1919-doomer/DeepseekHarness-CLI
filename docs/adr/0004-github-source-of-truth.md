# ADR 0004 — GitHub is the project source of truth

Status: accepted
Date: 2026-08-20

## Context

The project is being developed publicly and needs one durable place for architecture, execution state, review history and release status. Chat discussions and local notes are transient and can diverge from implementation.

## Decision

GitHub is the authoritative project system.

- repository files define documentation and architecture;
- Issues define executable work and milestone state;
- Pull Requests define proposed changes and review history;
- Actions define automated validation;
- Releases define published support/compatibility states.

External discussions must be reflected back into the repository before they become project decisions.

## Consequences

- project state remains inspectable and reproducible;
- future contributors do not need access to private conversation history;
- status updates should cite repository artifacts rather than private TODOs;
- maintaining Issues/docs becomes part of implementation work, not optional administration.
