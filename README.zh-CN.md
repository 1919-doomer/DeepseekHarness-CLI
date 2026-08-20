# DeepSeek Harness CLI

> 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方、终端原生控制台。

**当前状态：pre-alpha。M1 runtime integration 与 M2 持续多轮终端交互均已实现并通过跨平台验证；下一阶段是 M3 终端产品化。尚未发布到 npm。**

[English](README.md) · [设计](docs/DESIGN.md) · [协议](docs/PROTOCOL.md) · [开发](docs/DEVELOPMENT.md) · [路线图](docs/ROADMAP.md)

## 核心定位

DeepSeek Harness 是插件优先的 Agent Runtime。`dshc` 是它的终端控制面，而不是第二套 Agent Harness。

> **Harness 负责 Agent 语义；`dshc` 负责终端交互、可观测性与呈现。**

`dshc` 通过官方 Harness SDK/runtime 工作，消费结构化 session events；model、tool、skill、approval、sandbox、session、subagent 与 agent loop 继续由上游负责。

## 现在已经能做什么

M1 证明了官方 runtime boundary；M2 在同一条官方链路上把一次性命令提升为持续多轮终端会话：

```text
启动 dshc
 -> 启动发布版 dsh-jsonrpc-agent
 -> initialize 一次
 -> 保持一个 active Harness session
 -> prompt / receipt / ordered events / idle
 -> 在同一 session 上继续下一轮
 -> 可用 /new 切换新 session，但不重启 runtime
 -> 干净 shutdown
```

当前已经具备：

- TTY 中默认进入持续多轮交互；
- 整个 `dshc` 进程复用同一个 Harness runtime；
- 默认 session 在多轮之间保持稳定；
- `/new` 创建并切换到新 session，不重启 Harness；
- `/help`、`/status`、`/session`、`/new`、`/clear`、`/exit`；
- assistant 流式 transcript，以及 tool/subagent activity；
- 即使 tool 输出打断 assistant 显示行，也不会再次重复 committed assistant message；
- unknown event 安全降级与 `--debug` 诊断；
- terminal control/bidi 注入防护与 child diagnostics secret redaction；
- 明确的 EOF / signal 生命周期；
- M1 的 one-shot、stdin pipe 与 JSON 模式全部保留。

## 源码使用

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile

# 先按正常 DeepSeek Harness 方式配置 provider 环境。
# 在 TTY 中不带 prompt 直接启动，即进入持续交互模式。
pnpm dev
```

交互示例：

```text
DeepSeek Harness Console 0.0.0-dev · interactive M2
runtime deepseek-harness-sdk-runtime/0.0.1 · deepseek-v4-flash
session session-... · /help for commands

dshc[...]> inspect this repository
assistant> ...

dshc[...]> now explain the previous result
assistant> ...

dshc[...]> /status
status> runtime=ready ...

dshc[...]> /new
session> new session-...

dshc[...]> /exit
```

本地命令：

```text
/help       显示命令列表
/status     显示 runtime/model/workspace/session/turn 状态
/session    显示当前 Harness session id
/new        切换到新 Harness session，不重启 runtime
/clear      只清理本地终端显示，不删除 Harness history
/exit       关闭 Harness runtime 并退出
```

如果确实要向模型发送以 `/` 开头的内容，可以使用 `//...`。

### 保留 one-shot 模式

M1 的使用方式仍然有效：

```bash
pnpm dev -- "inspect this repository"
pnpm dev -- run "inspect this repository"
echo "summarize the project" | pnpm dev -- --json
```

`--interactive` 可以在 stdin 是 pipe 时强制进入逐行持续交互，适合脚本与确定性测试：

```bash
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

当前公开协议依然没有 per-prompt cancel，也没有 per-session close。因此：

- `session/prompt` 只被视为 enqueue receipt，不伪装成某个 assistant result；
- 每轮 activity 从对应 durable receipt 一直观察到 root `idle`；
- `/new` 只是切换本地 active session，旧 session 因上游没有 close request 仍归当前 runtime 所有；
- active turn 中按 Ctrl+C 会关闭整个 Harness runtime，`dshc` 不会声称“单个 prompt 已取消”；
- EOF 在空闲时，或已经读入的工作执行完之后，会干净退出。

详见 [协议与上游兼容](docs/PROTOCOL.md)。

## 验证

Required CI 不依赖真实 provider secret，并阻塞验证：

- Windows latest / Node 24；
- macOS latest / Node 24；
- Ubuntu latest / Node 24；
- Ubuntu latest / Node 22.19.0。

Gate 包含 lint、strict typecheck、unit tests、fake-runtime subprocess tests、POSIX active-turn SIGINT、build、M1 official-runtime one-shot smoke，以及真正通过发布版 Harness runtime 跑两轮的 `dshc --interactive` 子进程 smoke；模型侧使用本地 deterministic stub，不产生真实 API 调用。

## 架构

```text
Terminal user
    │
    ▼
 dshc
 ├─ one-shot / interactive CLI
 ├─ local command layer
 ├─ session selection / lifecycle
 ├─ normalized event projection
 └─ safe scrollback renderer
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

所有上游版本/协议相关逻辑仍统一隔离在 `src/upstream/`。M3 可以在 M1/M2 已经证明过的真实 seam 上构建更完整的终端产品与 first-party terminal plugin plane，而不是提前猜抽象。

## 下一阶段

- **M3**：完整终端产品 + first-party terminal plugin plane、Capability Explorer、renderer registry、trace/debug views；
- **M4**：兼容性、安全、可靠性强化；
- **M5**：公开 alpha；
- **M6**：安全的社区扩展生态与高级 capability views。

## License 与关系说明

MIT License。本项目是独立社区项目，**不隶属于、不代表、也未获得 DeepSeek AI 官方背书**。“DeepSeek”与“DeepSeek Harness”仅用于说明与上游项目的互操作关系。
