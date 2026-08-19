# Work tracking

Implementation work is tracked in GitHub Issues. `main` plus GitHub Issue/PR state is authoritative; chat is not a project database.

## Live milestone issues

- M0 — Contract and architecture lock: [#1](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/1) — **closed/completed**
- M1 — Runtime vertical slice: [#10](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/10)
- M2 — Interactive terminal loop: [#11](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/11)
- M3 — Terminal product layer: [#12](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/12)
- M4 — Reliability/security/compatibility hardening: [#13](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/13)
- M5 — Public alpha: [#14](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/14)
- M6 — Post-alpha capability backlog: [#16](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/16)

Ongoing guardrails:

- [#15](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/15) — preserve DSH-native product differentiation;
- [#17](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/17) — re-check upstream contracts before milestones;
- [#18](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/18) — pre-alpha threat-model/security gate;
- [#19](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/19) — keep docs synchronized with behavior/status.

## M1 executable backlog

M1 is already decomposed so development can begin without another planning pass:

1. [#2](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/2) — TypeScript/ESM + pinned toolchain;
2. [#3](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/3) — official runtime launcher;
3. [#4](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/4) — initialize/compatibility handshake;
4. [#5](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/5) — prompt + notifications;
5. [#6](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/6) — normalized projection + plain renderer;
6. [#7](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/7) — shutdown/lifecycle;
7. [#8](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/8) — protocol/fake-runtime tests;
8. [#9](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/9) — cross-platform CI and smoke gate.

## Task sizing

Create a separate Issue when work:

- changes public behavior;
- spans multiple commits;
- introduces an upstream compatibility dependency;
- requires cross-platform validation;
- has security implications;
- benefits from independent acceptance criteria.

Small documentation corrections and obvious maintenance may go directly through a focused PR.

## Status interpretation

- open Issue: work is not complete;
- closed Issue: acceptance criteria are met or work is explicitly not planned;
- merged PR: change is present on its target branch;
- `main`: authoritative current project state.

`docs/ROADMAP.md` defines milestone intent and acceptance criteria. GitHub Issues define live execution. Do not duplicate active TODO state in chat or external notes.