# Risk register

This register records project-level risks, not individual bugs. Update probability/impact when evidence changes.

| Risk | Probability | Impact | Mitigation / trigger |
|---|---|---|---|
| Upstream DSH protocol changes during developer preview | High | High | Exact version pin; compatibility guard; fixtures; re-review before each milestone |
| Runtime packaging/launch path is awkward for external TS consumers | Medium-High | High | Prove M1 launcher before TUI; isolate `src/upstream/runtime-launcher`; keep fallback documented |
| No prompt cancel/session close upstream | Certain today | Medium-High | Honest UX; process-level interruption only as explicit fallback; replace behind adapter if upstream adds cancel |
| Session events do not map cleanly to a simple chat transcript | Medium | High | Event-native normalized projection; avoid strict prompt/response assumptions |
| TUI framework creates cross-platform/input complexity | Medium | Medium-High | Defer framework choice to M3; prove plain CLI semantics first |
| Windows process/signal behavior causes orphaned runtimes | Medium | High | Windows blocking CI; lifecycle integration tests; bounded cleanup ladder |
| Terminal escape injection through model/tool/repo output | Medium | Critical | Sanitize renderer boundary; adversarial fixtures; pre-alpha security blocker |
| Secrets leak through stderr/debug/CI | Medium | Critical | Credential-free required CI; redaction; no full env logging; trusted manual live tests only |
| Project becomes a cosmetic Codex/Claude clone | Medium | High product risk | Differentiation doc + issue #15; feature justification must be Harness-native or terminal-workflow driven |
| Project duplicates Harness agent semantics and becomes hard to maintain | Medium | High | Thin-host invariant; no custom agent loop; upstream adapter boundary |
| Large tool/session output causes memory/render stalls | Medium | Medium | Bounded buffers; synthetic load tests; output folding in M3 |
| Naming conflicts with official `dsh` binary/package | Low-Medium | High UX/distribution | Use working binary `dshc`; finalize package name before alpha |
| Official DSH restores a maintained TUI | Unknown | High strategic | Reassess project role; differentiate through community UX/observability or stop duplicating upstream work |
| Harness public SDK remains too limited for desired approvals/resume/model switching | Medium | Medium | Gate features on supported contracts; defer rather than emulate private internals |
| Supply-chain risk from TUI/dependency stack | Medium | High | Small dependency surface; lockfile; review TUI choice; dependency security automation |

## Decision rule

A high-impact risk must be reduced by architecture/test evidence before the milestone that depends on it. Visual work must not be used to mask unresolved protocol, lifecycle, security or compatibility risk.

## Highest-priority risks before M1

1. Prove the official runtime launch path.
2. Prove JSON-RPC/event semantics against the pinned upstream version.
3. Prove deterministic process cleanup on Windows and POSIX.
4. Establish a sanitized normalized renderer boundary.

## Strategic stop condition

If DeepSeek Harness ships and maintains an official terminal frontend that covers the same interactive use case through the same runtime with equal or better extensibility, continuing `dshc` requires a newly documented differentiation. Open-source existence alone is not sufficient reason to duplicate upstream.