# Extensions and composition

For interactive development of an ordinary DSH/Cordis package, see the trusted
[Cordis Plugin Workbench](PLUGIN-WORKBENCH.md). It is a Harness development
surface, not a third-party terminal-plugin SDK.

M4.6 Batch 2 keeps one authoritative base at `runtime/cordis.yml`. A workspace
may add only this automatic layer:

```text
<workspace>/.dshc/cordis.patch.yml
```

The file is a top-level Cordis Include `PatchOptions[]`. `/config fork` creates
`[]`; it never copies the shipped file and never overwrites an existing patch.
`/reload --yes` starts a replacement runtime with the current base plus patch.
`/config` displays the shipped/override base, patch path and count, and composed
effective entries. This remains requested configuration: protocol `0.0.1` has
no authoritative runtime plugin inventory.

An explicit `--runtime-config <path>` selects a different base and intentionally
does not inherit the workspace patch.

## Vision and web

The shipped `vision` subagent routes to `deepseek-v4-flash-vision-exp` and keeps
only `read`, `read_image`, `glob` and `grep`. Images are stored by
`@deepseek-ai/dsh-attachment-local`.

`web_search` uses `@deepseek-ai/dsh-web-search-deepseek`; `web_fetch` uses the
anonymous HTTP(S) provider. Both declare cooperative 30-second budgets enforced
by `@deepseek-ai/dsh-tool-call-timeout-policy`. The read-only `researcher` role
keeps repository discovery plus those two web tools.

## MCP

The shipped `mcp-workspace` entry is disabled until a workspace patch supplies a
complete server config. For example:

```yaml
- id: mcp-workspace
  disabled: false
  config:
    transport: stdio
    serverName: local
    command: node
    args: [/absolute/path/to/server.js]
    env: {}
    cwd: /absolute/workspace/path
    toolCallTimeoutMs: 30000
    failOnStartupError: true
```

Streamable HTTP is also supported by the upstream plugin. Discovered tool names
are `mcp__<serverName>__<rawName>`; dshc preserves that provenance in transcript
and `/tools` presentation.

An MCP server is an external program or endpoint. The DSH `workspace-write`
sandbox governs Harness filesystem and shell providers; it does **not** confine
an MCP server process or remote service. Configure only servers you trust and
apply their own filesystem/network restrictions. Environment values in MCP
config are passed to that server and must not be committed when secret.

## Restricted self-service plugin install

```text
/plugin search <terms>
/plugin install @deepseek-ai/package
/plugin install @deepseek-ai/package@1.2.3 --yes
```

The unconfirmed command resolves and prints the exact package and version. Only
the matching exact command with `--yes` mutates the workspace. Installation:

1. accepts npm package names in the `@deepseek-ai/` scope only;
2. installs under `.dshc/profiles/default` with exact versions and lifecycle
   scripts disabled (`.dshc/.gitignore` excludes `profiles/` when dshc creates it);
3. appends one Include insertion to `cordis.patch.yml`;
4. initializes a replacement runtime before touching the live runtime;
5. restores the previous patch byte-for-byte if trial initialization fails.

The downloaded package remains cached/installed after a failed trial; the live
composition does not. Installed code executes in the Harness child with that
process's OS authority, so scope restriction is a trust policy, not a sandbox.

Search and install use the active npm registry. `dshc doctor` reports whether
that is npm's default or a configured mirror and names its source. A mirror must
carry the requested exact `@deepseek-ai` version. Git, GitHub and arbitrary URL
specs are intentionally unsupported.
