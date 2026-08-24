# DeepSeek Harness CLI

> 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方、终端原生控制台。

**当前状态：public-alpha 发布候选版（`0.1.0-alpha.1`）。M1–M4.6 已完成。** 默认 coding runtime 已包含 composition patch、vision、Web research、MCP bridge 与受限的 Harness 插件自助安装。完整 Harness 依赖闭包与兼容门禁均固定在 `0.1.1-rc.2`。

[English](README.md) · [安装与卸载](docs/INSTALLATION.md) · [兼容性](docs/COMPATIBILITY.md) · [演示](docs/DEMO.md) · [变更记录](CHANGELOG.md) · [扩展与配置](docs/EXTENSIONS.md) · [设计](docs/DESIGN.md) · [协议](docs/PROTOCOL.md) · [开发](docs/DEVELOPMENT.md) · [路线图](docs/ROADMAP.md)

## 安装 public alpha

```bash
npm install --global dshc@alpha
dshc doctor
cd <仓库目录>
dshc
```

npm 包名和安装后的命令都是 `dshc`。npm 上的 `deepseek-harness-cli`
与本仓库无关。provider 配置、固定版本、更新、
卸载和诊断说明见[安装与生命周期](docs/INSTALLATION.md)。

## 核心定位

DeepSeek Harness 是插件优先的 Agent Runtime。`dshc` 是它的终端控制面，而不是第二套 Agent Harness。

> **Harness 负责 Agent 语义；`dshc` 负责终端交互、投影、可观测性与呈现。**

`dshc` 通过官方 Harness SDK/runtime 边界工作；model、tool、skill、approval、sandbox、persistence、session、subagent 与 agent loop 继续由上游负责。

## 现在已经能做什么

M4 默认路径已经从最小 demo composition 升级为 Harness-native coding runtime：

```text
cd repository
 -> dshc
 -> Harness filesystem / search / platform shell / subagents / todo
 -> workspace-write sandbox + never approval policy
 -> Ink terminal product / plain compatibility paths
 -> bounded local transcript + trace retention
 -> clean runtime teardown
```

当前能力包括：

- Ink 7 + React 19 结构化 TTY 界面，保持 Node 22.19/24 基线；
- 一个 Harness runtime 支撑持续多轮交互，active session 默认保持稳定；
- 从仓库 cwd 直接启动即可使用 Harness-owned `read`、`write`、`edit`、`glob`、`grep`、POSIX Bash / Windows PowerShell、subagent 与 todo；
- filesystem 与 shell 共用上游 `workspace-write` sandbox policy；`danger-full-access` 绝不是隐式 fallback；
- approval policy 为 `never`；protocol `0.0.1` 没有 dshc 可用的 server→client approval transport，因此不会向模型承诺不存在的升级通道；
- `vision` 使用 `deepseek-v4-flash-vision-exp` 检视图片；`web_search`、`web_fetch` 与只读 `researcher` 角色由 Harness seam 和 timeout policy 提供；
- 工作区可通过 patch 启用 MCP server，`/tools` 和 activity 保留 `mcp__<server>__<tool>` 来源；
- shipped composition 始终是基线，工作区只自动应用 `.dshc/cordis.patch.yml`；
- `/plugin search` 与 `/plugin install` 仅接受 `@deepseek-ai/` 包，要求精确版本确认、先试启动，失败时回滚 patch；
- resize-aware transcript、grapheme-safe prompt editor、历史导航与自适应状态栏；
- `/help`、`/status`、`/session`、`/new`、`/clear`、`/plugins`、`/capabilities`、`/trace`、`/agents`、`/exit`；
- first-party terminal plugin API v1 与 coding tool/subagent 专用展示；
- activity/trace/transcript/topology 使用有界本地 retention，并明确披露 eviction；
- ESC/CSI/OSC/C1/bidi 终端注入防护、secret-redacted diagnostics 与异常安全的 alternate-screen 恢复；
- `dshc doctor` 只做兼容性/启动 preflight，只执行 `initialize`，绝不发送模型 prompt；
- one-shot、stdin pipe、JSON 与非 TTY `--interactive` 脚本模式全部保留。

## 源码使用

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile

# provider key 尚未配置时也可以先做 preflight；doctor 只报告凭据是否存在。
pnpm dev -- doctor
pnpm dev -- doctor --json

# 真正进行模型任务前再按正常 DeepSeek Harness 方式配置 provider 环境。
# 在 TTY 中不带 positional prompt 直接启动，即进入终端产品。
pnpm dev
```

TTY 中的主要命令：

```text
/help          capability-aware 帮助
/status        runtime/model/workspace/session 状态
/session       当前 Harness session
/new           切换新 session，不重启 Harness runtime
/clear         只清理本地显示
/plugins       Capability Explorer
/capabilities  /plugins 的别名
/trace         normalized observable event timeline
/agents        基于公开事件的 root/subagent topology
/config        查看 base、patch 与 effective requested configuration
/plugin        搜索/安装受限 Harness 插件
/exit          关闭当前拥有的 Harness runtime 并退出
```

如果确实要向模型发送以 `/` 开头的文本，使用 `//...`。

