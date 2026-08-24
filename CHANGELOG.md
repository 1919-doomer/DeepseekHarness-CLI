# Changelog

All notable changes to DeepSeek Harness CLI are recorded here. The project uses
semantic prerelease versions; public alpha builds are published under the npm
`alpha` dist-tag rather than `latest`.

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
- npm releases use the `alpha` dist-tag and never silently move `latest`.

### Known limitations

- this is an unofficial community alpha and is not intended for
  security-sensitive production use;
- protocol `0.0.1` has no per-prompt cancel, per-session close, server-to-client
  approval request or authoritative complete runtime-plugin inventory;
- sandbox enforcement may be reported as partial on some hosts; dshc preserves
  that upstream truth;
- the terminal plugin plane remains first-party only. `/plugin install` changes
  the Harness composition and accepts exact `@deepseek-ai/` packages only.
