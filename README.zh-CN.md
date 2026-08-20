# DeepSeek Harness CLI

> 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方、终端原生控制台。

**当前状态：pre-alpha。M1 runtime integration、M2 持续多轮交互与 M3 终端产品层/first-party plugin plane 均已实现并通过跨平台验证；下一阶段是 M4 可靠性、安全与兼容性强化。尚未发布到 npm。**

[English](README.md) · [设计](docs/DESIGN.md) · [协议](docs/PROTOCOL.md) · [开发](docs/DEVELOPMENT.md) · [路线图](docs/ROADMAP.md)

## 核心定位

DeepSeek Harness 是插件优先的 Agent Runtime。`dshc` 是它的终端控制面，而不是第二套 Agent Harness。

> **Harness 负责 Agent 语义；`dshc` 负责终端交互、投影、可观测性与呈现。**

`dshc` 通过官方 Harness SDK/runtime 边界工作；model、tool、skill、approval、sandbox、persistence、session、subagent 与 agent loop 继续由上游负责。

## 现在已经能做什么

M3 在不改变 Harness 协议语义的前提下，把 M2 的持续 prompt loop 提升成结构化终端产品：

```text
TTY 用户
 -> Ink terminal product
 -> first-party terminal plugin host
 -> normalized transcript / views / status
 -> 一个持续存在的 Harness runtime
 -> 多轮默认复用同一 session
 -> receipt / ordered events / idle
 -> 可选 /new 切换 session
 -> 干净恢复终端并关闭 runtime
```

当前能力包括：

- Ink 7 + React 19 结构化 TTY 界面，同时保留已验证的 Node 22.19/24 基线；
- 一个 Harness runtime 支撑持续多轮交互，active session 默认保持稳定；
- resize-aware transcript、prompt editor、历史导航与自适应状态栏；
- `Enter` 提交，`↑/↓` 浏览 prompt history，`Ctrl+J` 插入换行；
- `/help`、`/status`、`/session`、`/new`、`/clear`、`/plugins`、`/capabilities`、`/trace`、`/agents`、`/exit`；
- first-party terminal plugin API v1：command、renderer、view、status segment 使用统一确定性 registry；
- tool/subagent 专用 renderer 与 unknown event 的安全 generic fallback；
- 大段 tool/output 自动折叠，并明确提示折叠内容而不是静默丢失；
- Capability Explorer 显示已验证 runtime metadata，并明确标注无法从协议获得的插件清单；
- `/trace` 与 `/agents` 只从公开、可观测的 normalized events 构建；
- terminal control/bidi 注入防护、secret-redacted diagnostics 与异常安全的 alternate-screen 恢复；
- M1/M2 的 one-shot、stdin pipe、JSON 与非 TTY `--interactive` 脚本模式全部保留。

## 源码使用

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile

# 先按正常 DeepSeek Harness 方式配置 provider 环境。
# 在 TTY 中不带 positional prompt 直接启动，即进入 M3 终端产品。
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
/exit          关闭当前拥有的 Harness runtime 并退出
```

如果确实要向模型发送以 `/` 开头的文本，使用 `//...`。

### one-shot 与脚本兼容模式

非 TTY/plain 路径有意保持独立，不依赖 Ink：

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

已验证基线仍为 DeepSeek Harness `0.1.0-rc.8`、SDK server `deepseek-harness-sdk-runtime`、protocol `0.0.1`、Node `^22.19.0 || >=24`、pnpm `11.7.0`。

M3 没有增加任何新的 wire method。当前协议依然没有 per-prompt cancel、per-session close，也没有 authoritative full runtime-plugin inventory。因此：

- `session/prompt` 仍只视为 enqueue receipt，不伪装成某个 assistant result；
- 每次 activity 从匹配的 durable receipt 一直观察到 root `idle`；
- `/new` 只改变本地选中的 session；
- active turn 中 Ctrl+C 会关闭整个 Harness runtime，不宣称“单个 prompt 已取消”；
- `/plugins` 对 Harness runtime plugin inventory 明确显示 partial/unavailable，而不是猜测；
- `/trace` 不重建、不暴露 hidden reasoning；
- M3 本地生成的 `activityId` 只用于区分终端展示块，不是上游 message/turn/causal id。

详见 [协议与上游兼容](docs/PROTOCOL.md)。

## first-party terminal plugin plane

M3 是在 M1/M2 已经证明真实需求之后，才正式抽象终端插件层。内置命令、event renderer、view 与 status segment 都通过同一个确定性 `TerminalPluginHost` 注册。

这目前有意**不是**一个允许任意 npm/Node package 加载的社区插件生态。未经隔离的第三方 Node 包天然拥有很宽的机器权限，因此 third-party loading 会等到 M4/M6 的安全与隔离设计成熟后再讨论。

## 验证

Required CI 不需要真实 provider secret，并阻塞验证：

- Windows latest / Node 24；
- macOS latest / Node 24；
- Ubuntu latest / Node 24；
- Ubuntu latest / Node 22.19.0。

每个 Runtime job 都会编译 Ink/React 产品层。正常测试还会用可注入的 TTY-like streams 真正驱动 Ink 产品，覆盖 raw-mode ownership、同 session 两轮 prompt、Capability Explorer、resize、alternate-screen 恢复与 `/exit`。原有 fake-runtime 生命周期测试与发布版 Harness one-shot/两轮 smoke 继续保留，model traffic 由本地 deterministic stub 接管。

## 架构

```text
Terminal user
    │
    ▼
 dshc
 ├─ CLI mode routing
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

- **M4**：可靠性、兼容性、安全与长会话强化；
- **M5**：公开 alpha；
- **M6**：安全的社区扩展生态与高级 capability views。

## License 与关系说明

MIT License。本项目是独立社区项目，**不隶属于、不代表、也未获得 DeepSeek AI 官方背书**。“DeepSeek”与“DeepSeek Harness”仅用于说明与上游项目的互操作关系。