### Doctor

`dshc doctor` 不创建 session，也不调用 `session/prompt`。它会用 PASS/WARN/FAIL/UNKNOWN 检查 Node、workspace、runtime config、固定 DSH 包版本、provider/model 选择、DeepSeek 凭据存在性、TTY/raw-mode、公开 `initialize` handshake、server/protocol identity、M4 默认 sandbox/approval 以及 dshc 本地 retention policy。

```bash
pnpm dev -- doctor
pnpm dev -- doctor --workspace ./some-repo
pnpm dev -- doctor --json
```

它不会打印 credential value、长度、前缀、fingerprint 或 environment dump。使用 `--runtime-config` 时会明确标记 override，因为自定义 composition 可能不再符合 shipped M4 capability/sandbox/approval 事实。硬配置/兼容性错误返回非 0；缺少 key、非 TTY 等属于 warning，而不是伪造 runtime failure。

### one-shot 与脚本兼容模式

```bash
pnpm dev -- "inspect this repository"
pnpm dev -- run "inspect this repository"
echo "summarize the project" | pnpm dev -- --json
printf "first prompt\nsecond prompt\n/exit\n" | pnpm dev -- --interactive
```

常用参数：

```text
-C, --workspace <path>
--provider <id>
--model <id>
--session <id>
--max-tokens <n>
--activity-timeout-ms <n>
--request-timeout-ms <n>
--runtime-config <path>
--interactive
--json
--debug
```

## 协议边界

已验证基线为 DeepSeek Harness `0.1.1-rc.2`、SDK server `deepseek-harness-sdk-runtime`、protocol `0.0.1`、Node `^22.19.0 || >=24`、pnpm `11.7.0`。

`dshc` 不增加私有 wire method。当前协议依然没有 per-prompt cancel、per-session close、可用的 server→client approval request flow，也没有 authoritative full runtime-plugin inventory。因此：

- `session/prompt` 仍只视为 enqueue receipt；
- 每次 activity 从匹配 durable receipt 一直观察到 root `idle`；
- `/new` 只改变本地选中的 session；
- active turn 中 Ctrl+C 会关闭整个 Harness runtime；
- `doctor` 在公开 `initialize` 后停止，不会触发模型调用；
- 无法获得的权限升级会 fail closed，而不是由终端层伪造批准；
- `/plugins` 对 runtime plugin inventory 明确显示 partial/unavailable；
- `/trace` 不重建、不暴露 hidden reasoning；
- 本地 `activityId` 只用于终端展示分组，不是上游 message/turn/causal id。

详见 [协议与上游兼容](docs/PROTOCOL.md)。

## first-party terminal plugin plane

终端插件层目前只支持 first-party。内置 command、event renderer、view 与 status segment 都通过确定性 `TerminalPluginHost` 注册。

这有意**不是**允许任意 npm/Node package 直接加载的社区插件生态。未经隔离的第三方 Node 包天然拥有宽泛机器权限，因此 third-party loading 会等 M4/M6 的隔离设计真正成立后再开放。

## 验证

Required CI 不需要真实 provider secret，并阻塞验证：

- Windows latest / Node 24；
- macOS latest / Node 24；
- Ubuntu latest / Node 24；
- Ubuntu latest / Node 22.19.0。

正常 gate 覆盖 injected-TTY 产品测试、fake-runtime lifecycle/security 与 bounded-retention。官方发布版 Harness smoke 覆盖 one-shot、持续交互、仓库 read/edit/search/shell、workspace sandbox denial/escalation、built `dshc doctor --json`，以及 rc.2 成功/失败 tool result 的原始事件契约。doctor smoke 会主动删除 `DEEPSEEK_API_KEY` 并把模型 endpoint 指向不可达地址；仍能成功意味着 preflight 没有发出模型请求。

## 架构

```text
Terminal user
    │
    ▼
 dshc
 ├─ CLI mode routing + doctor preflight
 ├─ Ink TTY product / plain fallback
 ├─ first-party terminal plugin host
 ├─ normalized transcript / trace / topology
 ├─ session selection / lifecycle
 └─ terminal security boundary
    │
    │ stdio JSON-RPC
    ▼
 Official DeepSeek Harness runtime
 ├─ models / tools / skills
 ├─ sessions / persistence
 ├─ approval / sandbox
 ├─ subagents / jobs / workflows
 └─ agent loop
```

所有上游版本/协议相关行为继续统一隔离在 `src/upstream/`。

## 下一阶段

- **M5**：让已验证的 `0.1.0-alpha.1` 候选版通过所有者侧 npm 2FA 门禁并公开；
- **M6**：安全的社区扩展生态与高级 capability views。

## License 与关系说明

MIT License。本项目是独立社区项目，**不隶属于、不代表、也未获得 DeepSeek AI 官方背书**。“DeepSeek”与“DeepSeek Harness”仅用于说明与上游项目的互操作关系。
