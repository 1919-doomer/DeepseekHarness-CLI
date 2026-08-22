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
- that there is **no per-request cancel** — interrupting ends the runtime and
  the session with it, so a hung command costs the whole conversation;
- that the output is read in a terminal.

Left unsaid, a model infers a friendlier deployment than this one. It asks for
sandbox escalation nobody can answer, or starts a command that can only be
stopped by killing the session.

The text is built in [`src/upstream/persona.ts`](../src/upstream/persona.ts) and
reaches the child through `DSH_SYSTEM_PROMPT`, which the composition reads.

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

Two capabilities of the pi version have no upstream equivalent today and were
dropped rather than faked: per-role thinking levels (`agentOptions` carries
`provider`, `model` and `maxTokens` only, and reasoning effort is global plugin
config) and the `researcher` role (the composition mounts no web search tool).

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
