# Threat model

This is a pre-implementation threat model for `dshc`. It focuses on risks introduced by the terminal host; it does not replace the upstream DeepSeek Harness security model.

## Assets to protect

- API/provider credentials and environment secrets;
- repository source and user files;
- integrity of commands/files changed by the agent;
- terminal/user session integrity;
- correctness of what the UI claims happened;
- host process and child-process lifecycle;
- session metadata and diagnostic logs.

## Trust boundaries

1. **User terminal -> dshc**: user input and local commands.
2. **dshc -> Harness runtime subprocess**: stdio JSON-RPC plus process control.
3. **Harness runtime -> models/tools/repository**: upstream-owned agent boundary.
4. **Harness notifications -> dshc renderer**: model/tool/repository content becomes terminal display data.
5. **Environment/config -> process launch**: credentials and executable/config paths.
6. **GitHub/npm dependencies -> installed host**: software supply chain.

## Threats and controls

### Terminal escape/control injection

Threat: model output, tool output, filenames or repository text contains ANSI/OSC/control sequences that alter terminal state, create misleading hyperlinks, set titles, manipulate clipboard-capable terminals, or visually spoof output.

Controls:

- treat all upstream/repository content as untrusted display text;
- sanitize at the renderer boundary;
- generate styling codes only inside trusted renderer code;
- test adversarial ANSI/OSC/control fixtures;
- preserve a plain/non-TTY output path.

Release severity: **blocker**.

### Credential leakage

Threat: API keys/environment secrets appear in debug logs, error messages, child stderr, crash reports or GitHub Actions artifacts.

Controls:

- do not own a custom credential vault before alpha;
- redact known credential fields/patterns in diagnostics;
- never log full environment maps;
- required CI runs without provider secrets;
- credentialed tests are trusted/manual only;
- raw model/tool content is not debug-logged by default.

Release severity: **blocker**.

### Protocol confusion / false UI claims

Threat: the frontend treats an enqueue receipt as a response, claims successful cancellation that did not occur, misattributes subagent/root events, or silently ignores protocol drift.

Controls:

- preserve current wire semantics in local types;
- fail loudly on incompatible protocol/runtime versions;
- fixture-test ordering and unrelated-session traffic;
- user-visible wording avoids unsupported guarantees.

Release severity: high.

### Runtime subprocess escape/orphaning

Threat: child process survives terminal exit, hangs indefinitely, or receives unsafe signal/process behavior across platforms.

Controls:

- bounded startup/request/shutdown timeouts;
- graceful shutdown followed by documented escalation;
- explicit Windows/POSIX tests;
- reap child on all exception/failure paths;
- never interpret process kill as prompt-level cancellation.

Release severity: high/blocker when reproducible.

### Unsafe executable/config resolution

Threat: a malicious repository influences which runtime binary/config is executed.

Controls:

- use explicit/pinned official runtime resolution strategy;
- avoid blindly executing repository-local binaries/config solely by name;
- display or log scrubbed runtime resolution metadata in debug mode;
- validate config paths and working directory assumptions.

Release severity: high.

### Approval/sandbox downgrade

Threat: the terminal host auto-approves, bypasses or obscures an upstream safety/approval decision.

Controls:

- preserve upstream approval/sandbox semantics;
- do not implement 'always approve' in the presentation layer by default;
- state-changing tools remain inspectable;
- if future SDK server->client approval requests are introduced, design the terminal flow explicitly before enabling them.

Release severity: blocker for silent downgrade.

### Untrusted repository/prompt content

Threat: prompt injection in repository files causes the model to perform undesired actions.

Boundary note: the Harness agent/tool policy primarily owns this risk. `dshc` must not imply that sanitized terminal rendering makes repository content safe for the model. The frontend's responsibility is to keep actions observable and not weaken upstream controls.

### Resource exhaustion

Threat: huge streaming/tool output consumes memory, CPU or terminal scrollback indefinitely.

Controls:

- bounded streaming buffers;
- fold/limit presentation of huge output while preserving access where feasible;
- synthetic long-stream tests;
- avoid retaining duplicate raw and projected data unnecessarily.

### Dependency/supply-chain compromise

Controls:

- minimize dependency surface, especially before M3;
- lock dependencies with pnpm lockfile in M1;
- review runtime/TUI packages before introduction;
- use GitHub dependency/security automation when available;
- do not run provider-secret workflows on untrusted contributions.

## Security invariants

- untrusted text never reaches the terminal as active control sequences;
- credentials are not logged by default;
- stdout of the owned Harness JSON-RPC process remains protocol-only;
- UI never silently weakens upstream permissions/sandbox/approval semantics;
- runtime/version drift never silently changes protocol meaning;
- child processes are not intentionally left behind;
- security-sensitive changes update this document and SECURITY.md.

## Review points

Revisit this threat model at:

- completion of M1 lifecycle/protocol implementation;
- M3 full-screen TUI framework choice;
- any credential-storage feature;
- any remote runtime feature;
- any terminal approval flow;
- M4 pre-alpha security review.