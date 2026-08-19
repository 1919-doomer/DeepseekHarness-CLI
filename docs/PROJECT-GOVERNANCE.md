# Project governance and source of truth

This project is developed in public on GitHub.

## Source of truth

GitHub is authoritative for project state.

- `README.md` defines public positioning and current status.
- `docs/` defines architecture, protocol assumptions and development policy.
- `docs/adr/` records durable design decisions.
- GitHub Issues track executable work and milestone progress.
- Pull requests carry implementation changes and review history.
- GitHub Actions will define automated validation once implementation begins.
- Releases will define published compatibility/support states.

Private notes, chat transcripts and local TODO files are not authoritative unless their conclusions are committed back to this repository.

## Progress reporting

A milestone is complete only when its tracking issue's acceptance criteria are met and the corresponding code/docs are on `main`.

Do not report percentage completion without a concrete issue/acceptance-criteria basis. Prefer states such as:

- planned;
- in progress;
- blocked;
- ready for review;
- complete.

## Decision recording

Routine implementation choices belong in Issues/PRs.

Use an ADR when a decision changes one or more of:

- public architecture boundaries;
- upstream compatibility seam;
- persistence ownership;
- terminal security model;
- cancellation semantics;
- executable/package identity;
- supported platform policy.

## Documentation freshness

Technical claims about DeepSeek Harness should be checked against the official upstream repository before release-bearing changes. Because upstream is in developer preview, compatibility documentation must be revised whenever the pinned/tested runtime changes.
