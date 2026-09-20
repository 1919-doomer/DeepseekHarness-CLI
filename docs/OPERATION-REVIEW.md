# Operation review

After a turn that changed something, dshc can have a second, read-only session
check the work: does what was done match what was asked, what the agent said it
would do (`outline_plan`), and what it claims in its closing summary? The answer
lands in the transcript as one block, and the sidebar shows its state.

It is on by default. `/audit` shows the state and the cost; `/audit off` and
`/audit on` switch it, saved in the workspace settings as `operationReview`.

## What triggers a review

A root turn is reviewed when it — or a subagent under it — made at least one call
that may have changed something:

- `write` or `edit`;
- a `pwsh`/`bash` command that is not proven read-only (see below);
- an MCP tool, or any tool dshc does not know.

Reading, searching, web lookups, delegating, declaring a plan and asking
questions do not count. A turn that only explored is not reviewed.

A shell command counts as read-only only when every part of it only looks:
listings, reads, searches, `git status/diff/log/show`, version queries, `npm ls`,
PowerShell's `Get-*`/`Test-*`/`Select-*`/`Format-*` family and similar. A redirect
into a file, a state-changing .NET call (`[IO.File]::WriteAllText`,
`.Delete()`), an unknown command, running tests or building all count as
possibly changing. The list is deliberately short: a spare review costs less
than a missed one.

Measured over 226 turns in local session logs, 80 (35%) would have been
reviewed; that is about half of the turns that used any tool.

## What the reviewer sees and can do

The reviewer gets an evidence block collected from the turn's own events: the
request and anything added while it ran, the declared plan, every operation with
its outcome, an excerpt of the arguments and output for calls that changed
something (long output keeps its head and tail), the bracketed risk hints, and the
closing summary. Everything is bounded; what was left out is stated.

It runs as its own session in the same runtime, with a fresh `review-<hex>` id
per review. Before its first prompt, dshc registers that id over the private,
token-authenticated loopback channel, and the runtime creates the agent with only
`read`, `glob` and `grep` — the smallest set upstream allows — plus a guard that
denies everything else. That holds in code mode, where every other session may
write, and survives mode switches. A session that already exists cannot be
registered afterwards. If the runtime has no private channel, dshc does not
start a reviewer at all and says so once.

The review session never joins the interaction bridge, so it cannot ask a
question and does not disturb the plan shown for the conversation. It does not
appear in `/history`; `dshc logs` lists it marked `(operation review)`.

## What it reports

Four kinds of problem, at most five lines:

| Kind | zh-CN | Meaning |
|---|---|---|
| `plan` | 计划 | a change no declared step covers, or a declared step not carried out |
| `risk` | 风险 | an operation deserving attention that the task did not need |
| `claim` | 说法不符 | a statement in the summary the evidence contradicts or does not support |
| `failure` | 失败未提 | a failed operation the summary does not mention |

Anything the reviewer checked and found fine goes into its one-sentence summary,
not the list. Lines that dismiss themselves ("not an issue") are dropped. A reply
that ignores the format is shown as received rather than given an invented
verdict.

## Scheduling and cost

One review runs at a time, beside whatever happens next; it never holds up the
conversation. A turn that finishes while one runs waits; if a third finishes,
the waiting one is dropped and the transcript says which turn was not reviewed.

Each review is one more model call on the same model and effort as the session,
because protocol 0.0.1 gives dshc no way to choose another for one session. The
reviewer may add a few read-only tool calls to verify a point.

## What it is not

The review is reported to the person and never fed back to the agent; to act on
it, say so in the conversation. It blocks nothing and approves nothing. It is a
second reading of recorded evidence by the same kind of model, and it can be
wrong in both directions.
