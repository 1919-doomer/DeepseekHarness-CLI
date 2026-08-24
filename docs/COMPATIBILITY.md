# Public-alpha compatibility statement

This statement applies to `@liaosiyuan123/dshc@0.1.0-alpha.2`.

| Boundary | Supported alpha baseline |
| --- | --- |
| Installed command | `dshc` |
| Node.js | `^22.19.0 || >=24.0.0` |
| DeepSeek Harness packages | exact `0.1.1-rc.2` for every direct `@deepseek-ai/dsh-*` dependency |
| SDK server | `deepseek-harness-sdk-runtime` |
| Protocol | `0.0.1` |
| Default provider | `deepseek-official` |
| Default model | `deepseek-v4-flash` |
| Contributor package manager | pnpm `11.7.0` |

## Blocking platform matrix

- Windows latest with Node 24;
- macOS latest with Node 24;
- Ubuntu latest with Node 24;
- Ubuntu latest with Node 22.19.0.

Each platform builds the product and runs fake-runtime lifecycle/security tests,
the official published-Harness smoke and a global installation from the packed
npm tarball. The installed-package smoke checks `--version`, `--help`,
initialize-only `doctor --json`, reinstall/repair and uninstall.

## Supported paths

- structured interactive TTY product;
- one-shot prompt and JSON output;
- scripted persistent non-TTY interaction;
- initialize-only doctor preflight;
- repository-local read/search/edit/platform-shell work through the shipped
  Harness composition;
- upstream `workspace-write` sandbox enforcement and fail-closed unavailable
  escalation;
- vision, web research, workspace MCP patches and exact official Harness plugin
  installation described in `docs/EXTENSIONS.md`.

## Compatibility policy

The package intentionally pins an exact developer-preview Harness closure. A
new upstream prerelease is not considered compatible merely because npm semver
can resolve it. Moving the baseline requires the peer check, official event
contract, official runtime suite, packed installation matrix and relevant live
provider/plugin gates to pass again.

Custom `--runtime-config` files and workspace composition patches may change the
capability, provider, sandbox and approval facts. `doctor` labels that override;
the shipped-default compatibility statement must not be applied to an arbitrary
custom composition.

## Known protocol limits

Protocol `0.0.1` exposes no prompt-level cancellation, per-session close,
server-to-client approval request flow or authoritative full runtime-plugin
inventory. `dshc` does not add private methods or simulate those contracts.

This is an unofficial community interoperability statement, not a compatibility
or support commitment from DeepSeek AI.
