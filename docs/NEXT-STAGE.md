# Next-stage development build / 下一阶段开发版本

Version `0.1.0-alpha.12` is a **GitHub prerelease**, distributed as a tested tarball. The npm alpha.10 release does not include these changes.
The independent `dshc` command, bundled runtime, one-shot/stdin/JSON and scripted
interaction remain supported. No global DSH installation is downloaded or upgraded
by normal dshc startup.

## Compatibility and work modes

| Backend | Version verified independently | Configuration |
| --- | --- | --- |
| `bundled` (default) | all direct Harness packages `0.1.1-rc.2` | shipped composition plus workspace patch, or explicit `--runtime-config` |
| `dsh-profile` | official CLI and SDK server `0.1.5-rc.2` | official Bundle layers, Profile patch and DSH home patch |

Both advertise wire version `0.0.1`. This does **not** make other upstream versions
compatible. Profile startup checks actual package identity, SDK server presence,
initialization and shutdown. Arbitrary future versions are rejected.

The bundled default model and vision role are now `deepseek-flash`, following the
[V4.1 announcement](https://www.deepseek.com/en/news/deepseek-v4-1-flash/).
The pinned adapter supports it with the explicit multimodal model catalog in
`runtime/cordis.yml`; a dependency upgrade was unnecessary. Explicit `--model`,
provider configuration and `DSHC_VISION_MODEL` continue to take precedence.

```sh
dshc --locale zh-CN --mode plan --style explanatory
dshc run --mode review --reply-language zh-CN "Review this repository"
dshc --runtime dsh-profile --dsh-profile sdk
```

| Mode | Harness-enforced tool boundary |
| --- | --- |
| `code` | existing coding composition |
| `plan`, `review` | `read`, `glob`, `grep` only |
| `research` | repository read tools and configured `web_search`, `web_fetch` |

Public Harness tool guards and per-agent restrictions apply to root and descendant
agents. Read-only modes reject shell, write/edit, code execution and delegation
paths, including attempted calls omitted from the model's tool schemas. Missing
required read capabilities prevent activation. Research does not fabricate Web
tools that the selected Profile has not configured. Bundle code is trusted host
code; these tool policies are not an executable-plugin sandbox.

`/mode`, `/style`, `/effort` and `/profile` preview a runtime change; repeat with
`--yes` to create a new runtime/session. Styles are `default`, `explanatory`,
`learning`. Reply language, style, mode and adapter effort are separate settings.
Effort is forwarded to the verified adapter configuration, not mapped through a
universal model enum; unsupported values fail in that adapter. There is no Claude
service `/fast` emulation. Explicit `DSH_SYSTEM_PROMPT` retains priority over
generated reply/style instructions, while runtime tool restrictions remain active.

Use the existing `/history continue` review flow to carry plan evidence into a
coding session. This creates a new session; it does not resume an old one.

## Preferences and input / 偏好与输入

优先级：命令行 → `.dshc/settings.json` 工作区覆盖 → 用户设置 → 系统默认。
用户设置位于 `~/.dshc/settings.json`，可通过 `DSHC_HOME` 指定目录。交互命令
将修改保存到工作区设置；用户配置可直接编辑。配置拒绝未知字段，不保存凭据。

```json
{
  "locale": "auto",
  "replyLanguage": "auto",
  "mode": "code",
  "style": "default",
  "runtime": "bundled",
  "dshProfile": "sdk",
  "externalEditor": ["code", "--wait"],
  "keybindings": {
    "externalEditor": "ctrl+g",
    "withdrawQueue": "ctrl+o"
  }
}
```

- `--locale auto|zh-CN|en` 与 `/language` 控制界面，自动模式跟随系统。
  菜单、帮助、状态及内置视图提供中文；缺失资源回退英文。原始工具输出、
  事件字段、错误码、模型标识和命令名保持原样。历史消息中的旧提示不会翻译重写。
- `/reply-language auto|zh-CN|en|语言标签` 独立控制回复语言；`auto` 跟随提问。
  提示词设置在下一次运行时启动生效，`/config`、`/status` 显示请求值、启动值、
  来源及待生效差异。CLI 支持对应的 `--reply-language` 参数。
- 输入 `@路径` 后按 Tab 枚举候选路径；多个候选使用箭头或 Tab 选择，Enter 插入路径，
  再次 Enter 才发送。带空格的路径支持引号。只引用路径，
  不自动读入、上传或内联文件。读取权限由 Harness 决定。
- Ctrl+G 或 `/edit` 打开外部编辑器，退出编辑器后恢复终端。配置为程序与参数数组，
  不经 shell 求值；未配置时使用 `VISUAL` / `EDITOR` 指定的程序。
- `/language `、`/reply-language `、`/mode `、`/style `、`/diff ` 后输入空格显示参数候选，
  ↑↓ 选择，Tab 或 Enter 补全，再按 Enter 执行。模式和风格切换预览给出具体目标与
  确认命令；选择候选不会自动确认重启。错误命令保留在输入框中，可直接修改或 Ctrl+U 清空。
- ↑↓ 翻阅输入历史，返回最新位置会恢复原草稿和光标。Home / Ctrl+A 到草稿开头，
  End / Ctrl+E 到末尾；Delete 删除光标后的字符，Backspace 删除光标前的字符，均保持完整字素。
- 支持 bracketed paste，多行粘贴保留为一份草稿。Ctrl+J 或 Alt+Enter 输入换行。
  输入上限 262144 字符，编辑器文件与模板读取上限 256 KiB。
- `/template 名称 参数...` 将 `.dshc/templates/名称.md` 或用户目录中的模板展开
  到输入框；工作区优先。仅替换 `$1`–`$9`、`$ARGUMENTS`，不执行模板代码。
- 模型运行时 Enter 将输入加入待发送队列。`/queue list`、`edit N 文本`、
  `remove N`、`withdraw`、`resume` 管理队列；Ctrl+O 撤回最新项到输入框。
  每项绑定原会话；只有对应任务成功且已观察到 root idle 才继续逐条发送。
  错误、中断、重启或切换会话暂停队列，不能自动转投新会话。最多 32 项，
  合计 262144 字符；退出后不持久化。
  状态栏持续显示非空队列的数量和暂停状态。
- `/diff [staged|unstaged] [文件]` 分页查看已跟踪文件的增删统计和逐文件差异。
  禁用外部 diff 与 textconv，路径按字面值处理；不推断修改归属，不提供回滚操作。
  大于显示上限时提示缩小到具体文件；未跟踪文件不包含在 Git diff 中。
- 对话按实际显示行分页，PageUp/PageDown 可以在同一条长回复内连续翻页，页面之间
  保留两行重叠。默认跟随最新输出，回看时保持阅读位置；翻到底部或发送新提问恢复跟随。
  页顶显示当前行范围，宽表格在窄屏上按字段展开，代码和中文文本按宽度换行。
  本地保留上限仍适用；长视图同样支持翻页，历史视图保留箭头选择会话的语义。
- 状态指示器采用暖橙色星芒动画，运行或启动时依次变化，空闲时静止，失败显示红色 `!`。
  `/status` 保留文字状态；屏幕阅读器读取本地化状态，不播放动画。
- 状态栏按模型身份、用量、输入构成分层，宽窗口三行、窄窗口两行。显示模型标识、提供方、
  配置值/已观察标记、工作模式、运行时后端及显式请求的推理配置；工作目录靠右缩写。
  上下文显示最近报告的根会话输入 / 已观察容量；只有两者都已知才显示比例。
  累计入/出 token 与缓存比例包含当前运行时的子 Agent，不推算模型未报告的用量。
- `TPS 请求均速` = 最近完成的根会话请求输出 token / 从模型步骤开始到用量消息的本地耗时。
  计时在 UI 批处理前采集，包含准备、等待、重试和传输，不代表纯生成速率；新请求期间及缺失
  起点或用量时显示 `—`。不使用字符数估算 token。模型路由事件并非逐请求发送，不能作为计时起点。
- 输入构成显示非缓存、缓存读取、缓存写入 token；系统提示词/对话历史/工具各自的 token
  数尚未由公共接口提供。完整数值、计量口径及不可用项在 `/context`、`/status` 中查看。

Markdown supports headings, paragraphs, emphasis, inline/fenced code, lists,
quotes, rules and basic tables. Unsupported syntax falls back to inert plain
text. Tool output is always plain text. No HTML, terminal escapes or template code
are evaluated. Completed Markdown/row measurements are cached and invalidated
when width changes; streaming parsing reuses completed paragraphs outside fences.

Input/template design references the public
[Pi coding-agent documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md).
No freecode-specific modes or third-party executable terminal plugins are enabled.

## Official Profiles and Bundles / 官方 Profile 与 Bundle

Install the **verified** official CLI yourself if you want this optional backend.
`DSHC_DSH_EXECUTABLE` can point to its `lib/bin.js` or native executable. Shell
shim paths such as `.cmd` are rejected; Windows npm installations are resolved to
their Node entry point automatically when possible.

`sdk` can initialize from the official template. Custom SDK Profiles must already
exist. Browser-server Profiles and `sdk-minimal` are rejected. `--runtime-config`
and `--dev` conflict with `dsh-profile`; no bundled workspace composition is read
or implicitly merged into an official Profile. Dshc adds only its explicit public
preference/tool-policy overlay. `--dev` remains bundled-only, in `code` mode.

```text
/profile sdk --yes
/plugin list
/plugin details package-name
/plugin install package-name@1.2.3
/plugin install package-name@1.2.3 --yes
/plugin install ./prebuilt-bundle.tgz
/plugin upgrade package-name@1.2.4
/plugin disable package-name
/plugin uninstall package-name
/plugin rollback [previous-managed-profile]
```

Every mutating operation first requires a preview, then the same command with
`--yes`. Review the target Profile, source, exact package version, SHA256,
dependencies and Bundle patch. Community sources require an explicitly selected
exact npm package or prebuilt local `.tgz`/`.tar.gz`. Tags, version ranges, Git
sources and source builds are unsupported. Archives must declare `dsh.bundle.patch`;
path traversal, links, unsupported extended tar entries, invalid checksums and
oversized metadata are rejected before official installation.

安装位置是 `DSH_HOME/profiles/dshc-<工作区摘要>-<候选标识>`，不是 dshc 的
终端插件目录。原有共享 `sdk`/`web` 或用户 Profile 不会被改写。
`.dshc/profile.json` 保存受管 Profile 指针及成功版本历史；`profile.lock`
防止同一工作区并发修改。安装委托官方 CLI，关闭生命周期安装脚本并要求严格 peer
依赖检查。候选配置检查、SDK 试启动、配置指纹复核均成功后才原子切换指针。
失败候选保留但不激活；已修改的历史版本不能作为原成功版本直接回退。

重新打开受管配置：

```sh
dshc --runtime dsh-profile --dsh-profile managed
```

清单分别报告 `installed`、`configured`、`startupVerified`、`functionalVerified`。
启动成功不表示所有工具路径均经过验证；目前工具功能验证始终显示未验证。
发现浏览器 Client 依赖时展示终端 UI 不可用原因。对自定义命名依赖不能保证自动
识别；试启动只能证明 Host 启动路径。修改配置后，旧启动验证标记失效。
SDK 忽略非 JSON 日志行，这些行不被转发到终端/JSON 输出；有效 JSON-RPC 数据仍
由官方 SDK 解析，不新增私有协议。

Official references:
[SDK Profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-app/README.md),
[Bundle publication/install mechanism](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

## Performance and reproducible validation

Presentation batches are bounded to 128 events / 65536 text characters and a
33 ms timer. Only consecutive same-session assistant deltas merge; all other
events flush the batch. Trace keeps original envelopes. Runtime projection yields
to input processing after an 8 ms work budget. Completed/cancelled batches reject
late events. Runtime event rings and existing terminal retention bound stored data;
eviction disclosures remain visible. Snapshot notifications wait for slow stdout
to drain, and exit waits for the final Ink render with a bounded shutdown timeout.
Ink retains its 30 FPS limit. No Worker or alternate TUI framework is introduced.

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:official-runtime
pnpm bench:replay [live-metrics.json]
pnpm test:pty
```

The official Profile suites need the exact CLI installed at `DSHC_TEST_DSH`, or
the isolated `node_modules/.dshc-profile-validation` prefix used by CI. They skip
when no CLI is provided. Live model tests additionally require `DSHC_LIVE_V41=1`
and provider credentials. `DSHC_LIVE_METRICS_PATH` writes aggregate metrics only.
`pnpm test:live-v41` without the opt-in spends no provider tokens.
Set `DSHC_BENCH_SECONDS=30` (up to 600 seconds per load) for longer memory/retention
observation; the report includes the final-quarter heap range, including GC noise.

Validated locally on Windows, Node 24.13.0, Intel Core Ultra 9 275HX:

- Live V4.1 text/image/read failure/40-line output: 15390 ms, 2000 events,
  336189 serialized event bytes, peak 680 events/s and 103000 bytes/s (100 ms
  windows normalized to one second). First text: 7923 ms. Request spans: 3909 ms;
  tool spans: 3805 ms. These local spans may overlap and include transport delay.
- Both backends also passed real-model `review` + `explanatory` + `zh-CN` tests.
- Replay of synthetic, non-user event data at the measured peak and 3× burst:

| Load | Events/s | Scheduler delay p95 | Display-processing delay p95 | Max sampled heap | Exit flush |
| --- | ---: | ---: | ---: | ---: | ---: |
| normal | 200 | 12.18 ms | 47.80 ms | 22.82 MB | 0.37 ms |
| measured peak | 680 | 12.07 ms | 47.09 ms | 23.72 MB | 0.43 ms |
| 3× burst | 2040 | 12.09 ms | 46.24 ms | 28.10 MB | 0.21 ms |

These five-second samples measure event processing and timer scheduling, **not
actual keypress-to-screen or physical terminal display latency**. They establish
a baseline, not proof of the release targets of input p95 ≤100 ms / display p95
≤150 ms. The replay asserts final transcript/tool/session/usage equivalence and
retention limits; extended soak testing is still needed to demonstrate a memory
plateau on each supported host. Absolute times are not universal CI gates.

A follow-up 30-second run per load processed 6000 / 20400 / 61200 events.
Peak and 3× loads retained exactly 2048 events and 512 blocks. Last-quarter heap
minima were 25.06 / 26.08 MB; maxima were 40.13 / 80.14 MB, reflecting allocation
and GC variation. This is bounded-retention evidence, not a cross-platform memory
plateau guarantee. Windows CR/CRLF bracketed paste is normalized to LF; coalesced
Ctrl shortcuts are decoded before draft insertion.

Windows ConPTY smoke verified Chinese text input, language switching, Markdown,
menu display and exit restoring raw mode (`raw=false`). Injected TTY regressions
exercise bracketed paste, resize, paging, interrupt and queue behavior. **Physical
Chinese IME composition and POSIX PTY interaction remain manual release gates**;
the Windows run cannot certify those environments. Cross-platform official,
package-install and lifecycle suites remain in CI. Each phase needs its own alpha
release review; this work does not publish an npm package or change a global dsh.
