# ADR 0003 — Use `dshc` as the working binary name

Status: accepted for pre-alpha; review before public package release
Date: 2026-08-20

## Context

The upstream DeepSeek Harness project already owns the `dsh` executable name. A community frontend should not shadow or impersonate that command.

## Decision

Use `dshc` as the working binary name, meaning **DeepSeek Harness Console**.

The GitHub repository may retain its descriptive name while the future package name is finalized separately.

## Consequences

- avoids command collision with official `dsh`;
- makes side-by-side installation possible;
- public npm/package naming still needs an availability check before M5;
- documentation should call the application `dshc` when referring to the executable.
