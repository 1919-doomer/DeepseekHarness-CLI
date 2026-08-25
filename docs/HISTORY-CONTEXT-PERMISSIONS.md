# M7 History, Context, Prompt and Permissions

M7 adds read-only history and locally trustworthy diagnostic views without
changing the official SDK JSON-RPC protocol. Harness session artifacts remain
the only durable source of truth; dshc builds a bounded in-memory projection on
startup and never calls the persistence `load()`/resume path.

## History source and scope

The reader is pinned to
`@deepseek-ai/dsh-session-persistence-jsonl@0.1.1-rc.2` and uses only its public
`listSnapshots()` and `inspect()` methods. It does not write titles, summaries,
indexes or recovery data back to the artifact.

`/history` is scoped to the active workspace by default:

```text
/history
/history all
/history find <text>
/history open <session-id> [--cross-workspace]
```

`/history all` is the explicit cross-workspace switch. The first projection is
bounded to 200 sessions (hard maximum 500), inspects four artifacts at a time
and retains at most 500 projected messages per detail. A corrupt or changing
artifact becomes a metadata-only row with a diagnostic; other sessions remain
usable.

Inside the history view, Tab switches focus between the bounded list and its
search box. Search covers recorded workspace, ISO date, title, provider/model,
message text and tool activity; Enter applies the query, while list focus uses
arrows and Enter for detail inspection.

The SDK protocol does not expose `AgentRegistry.resume`, so this view offers no
Resume action. That limitation is shown in the view rather than approximated
with a private request.

## Ask History

Ask History creates a fresh ordinary Harness session. It never modifies or
continues the source session.

```text
/history ask <session-id> [all|seqs] [--cross-workspace] -- <question>
/history ask <session-id> [all|seqs] [--cross-workspace] --yes -- <question>
```

The first form is mandatory review: it lists exact source session/message
sequence labels, timestamps, sizes, a local token estimate and sensitive-value
warning, and sends nothing. Re-running with `--yes` injects only those selected
message events. The generated envelope labels each source as
`[session:<percent-encoded-id>#seq:<n>]`, serializes the historical text as a
JSON string value, treats it as quoted data rather than instructions, and asks
the model to retain those labels in its answer.

Evidence is limited to 64 KiB and passes through the existing terminal
sanitizer for display. Model-generated summaries are never stored or presented
as original history.

## Context and prompt views

`/context` combines local folded token totals with public runtime events. It
shows a capacity percentage only after a retained `request/context` event
actually supplies `contextWindow`; the result is clamped to 0–100%. Otherwise
it shows absolute counts and marks capacity unavailable. It also lists observed
compaction events and does not invent a warning threshold.

`/prompt` shows only layers dshc owns or requested: the built-in persona, the
developer appendix or `DSH_SYSTEM_PROMPT` override, and the requested
composition patches. Every row has an origin/authority label and character and
UTF-8 byte sizes. It is explicitly a **dshc local projection**, not the final
Harness-assembled system prompt.

## Permissions

`/permissions` is currently inspect-only. It shows the effective `ask | never`
policy when publicly observed, otherwise the shipped `never` default; retained
`approval/asked`, `approval/decided` and `approval/policy` audit events; and the
capability matrix.

Protocol `0.0.1` has no server-to-client approval answerer handshake. Therefore
dshc cannot safely offer an Allow button or switch policy to `ask`. Missing,
late, disconnected and unsupported approvals remain fail-closed. It does not
offer session-wide or persistent allow rules.

## Upstream gate

Exact capacity/reserved-output data, final assembled prompt inspection and
interactive `Allow once`/`Reject` controls remain gated on an official,
versioned and capability-negotiated Harness extension. Until that exists, dshc
does not fork the SDK server, import private subpaths, parse prose into protocol
facts or create a named-pipe side protocol.

The interaction research borrowed only broad product concepts from free-code
(history picker/search/actions, token budget/compaction reminders, prompt dump
and shell-risk explanations). No free-code source, text or assets are copied,
and risk classification is never treated as authorization.
