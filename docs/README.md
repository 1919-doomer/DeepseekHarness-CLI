# Documentation

`dshc` intentionally keeps its long-lived documentation small. GitHub Issues are the live execution tracker; closed Issues preserve historical preparation and decisions.

## Core documents

| Document | Purpose |
|---|---|
| [DESIGN.md](DESIGN.md) | Product position, architecture, terminal UX invariants, plugin philosophy and major design decisions |
| [PROTOCOL.md](PROTOCOL.md) | DeepSeek Harness JSON-RPC contract, lifecycle limitations and upstream compatibility policy |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Toolchain, source layout, implementation order, tests, security engineering and release gates |
| [ROADMAP.md](ROADMAP.md) | Milestone intent and the curated future-feature backlog |
| [SECURITY-REVIEW.md](SECURITY-REVIEW.md) | Pre-alpha security gate findings: what was checked, how, and what was found |
| [PLUGIN-ISOLATION.md](PLUGIN-ISOLATION.md) | Isolation design required before any third-party terminal plugin may be loaded |
| [TOOL-ACTIVITY-UI.md](TOOL-ACTIVITY-UI.md) | M4.5 contract for tool activity presentation and runtime configuration |
| [SUBAGENT-ROLES.md](SUBAGENT-ROLES.md) | What the shipped persona tells the model, and the role subagents mounted beside the general one |

Repository-level policies:

- [Contributing](../CONTRIBUTING.md)
- [Security](../SECURITY.md)

## Live work

- M1 runtime vertical slice: [#10](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/10)
- M2 interactive terminal loop: [#11](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/11)
- M3 terminal product/plugin layer: [#12](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/12)
- M4 hardening: [#13](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/13)
- M5 public alpha: [#14](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/14)
- Product direction: [#15](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/15)
- Upstream re-check: [#17](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/17)
- Terminal plugin host: [#32](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/32)
- Capability Explorer: [#33](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/33)
- Renderer registry: [#34](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/34)
- Session debugger/trace: [#35](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/35)
- Optional `dshc-bridge` research: [#36](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/36)
- Third-party plugin isolation: [#37](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/37)

## Authority

When sources disagree:

1. current official DeepSeek Harness public source/docs;
2. this repository's `PROTOCOL.md` for the tested upstream boundary;
3. `DESIGN.md` for local product/architecture invariants;
4. GitHub Issues/PRs for current execution state;
5. `ROADMAP.md` for milestone intent.

DeepSeek Harness is developer preview. Correct stale assumptions instead of preserving obsolete documentation.
