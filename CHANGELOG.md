# Changelog

All notable changes to DeepSeek Harness CLI are recorded here. The project uses
semantic prerelease versions; public alpha builds are published under the npm
`alpha` dist-tag rather than `latest`.

## Unreleased

### Added

- read-only, workspace-scoped Harness JSONL history browsing through the pinned
  public `listSnapshots()` and `inspect()` APIs, with bounded in-memory
  projections and per-session corruption diagnostics;
- `/history` and review-first `/history ask`, which injects only explicitly
  confirmed message sequences into a fresh ordinary Harness session and keeps
  source session/sequence citations;
- `/context`, `/prompt` and `/permissions` views that distinguish local
  requested projections from runtime-observed facts and leave unsupported
  runtime inspection and approval answering fail-closed;
- `doctor` capability-matrix findings plus a matching interactive startup
  warning when Windows `TEMP`/`TMP` is inside the workspace and prevents the
  Harness shell sandbox from creating its external temporary root.

### Fixed

- calculate the terminal cache percentage from total disjoint Harness input
  counts, keeping it bounded at 100%, and show the selected session's latest
  total request input instead of only its uncached portion.
- preserve the user's `TEMP`/`TMP` and the upstream sandbox policy while
  explaining the Windows shell failure instead of reporting pwsh as generally
  unavailable;
- make plugin installation transactional across dependencies, lockfiles and
  shims by trialing immutable candidate profiles before an atomic workspace
  patch switch; failed upgrades leave the last cold-startable version active;
- reject concurrent activity in one Harness session and quarantine a session
  whose prior request ended without an observed idle boundary;
- retain and drain every superseded Harness runtime, surfacing close failures
  instead of losing ownership after repeated restarts;
- classify tool calls/results without a real call ID as unknown events instead
  of correlating unrelated activity through a fabricated `unknown-call` ID.

## 0.1.0-alpha.5 — 2026-08-24

Completes the M6 Plugin Workbench persistence and regression slice.

### Added

- documented temporary-prototype to normal source package/workspace patch and
  post-restart verification workflow;
- credential-free replay fixture captured from the official Cordis lifecycle
  wire;
- full host-only weather-style lifecycle acceptance, including immutable update,
  dynamic tool invocation, stop and undefine.

## 0.1.0-alpha.4 — 2026-08-24

Adds the terminal Workbench and lifecycle debugging slice.

### Added

- dev-only `/workbench` observed lifecycle timeline;
- specialized safe renderers for the seven pinned official Cordis tools;
- `/trace cordis`, `/trace plugin` and `/trace service` filters over structured
  call arguments and public result metadata.

## 0.1.0-alpha.3 — 2026-08-24

Adds the trusted developer-mode vertical slice.

### Added

- interactive-TTY-only `dshc --dev` and credential-free `dshc doctor --dev`;
- ordered shipped base → built-in developer patch → workspace patch composition;
- exact official `dsh-cordis-host-runner` and `dsh-tool-cordis` `0.1.1-rc.2`
  dependencies and a developer persona for ordinary Cordis packages;
- permanent warning that dynamic code has process-wide authority, the VM is not
  a security boundary and definitions disappear on restart.

## 0.1.0-alpha.2 — 2026-08-24

First publishable community alpha.

### Fixed

- moved the npm identity to `@liaosiyuan123/dshc` after npm rejected the
  available unscoped `dshc` name under its package-name similarity policy;
- retained the short `dshc` executable and all alpha.1 runtime behavior;
- advanced the immutable release tag instead of retargeting the failed
  `v0.1.0-alpha.1` publication attempt.

## 0.1.0-alpha.1 — 2026-08-24

Unpublished release candidate. Its tarball passed the complete release matrix,
but npm rejected the unscoped package name before creating a package or version.

### Added

- npm package identity candidate `dshc`, exposing the `dshc` executable;
- fresh global install, repair/update and uninstall validation from the packed
  tarball on Windows, macOS and Linux;
- staged npm publishing with OIDC provenance, human 2FA approval and a draft
  GitHub prerelease built from the same tested tarball;
- install, compatibility, diagnostics, demo and release-maintainer guides;
- composition patches, image understanding, Harness-owned web research, MCP
  bridging and restricted self-service installation of exact `@deepseek-ai/`
  Harness plugins;
- a raw official event-contract gate covering successful and failed tool
  results.

### Compatibility

- all direct `@deepseek-ai/dsh-*` dependencies are pinned to `0.1.1-rc.2`;
- SDK runtime identity `deepseek-harness-sdk-runtime`, protocol `0.0.1`;
- Node.js `^22.19.0 || >=24.0.0`;
- Windows/Node 24, macOS/Node 24, Ubuntu/Node 24 and Ubuntu/Node 22.19 are
  blocking release environments.

### Security

- the shipped runtime remains `workspace-write`, fails closed when its sandbox
  is unavailable and does not invent a client-side approval channel;
- diagnostics report credential presence only and the package declares its
  filesystem/shell coding capabilities in `DISCLOSURE`;
- `js-yaml` is pinned to `4.3.1`, satisfying the Harness `^4.2.0` range while
  removing the quadratic merge-key and `!!omap` CPU denial-of-service findings;
- npm's first publication necessarily created `latest` for alpha.2; installation
  and updates must therefore name `@alpha` explicitly, and later automation does
  not publish against `latest`.

### Known limitations

- this is an unofficial community alpha and is not intended for
  security-sensitive production use;
- protocol `0.0.1` has no per-prompt cancel, per-session close, server-to-client
  approval request or authoritative complete runtime-plugin inventory;
- sandbox enforcement may be reported as partial on some hosts; dshc preserves
  that upstream truth;
- the terminal plugin plane remains first-party only. `/plugin install` changes
  the Harness composition and accepts exact `@deepseek-ai/` packages only.
