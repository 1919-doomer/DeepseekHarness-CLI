# Third-party terminal plugin isolation

The security design required by #37 before dshc loads any third-party terminal
plugin. Until this design is implemented, the plugin host stays first-party.

## The problem

A Node package loaded in-process holds everything the host holds. It can read
the filesystem, read `process.env` — including the provider credential — spawn
processes, open sockets, and monkey-patch the host's own modules. A permission
manifest declared by that package is a comment, not a boundary: the code that
would honour it runs with the same authority as the code that would violate it.

So the question is not *what permissions should a plugin declare*. It is *what
is a plugin structurally unable to do*.

## Threat model

The adversary is a plugin author, or whoever compromised a package the plugin
author depends on. They can publish arbitrary code that a user installs
believing it renders something nicely in a terminal.

Assets, in priority order:

1. the DeepSeek provider credential, and any other secret in the environment;
2. repository contents and the user's wider filesystem;
3. the user's terminal — a plugin that can emit raw control sequences can
   rewrite history, hijack the clipboard through OSC 52, or fake a prompt;
4. the integrity of what the user is told — a plugin that can make a failed
   tool call look successful defeats the product's reason to exist;
5. host availability — a plugin must not be able to hang or crash the session.

Explicitly out of scope: a plugin cannot be prevented from being useless, and
this design does not attempt to stop a plugin the user has deliberately given
elevated capability.

## Non-negotiables

These follow from `DESIGN.md` and are constraints on any accepted design.

1. A plugin never shares an address space with the host.
2. A plugin never receives the host environment. Not a filtered copy — none.
3. A plugin cannot reach Harness. It sees normalized presentation data, never
   the SDK client, the session, or the runtime.
4. A plugin cannot change approval, sandbox, model routing, persistence or
   subagent scheduling. These are Harness-owned and not addressable from the
   terminal plane at all.
5. Plugin output is untrusted text on exactly the same footing as model and
   tool output, and passes the same sanitization.
6. A plugin fault is a presentation fault. It can degrade its own rendering and
   nothing else.
7. Absent capability degrades visibly. A plugin that cannot do something is not
   silently replaced by something that can.

## Design

### Separate process, not worker threads

Worker threads share the process: the same environment, the same file
descriptors, the same ability to exhaust the heap and take the host with them.
`worker_threads` gives concurrency, not containment.

Each plugin therefore runs as a child process, spawned with an explicitly
constructed environment rather than an inherited one:

```text
dshc host process                     plugin process
  Harness client                        no Harness client
  credentials in env                    empty env
  terminal ownership                    no tty, no stdio inheritance
  normalized events        ──RPC──▶     pure render functions
                           ◀──RPC──     mutations / strings
```

The plugin process is started with `stdio: ['pipe', 'pipe', 'pipe']`, never
`inherit`, so it cannot write to the real terminal even accidentally. Its stdout
is the RPC channel; its stderr is captured as diagnostic text and sanitized
before it can be shown.

### Capability-based RPC, deny by default

The host exposes no ambient API. A plugin receives exactly the data its
registered surface needs, and returns data — it never performs an effect.

| Surface | Receives | Returns |
|---|---|---|
| command | `TerminalCommandContext`, args | `TerminalCommandOutcome` |
| event renderer | one `NormalizedEvent`, render context | `TranscriptMutation[]` |
| view | `TerminalViewContext` | `string` |
| status segment | `TerminalCommandContext` | `string \| undefined` |

These are the API v1 signatures the first-party host already uses, which is why
the current first-party plane is a useful rehearsal: the shapes are already
pure. Nothing in them is a handle to anything.

Capabilities a plugin might later request — reading a file, making a network
call — are host-mediated calls with explicit user consent, never direct access.
None are in the first version. Deny by default means the initial answer to every
capability request is no, and each addition is argued separately.

### Payload discipline

The host must not hand a plugin more than its surface needs. `TerminalViewContext`
currently carries the retained event tail, which includes tool arguments and
results — repository content. That is correct for a first-party view and wrong
to hand a third party by default.

Before third-party loading, view context must be projected per-plugin, with
event payloads redacted unless the plugin holds a capability for them. A plugin
that only draws a status segment must not receive repository text at all.

This is the one place where the existing first-party API needs a change rather
than a wrapper, and it should land before any loader does.

### Crash containment and resource limits

- Every RPC call has a deadline. A plugin that misses it is disabled for the
  session with a visible notice; the host renders through its generic fallback.
- A plugin that exits or fails to start is disabled the same way, once, without
  retry storms.
- Memory and CPU are bounded by OS-level limits where the platform offers them.
  Where a platform offers none, that must be reported as reduced enforcement
  rather than assumed — the same truthfulness rule the sandbox documentation
  already follows.
- A plugin can never make a Harness activity fail. The runtime result is
  computed before presentation and is not reachable from plugin code.

### Version negotiation

The host advertises an API version; a plugin declares the version it targets and
is refused if the host cannot serve it. Refusal is explicit and visible, never a
silent downgrade into partial behavior. This is the existing `apiVersion` check,
moved across the process boundary.

### Provenance

Isolation limits what a plugin can do; provenance is about what the user agreed
to run. Ranked by value against effort:

1. an explicit user action to enable each plugin, with its identity and version
   shown — no discovery-based auto-loading, ever;
2. a lockfile pinning exact resolved versions, so an update is a reviewable
   change rather than an ambient one;
3. registry signature or attestation verification, if and when the ecosystem
   provides something worth checking.

Auto-discovery is the one item this design rules out permanently. A plugin the
user did not choose to run is an unreviewed dependency with terminal reach.

## Cost, honestly

Every rendered event crosses a process boundary and is serialized. For a
first-party renderer that cost buys nothing, which is why first-party plugins
should keep running in-process and this design should apply only to third-party
ones. Two execution models in one host is a real complexity cost, and it is the
price of not pretending a manifest is a sandbox.

If that cost is judged too high, the correct outcome is to keep the plugin plane
first-party indefinitely. That is a legitimate answer. Shipping a public plugin
SDK without isolation is not.

## What must be true before third-party loading ships

1. this design, or a superseding one, is accepted;
2. per-plugin projected context with payload redaction is implemented;
3. the out-of-process host is implemented with deadlines, disable-on-fault and
   explicit version refusal;
4. an adversarial test suite exists — a plugin that tries to read the
   environment, spawn a process, open a socket, emit raw control sequences,
   hang, exhaust memory, and report a failed tool call as successful — and each
   attempt is observably contained on the blocking matrix;
5. the security review in [SECURITY-REVIEW.md](SECURITY-REVIEW.md) is re-run
   with third-party loading enabled;
6. enablement is explicit and per-plugin, with identity and version shown.

Until all six hold, `DEVELOPMENT.md` stands: no arbitrary package discovery or
loading.
