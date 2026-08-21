# Pre-alpha security review

This document records the M4 security gate required by #18: a review of the
implementation against the invariants in root `SECURITY.md`, `docs/DESIGN.md`
and `docs/DEVELOPMENT.md`.

It is a findings document, not a policy document. `SECURITY.md` states what must
be true; this states what was checked, how, and what was found.

- Reviewed at: `main` after #85 and #86.
- Upstream baseline: DeepSeek Harness `0.1.1-rc.1`, SDK protocol `0.0.1`.
- Platform: Windows 11 / Node 24.13.0, plus the CI matrix (Ubuntu 24, Ubuntu
  22.19, macOS, Windows).
- Provider-backed probes used a live DeepSeek key against a throwaway
  repository. Credential-free CI covers everything else.

## Verdict

No release blocker is open. Three findings are recorded below: one closed
during this review, two accepted with stated limits.

The review is scoped to the shipped default composition. A `--runtime-config`
override composes a different Harness plugin tree and is outside it.

## Method

Each release-blocker class from #18 was checked against code, against the test
suite, and — where the class only manifests at runtime — against the live
runtime with a provider key.

Reading code and tests alone was deliberately treated as insufficient. Finding 1
is the reason: a control can be implemented, tested and still never exercised on
the path it exists to protect.

## 1. Terminal escape injection — pass, with a corrected assumption

**Requirement.** Untrusted model, tool, repository and plugin text must be
inert before it can become terminal-active output. Intentional raw ANSI is
limited to dshc-owned fixed controls.

**Checked.** `sanitizeTerminalText` neutralizes C0, DEL, C1 and bidi controls,
and `stringifyTerminalSafeJson` escapes the same classes inside machine-readable
output so JSON printed to a terminal cannot carry them. Every module that writes
to a stream or renders through Ink routes untrusted text through one of the two:
`cli/main.ts`, `cli/interactive.ts`, `cli/doctor.ts`, `terminal/plain-renderer.ts`,
`terminal/transcript.ts`, `terminal/product.tsx`, `plugins/builtins.ts`,
`plugins/coding.ts`. Transcript blocks are stored inert, so a later exporter or
replay consumer cannot revive raw controls by bypassing Ink.

Covered by `tests/unit/sanitize.spec.ts`,
`tests/unit/terminal-output-security.spec.ts`,
`tests/unit/transcript-security.spec.ts` and
`tests/integration/product-security.spec.ts`.

**Live probe.** A repository file containing OSC 52 clipboard-write, SGR colour,
`CSI 2J` screen clear, BEL and a UTF-8 encoded C1 `CSI 6n` cursor-position query
was read through the real runtime and rendered. Decoding the captured output as
UTF-8 and counting codepoints rather than bytes:

```
terminal-active codepoints: NONE
```

Zero C0, DEL, C1 or bidi codepoints reached the terminal; the payload remained
visible and diagnosable in escaped form.

**Corrected assumption.** On this path the neutralization observed came from
upstream: the DSH `read` tool replaced each escape with U+241B, the printable
*symbol for escape*, before dshc saw it. dshc's own sanitizer had nothing left
to remove. So on live tool output dshc's gate is a second layer, not the first,
and the probe above does not by itself prove dshc's layer works — the unit and
integration tests, which inject through dshc's own paths, are what prove that.

Recording this because assuming the opposite would make the next regression
invisible: if upstream stopped neutralizing, only dshc's own tests would notice.

**Residual.** `#86` left one gap: while a view is open, a plain stdin chunk that
merely *contains* the close key is swallowed whole rather than closing the view
and forwarding the remainder. This is a usability edge, not an injection vector —
swallowed input is never rendered — and is documented on that PR.

## 2. Credential leakage — pass

**Requirement.** API keys and full environments must never appear in default
logs or support data. Redaction must run against the environment actually given
to the Harness child.

**Checked.** `redactSensitiveText` removes exact values of environment variables
whose names match `api_key`/`token`/`secret`/`password`/`authorization`/`credential`,
plus `Bearer <token>` and `sk-`/`api-` prefixed literals, and every runtime error
passes through `classifyRuntimeError` before surfacing. `HarnessRuntime` snapshots
the exact resolved launch environment into `diagnosticEnv` before starting the
child, so redaction cannot drift from what the child actually received — including
when `launchOverride.env` replaces the inherited environment.

**Live probe.** `dshc doctor` with a real key present reports:

```
PASS credential  DEEPSEEK_API_KEY is present in the effective Harness child environment.
```

Presence only — no value, length, prefix or fingerprint. `--json` output was
checked for the same property. `tests/integration/doctor.fake.spec.ts` asserts
credential-value non-leakage.

