# DeepSeek Harness CLI

> 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方、终端原生控制台。

**当前状态：M7 public alpha（`0.1.0-alpha.9`），已交付不依赖上游扩展的 M7.0–M7.3。** 默认 coding runtime 已包含 composition patch、vision、Web research、MCP bridge、受限的 Harness 插件自助安装，以及显式高权限的 Cordis 开发模式。完整 Harness 依赖闭包与兼容门禁均固定在 `0.1.1-rc.2`；运行时权威检查与交互授权仍等待上游正式扩展契约。

[English](README.md) · [安装与卸载](docs/INSTALLATION.md) · [兼容性](docs/COMPATIBILITY.md) · [Plugin Workbench](docs/PLUGIN-WORKBENCH.md) · [M7 历史/上下文/权限](docs/HISTORY-CONTEXT-PERMISSIONS.md) · [演示](docs/DEMO.md) · [变更记录](CHANGELOG.md) · [扩展与配置](docs/EXTENSIONS.md) · [设计](docs/DESIGN.md) · [协议](docs/PROTOCOL.md) · [开发](docs/DEVELOPMENT.md) · [路线图](docs/ROADMAP.md)

## 安装 public alpha

```bash
npm install --global @liaosiyuan123/dshc@alpha
dshc doctor
cd <仓库目录>
dshc
```

npm 包名是 `@liaosiyuan123/dshc`，安装后的命令仍是 `dshc`。npm 上不带
scope 的 `dshc` 和 `deepseek-harness-cli` 均不是本仓库发布的包。provider
配置、固定版本、更新、
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
- `/plugin search` 与 `/plugin install` 仅接受 `@deepseek-ai/` 包，要求精确版本确认；在不可变 candidate profile 中用私有 patch 试启动，成功后才原子发布 workspace patch；
- resize-aware transcript、grapheme-safe prompt editor、历史导航与自适应状态栏；
- `/help`、`/status`、`/session`、`/new`、`/clear`、`/plugins`、`/capabilities`、`/trace`、`/agents`、`/exit`；
- first-party terminal plugin API v1 与 coding tool/subagent 专用展示；
- activity/trace/transcript/topology 使用有界本地 retention，并明确披露 eviction；
- ESC/CSI/OSC/C1/bidi 终端注入防护、secret-redacted diagnostics 与异常安全的 alternate-screen 恢复；
- `dshc doctor` 只做兼容性/启动 preflight，只执行 `initialize`，绝不发送模型 prompt；
- `dshc --dev` 只允许交互式 TTY，挂载官方 Cordis runner/tool，并以持续警告、`/workbench` 和 trace filter 呈现高权限动态生命周期；普通模式完全不挂载这些工具；
- `dshc doctor --dev` 无需 provider key，只验证精确依赖、developer patch 顺序与 initialize，不执行动态代码；
- `/history` 通过 Harness 自己的 JSONL 会话文件只读浏览，默认限制在当前 workspace；Ask History 先审阅来源，再把确认片段注入一个全新普通会话；
- `/context`、`/prompt`、`/permissions` 明确区分 runtime/observed、local/requested 与 unavailable，不伪造 context window、最终 Prompt 或 approval answerer；
- Windows 的 `TEMP`/`TMP` 位于 workspace 内时，`doctor` 和交互启动都会准确说明所有 pwsh/shell 调用为何失败，但不会搬迁 TEMP 或削弱 sandbox；
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

# 显式高权限 Cordis 开发模式（只支持交互式 TTY）
pnpm dev -- doctor --dev
pnpm dev -- --dev
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
/workbench     Cordis 生命周期观察时间线（仅 dev 模式）
/history       Harness 会话只读浏览；ask 必须先审阅证据
/context       已观察到的 request usage、容量元数据与 compaction
/prompt        dshc 自己拥有的本地 Prompt 层投影
/permissions   fail-closed policy、能力矩阵与 approval audit
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
--dev
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

`--dev` 不新增私有 wire。生命周期仍由 Agent 调用官方工具；动态代码可影响
整个 Harness 进程，Cordis VM 不是安全边界，内存定义在重启后消失。

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

- **M7.4**：已于 2026-08-26 复核；固定的官方 wire 仍无版本化扩展/approval 能力握手，闭合 SDK 路由对真实命名空间探测返回 `-32603` 与明确的 unknown-runtime-method 诊断；
- **M7.5**：继续标记为 `requires-upstream`，不伪造完整运行时 Prompt 检查或 Allow once/Reject 交互；
- **M7.6**：加固 Ask History 审阅绑定、取消/并发 JSONL 读取，以及 approval audit 的重放、重复和跨会话诊断；
- **#16**：其余候选能力继续执行准入制。

## License 与关系说明

MIT License。本项目是独立社区项目，**不隶属于、不代表、也未获得 DeepSeek AI 官方背书**。“DeepSeek”与“DeepSeek Harness”仅用于说明与上游项目的互操作关系。
