# Cordis Plugin Workbench

`dshc --dev` is a trusted development entrypoint for ordinary DSH/Cordis
plugins. Harness still owns plugin execution, services, tools and lifecycle;
`dshc` adds the developer persona, terminal projection, trace filters and the
`/workbench` diagnostic view.

## Trust boundary

Developer mode runs dynamic host code inside the live Harness process. The
Cordis VM is not a security boundary; treat it like shell access. A running
plugin can affect other sessions in that process even though lifecycle
visibility and control are scoped to the session that defined it.

Definitions and immutable package revisions live only in process memory. They
disappear when the runtime exits and are not a source package, a workspace
patch, HMR or a persistence mechanism. `--dev` is therefore accepted only by
the interactive TTY product. One-shot prompts, piped/scripted modes, JSON mode
and `--runtime-config` are rejected. The only non-TTY development entrypoint is
the initialize-only diagnostic:

```bash
dshc doctor --dev
```

It validates exact `0.1.1-rc.2` Cordis dependencies, the built-in developer
patch, patch order and the Harness initialize handshake. It does not define or
run dynamic code and does not require a provider credential.

## Start a workbench session

```bash
cd /path/to/plugin-repository
dshc doctor --dev
dshc --dev
```

The startup transcript and status line keep the trusted-code warning visible.
The runtime layers are always applied in this order:

```text
shipped base
 -> built-in developer patch
 -> <workspace>/.dshc/cordis.patch.yml (when present)
```

Ordinary `dshc` never loads the developer patch and its model tool roster does
not contain Cordis lifecycle tools.

## Official lifecycle

The pinned official package exports seven tools:

```text
cordis_inspect_list
cordis_inspect_query
cordis_inspect_self
cordis_define
cordis_run
cordis_stop
cordis_undefine
```

There are no direct `/cordis run` commands or Workbench buttons. Ask the Agent
to inspect the live contract, define an immutable package, run it, call its
dynamic tool, stop it and undefine it. dshc sends no private lifecycle RPC; the
official tools execute through the Harness model/tool path.

Host-only prototypes work in this JSON-RPC terminal deployment. A package with
a browser/client half waits for a connected page and cannot complete here. No
source HMR is claimed: modify a prototype by defining a new package for the
same plugin and running it in `update` mode.

## Observe and debug

`/workbench` shows retained lifecycle calls, results, errors, public upstream
durations, call IDs and allowlisted `tool/result.data.meta` identities such as
`pluginId`, `packageId` and `pluginRunId`. It is an observed event timeline,
not authoritative real-time inventory. Result prose is retained as folded
detail but is never parsed to invent state.

The existing trace engine adds these filters:

```text
/trace cordis
/trace plugin <plugin-id>
/trace service <service-name>
```

Service filtering reads the exact public `cordis_inspect_query.input.service`
field; provider names and rendered result prose are not treated as Service
identity. Filtering otherwise uses structured call arguments and public result
metadata. Local retention, output folding and terminal sanitization are the
same bounded paths used by other tool activity.

## Promote a prototype

A successful dynamic run is only an experiment. Persistence is complete only
after this sequence:

1. Write an ordinary DSH/Cordis source package in the repository; do not invent
   a dshc-specific plugin format.
2. Discover and run that repository's typecheck, lint, build and test commands.
3. Add the normal package entry to `.dshc/cordis.patch.yml` (or the project's
   owned profile/composition mechanism).
4. Explicitly distinguish the temporary in-memory definition from the files
   that will survive restart.
5. Stop/undefine the temporary experiment, restart the Harness runtime and
   verify real initialization plus the persisted tool/service behavior.

Only the post-restart initialization and behavior are evidence of persistence.
The Workbench does not implement promotion automatically because package layout,
build contracts and composition ownership belong to the plugin repository.

## Deliberate exclusions

M6 does not add source HMR, `dshc-bridge`, a third-party terminal plugin SDK,
session browsing, Jobs, Diff, Profiles or notifications. Those remain gated
candidates in #16 until a real need and supported upstream contract exist.