**Limit.** Redaction is name-driven and pattern-driven. A credential held in an
environment variable whose name matches none of the patterns, and whose value
matches no literal pattern, would not be redacted from an error string. This is
inherent to the approach; it is not a finding against the implementation, but it
does mean redaction is a mitigation rather than a guarantee.

## 3. Runtime and process cleanup — pass

**Requirement.** Deterministic child-process and terminal-state cleanup,
including under failure, with no privileged child left running.

**Checked.** `HarnessRuntime` treats closing as a terminal lifecycle decision
rather than a snapshot of the currently published client: `performClose()`
closes an already-published client, awaits an in-flight start so a late
publication cannot escape cleanup, then closes again. Startup failures unwind
the client while preserving the original error. Alternate-screen teardown is
exception-safe, and Ctrl+C closes the whole runtime rather than fabricating a
prompt-level cancel the protocol does not offer.

Covered by `tests/integration/interactive-signal.spec.ts`,
`tests/integration/runtime.fake.spec.ts` and `tests/unit/runtime-launcher.spec.ts`
across the blocking matrix.

## 4. Untrusted repository output reaching terminal controls — pass

Covered by the live probe in section 1: repository file content is the exact
vector, and it reached the terminal inert.

**Finding, now closed.** Until #85 this class was **unverifiable in practice**,
because no tool result was ever rendered. `tool/result` payloads were parsed
against a shape the runtime does not send, so every result projected as
`unknown-call` with empty text. The injection gates added in #69 were real and
tested, but the live path they protect carried nothing. The fixture reinforced
the illusion by emitting the same invented shape the parser expected, so the
suite stayed green.

The same defect made `isError` permanently false, so a failed tool call rendered
as a success — a direct breach of `DESIGN.md` invariant 6, *user-visible
state-changing tool activity remains inspectable*. Both are fixed in #85 and
regression-tested against the captured live payload.

The lesson is the general one: a closed loop between fixture and parser can hold
a whole suite green while the product is broken against the real wire. Section 1
of this review exists in its current form because of it.

## 5. Approval and sandbox semantics — pass

**Requirement.** dshc must not silently weaken upstream approval or sandbox
policy, must not fabricate approval decisions, and must fail closed when
escalation is unavailable.

**Checked.** dshc composes upstream policy plugins and implements no path or
command permission logic of its own. The shipped default is `workspace-write`
with `ask`; `danger-full-access` is never an implicit fallback. Protocol `0.0.1`
has no server-to-client approval transport, and dshc does not invent one.

**Live probe.** During the #13 acceptance task the agent hit `spawn EPERM` when
the sandbox blocked the test runner's child-process pipes, retried with an
explicit `danger-full-access` escalation and a justification, and the escalation
**failed closed** — no approval channel exists, so it did not execute. The agent
then completed the task within the sandbox. This is the documented behavior,
observed rather than assumed.

Covered by `tests/integration/official-sandbox-policy.spec.ts`, which also
exercises adversarial writes to sibling paths outside the workspace and the
temporary-root allowlist.

**Accepted limit.** `workspace-write` is a file-effect boundary. It is not
network isolation and not general process invisibility, and platform enforcement
may be partial on some Windows and Linux hosts. `SECURITY.md` already states
this; the review confirms dshc does not relabel partial enforcement as complete.

## 6. Third-party plugin loading — not applicable, deferred by policy

dshc loads no third-party packages. The plugin host is first-party only, and
plugin faults are contained at the terminal boundary so a presentation extension
cannot redefine runtime success or failure. The security design that must exist
before this changes is in [PLUGIN-ISOLATION.md](PLUGIN-ISOLATION.md), per #37.

## Documentation drift found

`SECURITY.md`'s *M4 validated default* section still names the pinned baseline
as `0.1.0-rc.8`. #82 moved it to `0.1.1-rc.1`. Corrected in this change.

## Open, non-blocking

- #83 — the `session/title` event introduced by `0.1.1-rc.1` is unclassified and
  falls through to `unknown`. It degrades safely and is diagnosable under
  `--debug`, so it is not a blocker.
- The `#86` residual described in section 1.

## What would reopen this gate

- any new stream or renderer path that does not route untrusted text through
  `sanitizeTerminalText` or `stringifyTerminalSafeJson`;
- any diagnostic surface added outside `classifyRuntimeError`;
- adopting a new upstream baseline without re-running the live probes above,
  since payload shapes are part of the contract (#17);
- any local approval or sandbox decision made by dshc rather than Harness;
- loading a third-party plugin before #37 has an accepted design.
