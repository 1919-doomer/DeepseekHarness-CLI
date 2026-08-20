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

These requirements are release blockers for the first public alpha.
