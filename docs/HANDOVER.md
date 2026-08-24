# Handover

What someone picking this up needs that is not already in the code, the issues,
or the other documents here. [DESIGN.md](DESIGN.md) has the architecture,
[DEVELOPMENT.md](DEVELOPMENT.md) the toolchain and test strategy,
[PROTOCOL.md](PROTOCOL.md) the upstream contract, [ROADMAP.md](ROADMAP.md) the
milestone intent. This file is the operational knowledge that was paid for in
defects and would otherwise be lost.

## Where things stand

`0.1.0-alpha.2` is the M5 public-alpha candidate. M0 through M4.6, including the
`0.1.1-rc.2` compatibility pass, are implemented. The established
cross-platform gate remains Windows/macOS/Ubuntu against Node 22.19 and 24 and
now installs, repairs, diagnoses and uninstalls the packed npm tarball.

`main` is protected: five required status checks, strict up-to-date merges,
`enforce_admins` on, no force push, no branch deletion, zero required reviewing
approvals. `enforce_admins` is deliberate — it exists because the owner merged a
pull request with four of five checks red (#95, fixed in #96), and protection is
worth nothing if the person most likely to be in a hurry can walk past it.

The release target is `@liaosiyuan123/dshc` under the npm `alpha` dist-tag, paired
with a GitHub prerelease carrying the same tested tarball and checksum. At this
candidate stage the package still needs the owner-side first-publication 2FA
bootstrap described in `docs/RELEASE.md`.

## The rule that explains most of the code

**Harness owns agent semantics. dshc owns terminal interaction, projection,
observability and presentation.** Every awkward-looking decision in this
repository is downstream of it.

Concretely, dshc must not:

- reimplement tool, sandbox, approval or session semantics;
- encode an upstream settings schema — no enum of `reasoningEffort` values, no
  context-window constant, no compaction ratio interpreted rather than shown;
- present requested configuration as confirmed configuration.

The third one has teeth. Protocol `0.0.1` exposes no runtime plugin inventory,
so `/config` reads the composition *file* and says so in as many words. The
temptation to drop that qualifier will recur; it is the difference between a
console and a plausible-looking guess.

The reason the second rule is absolute rather than stylistic: #83 and #84 were
both caused by dshc holding a copy of an upstream shape. When upstream moved,
dshc's copy became a lie that the test suite happily confirmed.

## How to know something works

There is a ladder, and each rung exists because a rung below it once passed
while the product was broken.

1. **Unit tests** catch logic. They cannot catch a wrong payload shape, because
   the fixture and the parser are written by the same person in the same hour.
2. **`pnpm test:official-runtime`** launches the real Harness child without
   credentials. It catches launch, handshake and lifecycle breakage.
3. **`dshc doctor`** completes `initialize` against the real runtime. It proves
   the composition mounts. It does **not** prove anything that happens at a
   model step.
4. **A live invocation** — an actual turn, with a key. This is the only rung
   that proves the persona renders, that a tool filter is valid, that a tool
   result parses, or that a policy reached the model.

Rung 4 is not optional for changes to `runtime/cordis.yml`, to the persona, or
to event projection. Three examples, all real:

- `read_image` in a subagent `toolFilter` passed 209 unit tests and `doctor`
  15 pass / 0 fail, then failed on the first live call with
  `tools.restrict() names unknown global tool "read_image"`. Tool filters are
  validated when a **child starts**, not when a plugin mounts.
- The persona is assembled at the **first model step**. A strict `{{variable}}`
  failure or a wrong approval policy is invisible to `doctor`.
- #84: every live tool result projected as `unknown-call` with empty text and
  `isError` permanently false, so failed tool calls rendered as successes — for
  five commits, with the suite green, because the fixture agreed with the parser
  about a shape the wire never sends.

**Capture payloads, do not guess them.** Start the runtime, run one prompt, dump
the raw notifications, then write the parser against what came back. `usage`
turned out to be a sibling of `message`, one level above where a reasonable
person would put it.

**A test that passes with the fix reverted is not a regression guard.** Check by
actually reverting. This has caught weak tests here four times; twice the test
was written, believed, and only failed to protect anything.

## Failure modes that have actually happened here

- **Fixture/parser closed loop.** Both sides agree, the suite is green, the
  product is broken. Break the loop with captured payloads (#84).
- **Yoga compresses instead of clipping.** When an Ink column runs out of
  height, children are compressed and drawn over each other — body text over a
  header, the editor over its own hint. Every chrome element carries
  `flexShrink={0}` for this reason. Do not remove one (#100, #106).
- **Grapheme width.** Terminal width is cells, not characters. 81 CJK characters
  in 81 columns is three rows, not two. Use `terminalCellWidth` and
  `wrappedTerminalRows`; never `String.length` (#92).
- **Windows path semantics on a POSIX host.** A check written with the ambient
  `path` module silently passes on Linux for Windows path strings, because they
  contain no separators. Decide Windows rules with `win32.relative` /
  `win32.resolve` on every host (#96).
- **Diagnostics that reassure.** `doctor` once reported 13 pass / 0 fail for a
  workspace where every shell call failed, because `%TEMP%` resolved inside the
  workspace through an 8.3 short name (#91). A green check that cannot fail is
  worse than no check.
- **Colour as the only carrier.** Every outcome is a glyph *and* a word.
  Monochrome terminals and colour-blind readers are not edge cases.

## Practical traps in this environment

- **Heredocs eat backslashes.** Writing TypeScript through a shell heredoc
  turns `\\n` into a real newline and `\uXXXX` into the character, producing
  unterminated string literals. Use the Write/Edit tools, or build backslashes
  with `chr(92)`. This cost several rounds across the project.
- **`--delete-branch` on a stacked PR's base closes the PRs above it**, and they
  cannot be reopened once the base ref is gone. Push the base back, reopen,
  retarget.
- **`gh` under Git Bash rewrites arguments that look like paths.** `/plugin
  install` became `D:/Software/Git/plugin install` in an issue title. Prefix
  with `MSYS_NO_PATHCONV=1`.
- **`tsc` never deletes stale output.** `dist/` carried modules removed from
  `src/` into a release tarball. `pnpm build` now clears `dist/` first (#112);
  keep it that way.

## What is on the owner's machine

Three separate copies of DSH exist there, and only one drives dshc.

| What | Where | Version |
|---|---|---|
| dshc's runtime (the live one) | `%APPDATA%\npm\node_modules\deepseek-harness-cli\node_modules\@deepseek-ai\` | `0.1.1-rc.1` |
| dshc dev tree | `E:\ClaudeCodeUse\projects\dshc\node_modules\` | `0.1.1-rc.2` |
| Official `dsh`, unrelated to dshc | npx cache, symlinked from `~\.dsh\profiles\` | `0.1.1-rc.2` |

`~\.dsh\` belongs to the official app, not to dshc. dshc touches it at exactly
one point: `dsh-agent-instructions` loads `~/.dsh/AGENTS.md` alongside the
workspace's `AGENTS.md` / `CLAUDE.md`. Sessions land in
`$HOME/sessions/dshc/` unless `DSH_SESSION_ROOT` says otherwise.

The official app's configuration model now backs #120: the shipped file stays
authoritative and the workspace edits only `.dshc/cordis.patch.yml`, an
id-targeted Include patch list. `/config fork` creates `[]` and never copies the
base.

## The completed compatibility pass, and the next lever

Batch 2 of #114 is implemented: #120 patch layer, #121 vision subagent, #122 web
search/researcher, #123 MCP client and #124 restricted self-service plugin
install. Batch 3 (#125) then moved the complete runtime closure to
`0.1.1-rc.2`. This was a real compatibility pass, not a version edit:

- the official rc.1/rc.2 tag diff showed no source change in the SDK wire or
  core event producers, while image normalization, Files API upload/reuse and
  `read_image.originalDimensions` did change;
- a published-runtime integration test now captures one successful and one
  failed tool result from the raw rc.2 SDK notifications, including causal
  envelope fields and sibling assistant usage;
- 45 foundational auto-peers that pnpm had retained at `0.1.0-rc.8` are now
  exact direct rc.2 dependencies; the lockfile has no rc.8 residue and
  `pnpm peers check` is blocking CI.

The Batch 2 live gates were repeated against rc.2 on 2026-08-24: Web Search,
Web Fetch, a real JPEG through the vision model, `mcp__everything__echo`
through the official stdio server, and a trial-booted
`dsh-repeat-tool-reminder@0.1.1-rc.2` installation all passed. Re-run these
against the pinned closure whenever the upstream baseline moves again.

**#36 is the lever.** A DSH-side bridge plugin that dshc ships and mounts is the
single unblock for three things that are all stuck against the same wall:
approval prompts reaching a human, an honest context percentage, and a real
runtime plugin inventory. Protocol `0.0.1` carries no server-to-client
transport, and neither `rc.1` nor `rc.2` of `dsh-sdk-jsonrpc-server` adds one.
Everything currently written as "dshc cannot know this" traces back to it.

#124 has four constraints that are not negotiable, and they are in the issue:
scope limited to `@deepseek-ai/`, named confirmation before installing, a trial
boot before the new composition replaces the live one, and rollback of the patch
layer on failure. Letting a model install and execute arbitrary code inside the
Harness process is a strictly larger surface than the third-party terminal
plugins refused in #37.

## Decisions only the owner can make

- **The first npm publication.** The old unscoped `deepseek-harness-cli` name is
  occupied by an unrelated package, and npm rejected the unscoped `dshc` name
  as too similar to existing short package names. M5 therefore targets the
  public package `@liaosiyuan123/dshc`, while the executable remains `dshc`.
  The owner must control that npm scope, enable 2FA and perform the first interactive
  publication from the exact verified workflow artifact. After it exists,
  releases use stage-only Trusted Publisher/OIDC plus human 2FA approval. The
  README's unofficial notice is necessary but does not settle any trademark
  question for the owner.
- **Stale remote branches.** Around twenty from merged pull requests are still
  on the remote. Deleting them is safe but is the owner's call, not a
  housekeeping task to perform unasked.
- **Credential hygiene.** No secret is in this repository, and diagnostics
  redact by exact value. Separately, during this work a plaintext third-party
  API key was found in an unrelated local tool's config file on the owner's
  machine and reported to them; it is unrelated to dshc and was never copied
  into it. Whether it was rotated is unknown here.

## The habit worth keeping

Every defect this project has fixed that mattered was found by running the
product, not by reading it. Tool results parsed against a shape the wire never
sends, a header buried under its own body text, a health report for a broken
workspace, context silently compacted at 80% pressure, an invalid tool filter
that eleven green suites approved.

Read the code to form a hypothesis. Run the product to find out.
