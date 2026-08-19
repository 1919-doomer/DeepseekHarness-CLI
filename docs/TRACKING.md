# Work tracking

Implementation work is tracked in GitHub Issues.

## Milestone issue model

Each major milestone has one parent tracking issue whose checklist defines completion. Substantial implementation tasks may be split into child Issues and linked from that parent.

Planned parent milestones:

- M0 — Contract and architecture lock
- M1 — Runtime vertical slice
- M2 — Interactive terminal loop
- M3 — TUI product layer
- M4 — Safety, reliability and compatibility
- M5 — Public alpha

`docs/ROADMAP.md` explains milestone intent. GitHub Issues represent live execution state.

## Task sizing

Create a separate Issue when work:

- changes a public behavior;
- spans multiple commits;
- introduces an upstream compatibility dependency;
- requires cross-platform validation;
- has security implications;
- benefits from independent acceptance criteria.

Small documentation corrections and obvious maintenance may go directly through a focused PR.

## Status interpretation

Use GitHub state rather than duplicate TODO lists in documents.

- open Issue: work is not complete;
- closed Issue: acceptance criteria are met or issue is explicitly not planned;
- merged PR: change is present on its target branch;
- `main`: authoritative current project state.

Roadmap prose should not be manually edited to simulate a project-management database.
