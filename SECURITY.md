# Security policy

DeepSeek Harness CLI is pre-alpha and not yet ready for security-sensitive production use.

## Sensitive bug classes

Please treat the following as security-sensitive:

- terminal escape-sequence injection;
- credential/API-key leakage;
- unintended command execution;
- subprocess environment leakage;
- approval-state spoofing or hidden state-changing tool execution;
- path traversal or unsafe file handling introduced by this project;
- runtime process cleanup bugs that leave privileged child processes running.

## Reporting

Until a dedicated private security-reporting channel is configured, do not post real secrets, tokens, private repository contents, or weaponized credential material in public GitHub Issues.

For non-sensitive bugs, use normal GitHub Issues.

## Project security invariants

- Untrusted model/tool/repository text must be sanitized before terminal rendering.
- API keys and full environments must not be included in default logs.
- Runtime diagnostics must redact exact sensitive environment values against the environment actually supplied to the Harness child. `HarnessRuntimeOptions.env` is an incremental patch for the default launch; an explicit `launchOverride.env` is authoritative, while an override without `env` inherits `process.env`.
- Diagnostic redaction and child launch environment semantics must not diverge: callers must never need to duplicate the full parent environment merely to preserve credential scrubbing.
- State-changing tool activity must remain visible to the user.
- The TUI must not silently override upstream approval decisions.
- Harness stdout is reserved for JSON-RPC when using the SDK runtime.
- The shipped coding runtime must use DeepSeek Harness sandbox/policy implementations for filesystem and shell write authority rather than duplicating path or command permissions in dshc.
- The shipped default file-effect policy is `workspace-write`, never implicit `danger-full-access`. The authoritative workspace boundary is the Harness session cwd. Upstream `workspace-write` also permits documented platform temporary roots (`/tmp` and `os.tmpdir()` where applicable); dshc must not describe those roots as denied.
- `workspace-write` is a file-effect boundary, not a promise of network isolation or general process invisibility. Filesystem reads remain available under the pinned upstream filesystem sandbox in all modes.
- Platform sandbox enforcement may report partial capability on some Windows or Linux hosts. dshc must preserve that truth rather than relabel partial enforcement as complete isolation.
- Permission escalation remains Harness-owned. Under SDK protocol `0.0.1`, dshc has no supported server-to-client approval-request transport, so it must not fabricate a local approval decision. With the shipped `ask` approval policy and no Harness-side answerer, an attempted wider `danger-full-access` retry must fail closed and must not execute.
- Sandbox unavailability must fail closed. The terminal must never silently fall back from a configured sandboxed executor/backend to the corresponding unconfined local executor.

## M4 validated default

The M4 default composition uses the pinned DeepSeek Harness `0.1.0-rc.8` security seams:

- `@deepseek-ai/dsh-sandbox-local`;
- `@deepseek-ai/dsh-sandbox-policy` with `workspace-write`;
- `@deepseek-ai/dsh-user-approval` with `ask`;
- `@deepseek-ai/dsh-fs-sandbox`;
- `@deepseek-ai/dsh-bash-sandbox` on POSIX;
- `@deepseek-ai/dsh-pwsh-sandbox` on Windows.

Credential-free official-runtime CI exercises repository-local read/edit/shell work and adversarial writes to sibling paths located outside both the session workspace and upstream temporary-root allowlist. The same gate verifies an explicit `danger-full-access` retry cannot create the target when no approval answerer exists.

These requirements are release blockers for the first public alpha.
