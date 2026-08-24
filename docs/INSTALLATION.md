# Installation and lifecycle

`dshc` is an unofficial community terminal for DeepSeek Harness. The public
alpha package and installed executable are both named `dshc`.

> Do not install the unrelated npm package `deepseek-harness-cli`. It is not
> published or maintained by this repository.

## Requirements

- Node.js `^22.19.0 || >=24.0.0`;
- Windows, macOS or Linux;
- an interactive terminal for the structured Ink product;
- a supported provider credential only when a model-backed task is submitted.

The npm package contains its pinned Harness runtime. End users do not need pnpm,
do not need a source checkout and do not need to assemble a Cordis tree.

## Install the alpha

```bash
npm install --global dshc@alpha
dshc --version
dshc doctor
```

If a corporate mirror has not yet replicated the alpha, use the official
registry for this installation:

```bash
npm install --global dshc@alpha --registry=https://registry.npmjs.org/
```

## Configure a provider

`dshc` does not store or own provider secrets. Configure the normal Harness
environment through a session-scoped environment, operating-system secret
manager or another upstream-supported mechanism. For the default provider the
runtime checks for `DEEPSEEK_API_KEY`.

PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = '<set through your approved secret workflow>'
dshc doctor
```

POSIX shell:

```bash
export DEEPSEEK_API_KEY='<set through your approved secret workflow>'
dshc doctor
```

Avoid committing credentials to a repository or placing them in scripts and
shell history. `doctor` reports presence only; it never prints a value, length,
prefix, fingerprint or environment dump, and it never sends a model prompt.

## Start in a repository

```bash
cd /path/to/repository
dshc
```

Useful preflight and compatibility paths:

```bash
dshc doctor --json
dshc --help
dshc run "inspect this repository"
```

## Update, pin or repair

Reinstalling the alpha tag is the supported update/repair path:

```bash
npm install --global dshc@alpha
```

Pin an exact build when reproducibility matters:

```bash
npm install --global dshc@0.1.0-alpha.1
```

`latest` is intentionally not the public-alpha channel. Do not omit `@alpha`
unless a later stable release explicitly documents that transition.

## Uninstall

```bash
npm uninstall --global dshc
```

User-created Harness sessions and workspace-local `.dshc` composition patches
are data, not npm package files, so npm does not delete them. Review and remove
those paths separately only when you deliberately want to discard that data.

## Troubleshooting

1. Run `node --version`; Node 22 must be at least 22.19.
2. Run `dshc doctor --json` and retain the redacted report.
3. Confirm `npm view dshc dist-tags --registry=https://registry.npmjs.org/`.
4. If the official registry has the version but a mirror does not, wait for the
   mirror or install this package from the official registry explicitly.
5. On POSIX, prefer a user-owned Node installation rather than running a global
   npm install with elevated authority.

Report non-sensitive bugs through GitHub Issues. Follow `SECURITY.md` for
security-sensitive reports and never attach real credentials or private
repository contents.

## 简体中文速查

安装、检查、进入仓库：

```bash
npm install -g dshc@alpha
dshc doctor
cd <仓库目录>
dshc
```

更新仍执行同一条 `@alpha` 安装命令；卸载执行
`npm uninstall -g dshc`。`dshc` 不保存 provider key，`doctor`
只报告凭据是否存在，不会发出模型请求。
