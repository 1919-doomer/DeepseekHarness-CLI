# Deployment persona and role subagents

Two parts of the shipped composition decide what the model knows about where it
is standing. Both live in `runtime/cordis.yml`; neither adds agent machinery to
dshc.

## The deployment persona

Harness already tells the model a great deal. `dsh-sandbox-policy` contributes
the current file policy and the workspace root, `dsh-user-approval` contributes
the policy sentence, every tool plugin contributes its own guidance, and
`dsh-agent-instructions` loads `AGENTS.md` / `CLAUDE.md` from the workspace and
`~/.dsh/AGENTS.md` from the home directory. The persona restates none of it.

What it adds is the part only dshc can know, because dshc is the half of the
system that decides it:

- which host the runtime was launched on, and therefore how paths behave;
- the absolute workspace dshc passed as `DSH_CWD`;
- that the attached client is a terminal front end which **cannot answer an
  approval prompt**, so anything needing escalation fails closed rather than
  reaching the person;
- that there is **no per-request cancel** — dshc implements Interrupt by ending
  the runtime, starting the same configuration again and selecting a fresh
  session; the interrupted session cannot be resumed;
- that the current terminal surface cannot reliably render Markdown and model
  output must target plain text;
- the proxy and npm registry configuration observed at launch — stated as
  configuration, never as reachability, because dshc does not probe the network
  and a proxy variable being set is not evidence that the proxy works. A proxy
  URL's credentials are stripped where it is read, not where it is displayed.

Left unsaid, a model infers a friendlier deployment than this one. It asks for
sandbox escalation nobody can answer, emits formatting the terminal cannot
reliably present, or mistakes runtime replacement for resumable cancellation.

The text is built in [`src/upstream/persona.ts`](../src/upstream/persona.ts) and
reaches the child through `DSH_SYSTEM_PROMPT`, which the composition reads.

### Where the composition comes from

The shipped composition remains the base. `/config fork` creates the optional
`<workspace>/.dshc/cordis.patch.yml` layer; it never copies or shadows the base.
An explicit `--runtime-config` selects another base and does not inherit the
workspace patch. `/config` shows base, patch and effective requested entries.

An explicit `--runtime-config` is never second-guessed. If the named file does
not exist the launch fails naming it, rather than quietly starting a different
composition than the one that was asked for.

### Approval policy

The shipped composition sets `approval: never`, and that is a truthfulness
decision rather than a security one. Protocol 0.0.1 carries no server-to-client
approval request and dshc cannot answer one, so no answerer exists at all. Under
`ask`, upstream tells the model it may ask through configured answerers and every
escalation then fails closed in silence — the model spends a round trip finding
out that the prompt it was promised does not exist. Under `never`, upstream says
plainly that approval is disabled and that escalation must not be requested.

Revisit when a real answerer becomes possible (#36).

### Replacing it

Set `DSH_SYSTEM_PROMPT` yourself and dshc leaves it alone — a person who wrote
their own persona did so to replace this one, not to be merged with it.

```bash
DSH_SYSTEM_PROMPT="$(cat my-persona.txt)" dshc
```

### Two rules for editing it

1. **No `{{variable}}` references.** `dsh-system-prompt` interpolates strictly
   and throws on an unknown or undefined reference, so a stray `{{` fails every
   assembly rather than degrading. Facts are substituted in TypeScript, where a
   missing one is a type error.
2. **No upstream settings.** A sentence about `reasoningEffort` or a compaction
   ratio would duplicate a schema dshc does not own, and would turn upstream's
   next release into our lie. That coupling is what produced #83 and #84.

## Role subagents

`scout`, `planner`, `reviewer` and `oracle` are mounted as four additional
`dsh-tool-subagent` instances, adapted from a hand-tuned pi subagent fleet. They
join the generic `subagent` tool, which keeps the full toolset and covers the
implementer role.

| Tool | For | Tools it keeps |
|---|---|---|
| `scout` | Mapping an unfamiliar codebase fast | `read`, `glob`, `grep` |
| `planner` | Turning a goal into a stepwise plan with a blast radius | `read`, `glob`, `grep` |
| `reviewer` | Independent critique with a verdict and severities | `read`, `glob`, `grep` |
| `oracle` | Second opinion: challenge the assumption, name the blind spot | `read`, `glob`, `grep` |
| `vision` | Inspect real image evidence | `read`, `read_image`, `glob`, `grep` |
| `researcher` | Research primary web sources | `read`, `glob`, `grep`, `web_search`, `web_fetch` |
| `subagent` | General delegation, including changes | everything |

Each role answers in the language its task was written in, so a Chinese session
gets Chinese reports without the shipped composition mandating one language.

### What was deliberately not ported

The pi fleet is roughly eighteen thousand lines: lanes, waves, admission
control, token budgets, worktrees, terminal windows and a plan mode. None of it
came across, because `ctx.subagents` already owns delegation and a second
scheduler inside dshc would be the exact boundary violation this project has
refused for four milestones. What was worth taking was the role library — the
prompts — and upstream supports exactly that through per-instance `persona`.

Per-role reasoning effort is still not exposed: `agentOptions` carries provider,
model and maxTokens, while reasoning effort is global plugin configuration. The
vision and researcher roles are now real upstream subagent mounts, not terminal
schedulers.

### Editing the allow-lists

`toolFilter.allow` names **global** tools, and an unknown name fails when the
child starts — not when the plugin mounts, so `dshc doctor` will not catch it.
The names must match what this composition actually registers. As of the shipped
composition that set is:

```text
edit, glob, grep, oracle, planner, pwsh (bash on POSIX), read,
reviewer, scout, skill, subagent, todo_write, write
```

The only reliable check is to call the role once for real. Adding `read_image`
to these lists passed the whole test suite, passed `doctor`, and failed on the
first live call with `tools.restrict() names unknown global tool "read_image"` —
which is why the release gate for a composition change is a live invocation, not
a green suite.

An allow-list that contains no subagent tool is also what stops a role
delegating further; that is intentional, not an omission.
