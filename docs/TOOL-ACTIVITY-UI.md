# M4.5 — Tool activity presentation and runtime configuration

The contract for making DeepSeek Harness tool activity legible in the terminal,
and for letting a user reach DSH's configurability from `dshc` without `dshc`
taking ownership of what that configuration means.

Design decisions here are binding on implementation. Where a decision was made
by the project owner rather than derived, it is marked **[owner]**.

## Goal

Two complaints drive this:

1. A tool call is barely visible. It renders as a plain line, and until #85 the
   result was not rendered at all — a failed call looked like a success.
2. Once output scrolls past the viewport it is unreachable (#94), so the answer
   to "what did it actually do?" is gone.

The answer is a persistent, condensed projection of tool activity that survives
scrolling, plus inline blocks that make each call and its outcome obvious at a
glance.

## What already exists

- `src/plugins/coding.ts` already parses tool arguments per tool and produces
  titles such as `read · src/stats.js`, `edit · path`, `grep · pattern`,
  `bash · description`, `todo · N items`, for the validated shipped tool set.
- Transcript blocks carry `state: running | success | error | finished` and
  `foldable`.
- `isError` became trustworthy in #85, so success and failure are distinguishable
  for the first time.
- `/trace` is already a queryable, paged, bounded timeline with explicit
  eviction disclosure.

What is missing is prominence, persistence, and result-side facts.

## Upstream facts currently discarded

`normalizeNotification` reads only `type` and `data` from the event envelope.
The envelope also carries:

| Field | Meaning | Use |
|---|---|---|
| `time` | upstream event timestamp (ms) | duration, computed from upstream time rather than local observation |
| `seq` | upstream event sequence | distinct from dshc's local `sequence` counter |
| `sourceEventSeqs` | events this one derives from | a `tool/result` links back to its `tool/call` |

Duration **must** be derived from upstream `time`, not from when dshc happened
to observe the notification. A locally measured interval would include transport
and scheduling delay and would be a dshc-invented number presented as a fact
about the tool.

`sourceEventSeqs` is a stronger correlation than matching `callId`, and is
public. Where present it should be preferred; `(sessionId, callId)` remains the
fallback, because tool identity is never `callId` alone.

## Decisions

- **[owner]** The sidebar is a persistent condensed `/trace`, **on by default**,
  toggleable.
- **[owner]** Subagent activity is indented under its parent.
- **[owner]** An entry can be selected to view its detail.
- **[owner]** Failures are marked in red — *and* in text, see below.
- **[owner]** Duration is displayed.
- **[owner]** Runtime configuration is in scope, including composition editing.

## Layout

```text
┌ transcript ──────────────────────────────┬ tools ───────────────┐
│ assistant> …                             │ ✓ read  package.json │
│                                          │ ✓ read  src/stats.js │
│ ▸ read · src/stats.js           running  │   ✓ grep  median     │
│ ✓ edit · src/stats.js       ok    0.3s   │ ✎ edit  src/stats.js │
│   ▸ 18 folded lines                      │ ✗ bash  npm test     │
│ ✗ bash · npm test        exit 1   2.1s   │ ───────────────────  │
│                                          │ 5 calls · 4 ok · 1 ✗ │
└──────────────────────────────────────────┴──────────────────────┘
```

Rules:

- The sidebar is a **fixed column width**, never a percentage, so transcript
  rewrapping does not depend on content.
- Sidebar rows **never wrap**. One call is one row, hard-cropped on a grapheme
  boundary. All layout complexity stays on the transcript side. This is
  deliberate: #92 was a row-measurement bug, and a two-column layout doubles the
  surface for that class.
- Below a column threshold the sidebar **collapses** rather than squeezing the
  transcript, per the DESIGN.md invariant that narrow terminals preserve the
  newest useful activity and never corrupt the input area. Collapsed state falls
  back to inline status only, and says so once rather than silently.
- Indentation depth is bounded. Beyond the bound, depth is indicated
  numerically rather than by ever-growing indent.

## Truthfulness rules

These are not style preferences; they follow from DESIGN.md.

- **Colour is never the only carrier.** `✓ / ✗ / ▸` always accompany a word
  (`ok`, `exit 1`, `running`). Correctness cannot depend on colour or an
  icon-only meaning.
- **Only argument-derived facts.** The target shown for a call comes from the
  arguments the model actually sent — a `file_path`, a `pattern`, a `command`.
  Deriving "modified 3 lines" by parsing an `edit` result would be dshc
  inventing tool semantics, which the two-plane split forbids.
- **Durations are upstream-derived** and are wall-clock spans between two public
  events, not a claim about compute time.
- **Sizes are retained sizes.** Retention may already have truncated a result;
  a truncated length must never be presented as the real one.
- **Eviction is disclosed.** When retention has dropped entries the sidebar says
  so, exactly as `/trace` does. A bounded window must never look complete.
- **Unknown tools degrade, they do not disappear.** A tool with no specialized
  presentation still gets a row with its name and outcome.
- **Broken relationships stay partial.** If a parent is evicted while a child
  remains, the child is shown as orphaned rather than reattached to something
  else, matching how `/agents` refuses to invent links.

## Focus and keys

Selection means the sidebar can hold keyboard focus, which is the part most
likely to be done badly.

- Focus is **always visibly indicated**; the user must never have to guess
  whether Up means "previous prompt" or "previous tool call".
- Arrow keys stay bound to prompt history while focus is in the editor. They
  move the selection only while focus is in the sidebar.
- Focus toggles with an explicit key, and the binding is discoverable from
  `/help` rather than only from documentation.
- Selecting an entry opens its detail through the existing view plane, so there
  is one way to show a full-screen panel rather than two.

## Relationship to `/trace`

The sidebar is a projection of the same data `/trace` queries, not a second
implementation. Shared query and formatting code; the sidebar adds only layout.

Consequently the sidebar can show nothing `/trace` cannot. Duration is added to
the event model first, so both surfaces gain it together.

## Runtime configuration

DSH is plugin-first and highly configurable. `dshc` should make that reachable.
The constraint is the boundary: `dshc` must not *silently* change model routing,
tool semantics, approval or sandbox policy. A user explicitly changing
configuration through a visible surface is not the same thing as `dshc` quietly
redefining semantics — the first is what a control plane is for.

**Protocol `0.0.1` has no configuration transport.** `initialize` is the only
configuration point, and it takes workspace, provider, model and maxTokens. So
every configuration change is *edit and restart the owned runtime*, and that
restart starts a new session. This must be stated in the UI; a user must never
believe their context survived a configuration change.

### Tier 1 — inspect

Extend `/plugins` from "which plugins are mounted" to the settings surface DSH
actually exposes: namespaces, current values where observable, and an explicit
statement of what protocol `0.0.1` cannot tell us. Read-only, no risk, and it
directly serves "the freedom should be visible".

### Tier 2 — initialize parameters

Provider, model, maxTokens and workspace are protocol-supported. Offer them as
commands that restart the owned runtime and re-handshake. Runtime lifecycle is
already `dshc`-owned, so this crosses no boundary. The session loss must be
stated before the restart, not after.

### Tier 3 — composition

The valuable one, and the one with a trap: **`dshc` must not encode upstream
plugin settings schemas.** A form offering `reasoningEffort: off | low | high |
max` duplicates an upstream schema inside `dshc`, and an upstream release
changes it into a lie. Two defects this project already shipped came from
exactly that coupling — a payload shape assumed rather than observed (#84) and
an event type that had moved on (#83).

So `dshc` manages the *file and the lifecycle*, never the meaning:

- show which composition is active and whether it is the shipped default or an
  override;
- fork the shipped composition to a workspace-local file on request;
- restart against a chosen composition;
- report what `doctor` concludes about the result, including the existing
  override warning that shipped capability, sandbox and approval facts may no
  longer apply.

`dshc` never parses plugin settings and never validates their values. Upstream
owns their meaning; `dshc` reports upstream's verdict.

A structured, discoverable settings surface — knowing which options exist and
what values are legal — requires upstream to expose that inventory. That is
#36, and this is its strongest use case: the `llm-deepseek` package documents a
configurable-provider directory internally, but protocol `0.0.1` does not
surface it, which is why `/plugins` correctly labels the inventory
partial/unavailable today.

## Staging

Each stage lands on its own and leaves the product working.

1. Carry upstream `time`, `seq` and `sourceEventSeqs` into the event model;
   derive tool-call duration; surface it in `/trace`.
2. Inline prominence: glyph, word, target, outcome, duration, folded output.
3. Sidebar, read-only: layout, default on, width threshold, indentation,
   counters, eviction disclosure.
4. Sidebar focus, selection and detail through the view plane.
5. Tier 1 inspection, then tier 2 initialize parameters.
6. Tier 3 composition fork and reload.

Stages 1 through 4 are presentation and cross no boundary. Stages 5 and 6 change
what the runtime is configured with and need the session-loss disclosure to land
with them, not after.

## Out of scope

- Interpreting tool results to summarise what changed.
- Any settings schema for upstream plugins inside `dshc`.
- Live reconfiguration without a restart, which the protocol does not offer.
- Session resume across a restart, which belongs with the session browser in the
  post-alpha backlog.
