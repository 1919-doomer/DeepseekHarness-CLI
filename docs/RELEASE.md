# Public-alpha release runbook

This runbook describes mechanics; GitHub Issue #14 remains the live acceptance
tracker. Never publish from an uncommitted worktree or reuse a released version
or Git tag.

## Release contract

- npm package: `@liaosiyuan123/dshc`;
- binary: `dshc`;
- prerelease channel: `alpha` (never `latest`);
- tag: `v<package.json version>`;
- the npm and GitHub assets must be the exact tarball that passed the installed
  package matrix;
- the package declares its coding shell/filesystem capability as dual-use, so
  every publication requires human 2FA presence.

## Local candidate checks

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm check
pnpm test:official-runtime
pnpm test:package
pnpm release:verify -- v0.1.0-alpha.2
```

Inspect `npm pack --dry-run --json`. The allowlisted package must contain the
built CLI/runtime, README files, changelog, license, disclosure and installation
and compatibility statements, with no source tree, tests, credentials, cache or
existing tarball.

## First package publication

npm cannot configure trusted publishing or staged publishing before a package
exists. The first version is therefore the only bootstrap exception:

1. merge the release commit and create its signed/authorized tag;
2. let `Stage public alpha` build the tarball and pass all four installed-package
   jobs, producing a draft GitHub prerelease;
3. download that exact `npm-package` workflow artifact and verify `SHA256SUMS`;
4. sign in to the npm account that owns `@liaosiyuan123/dshc`, with 2FA enabled;
5. publish the tarball interactively with
   `npm publish <tarball> --access public --tag alpha --otp=<one-time-code>`;
6. never place the OTP, session token or npm configuration in the repository;
7. run `Finalize public alpha` with the exact tag. It refuses to announce the
   GitHub release unless npm exposes both the version and matching `alpha` tag.

## Subsequent alpha publication

After the bootstrap version exists:

1. configure npm Trusted Publisher for this public repository and
   `.github/workflows/release.yml`, allowing **stage publish only**;
2. set package publishing access to require 2FA and disallow traditional tokens;
3. push the matching protected alpha tag;
4. the workflow builds once, validates the same tarball on the blocking matrix,
   stages it with OIDC provenance and creates a draft GitHub prerelease;
5. inspect and approve the npm staged package with 2FA;
6. run `Finalize public alpha` for the tag.

The staged path requires npm CLI 11.15 or newer. The workflow pins npm 11.19.0
and immutable commits for all third-party GitHub Actions.

## Failure and rollback

- before npm approval, reject the staged version and leave/delete the draft;
- after publication, never overwrite or reuse the version: publish a new alpha
  and move the `alpha` dist-tag;
- deprecate a bad version with a precise migration message instead of relying on
  unpublish;
- never make a GitHub release public before the exact npm version and `alpha`
  dist-tag are visible on the official registry;
- mirror delay is not evidence that the official publication failed.
