# DeepSeek Harness CLI

> 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方、终端原生控制台。

**当前状态：pre-alpha。M1 Runtime Vertical Slice 已完成并通过跨平台验证；下一阶段是 M2 持续多轮交互。尚未发布到 npm。**

[English](README.md) · [设计](docs/DESIGN.md) · [协议](docs/PROTOCOL.md) · [开发](docs/DEVELOPMENT.md) · [路线图](docs/ROADMAP.md)

## 核心定位

DeepSeek Harness 是插件优先的 Agent Runtime。`dshc` 是它的终端控制面，而不是第二套 Agent Harness。

> **Harness 负责 Agent 语义；`dshc` 负责终端交互、可观测性与呈现。**

插件哲学保持同样的分工：

> **DSH：万物皆插件。**  
> **dshc：所有终端界面能力都可插件化。**

DSH 插件决定 Agent 能做什么；未来的 dshc terminal plugins 决定这些能力如何显示和交互，例如命令、tool/event renderer、view、status segment 与 diagnostics。

## 项目特点

- **DSH-native**：通过官方 Harness SDK/runtime 工作，不是 DeepSeek 模型 API 聊天壳。
- **Event-native**：从 Harness session/runtime notifications 构建状态，而不是把执行压扁成 `prompt -> text`。
- **协议诚实**：上游没有 prompt cancel 就不伪造 cancel；没有严格 prompt/response 因果就不假装存在。
- **强调可观测性**：tool、subagent、runtime state、failure、unknown event 都是终端的一等信息。
- **Capability-driven 方向**：未来 UI 根据实际 Harness composition 自动长出对应能力，而不是固定仪表盘。
- **薄前端**：model、tool、skill、approval、sandbox、session、subagent、agent loop 继续由 DSH 负责。

## M1 已完成

M1 先完整证明官方 runtime boundary，再进入 full-screen TUI：

```text
启动发布版 dsh-jsonrpc-agent
 -> initialize
 -> enqueue prompt
 -> 等待对应 durable receipt
 -> 接收有序 session-tree notifications
 -> normalize/project events
 -> 安全 plain terminal renderer
 -> root session idle
 -> 有界、干净 shutdown
```

当前已经实现：

- TypeScript/ESM 工程与 `dshc` executable；
- 精确固定 DeepSeek Harness `0.1.0-rc.8` + committed lockfile；
- 官方 `dsh-jsonrpc-agent` launcher 与外部 `runtime/cordis.yml`；
- 启动时 SDK/runtime/protocol identity 校验；
- 按官方 SDK 语义实现 receipt→idle activity interval；
- assistant/tool/subagent/error normalized projection；
- streaming 与 committed assistant 输出去重；
- ANSI/OSC/C0/C1/bidi control terminal injection 防护；
- 明确的 timeout / SIGINT / SIGTERM 行为，不伪造 prompt cancellation；
- child-process diagnostics secret redaction；
- 不依赖 API Key 的 fake-runtime 协议/生命周期测试；
- 使用官方 Harness runtime 的 credential-free keyless smoke；
- Windows、macOS、Ubuntu GitHub Actions gate，并覆盖 Node 22.19 与 Node 24。

详见 [协议](docs/PROTOCOL.md) 与 M1 主 Issue [#10](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/10)。

## 当前源码使用方式

M1 有意只提供 one-shot 模式；持续多轮属于 M2。

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile

# 先按正常 DeepSeek Harness 方式配置 provider 环境
pnpm dev -- "inspect this repository and summarize the architecture"
```

M1 可用参数：

```text
-C, --workspace <path>
--provider <id>
--model <id>
--session <id>
--max-tokens <n>
--activity-timeout-ms <n>
--request-timeout-ms <n>
--runtime-config <path>
--json
--debug
```

非 TTY one-shot 也支持 stdin：

```bash
echo "summarize the project" | pnpm dev -- --json
```

## 架构

```text
Terminal user
    │
    ▼
 dshc
 ├─ CLI / lifecycle
 ├─ normalized session projection
 ├─ safe plain renderer          (M1)
 └─ terminal plugin plane        (后续正式抽象)
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

所有上游版本/协议相关行为统一收敛在 `src/upstream/`；终端层只消费本项目的 normalized events，不直接依赖 Harness 私有实现对象。

## 当前上游约束

M1 已验证的基线是 DeepSeek Harness `0.1.0-rc.8`，SDK server protocol `0.0.1`。

当前公开 wire 主要提供 `initialize`、`session/prompt`、`shutdown`、session event/status 和支持的 subagent notifications。没有 per-prompt cancel，也没有 per-session close；`session/prompt` 返回 enqueue receipt，不是某个 assistant response 的严格 RPC result。

`dshc` 会把这些当成真实产品约束，而不是在 UI 层遮掩。详见 [协议](docs/PROTOCOL.md)。

## 下一阶段

- **M2**：持续多轮 terminal loop + local commands；
- **M3**：完整终端产品 + first-party terminal plugin plane、Capability Explorer、renderer registry、trace/debug views；
- **M4**：兼容性、安全、可靠性强化；
- **M5**：公开 alpha；
- **M6**：安全的社区扩展生态与高级 capability views。

后续重点功能包括 `/plugins` / Capability Explorer、plugin-aware tool renderers、`/trace`、live agent topology、adaptive status/help、`dshc doctor`，以及可选的 DSH-side `dshc-bridge`。

## 文档

长期维护的技术文档只保留：

- [设计](docs/DESIGN.md)
- [协议与兼容](docs/PROTOCOL.md)
- [开发、测试与发布规则](docs/DEVELOPMENT.md)
- [路线图与功能池](docs/ROADMAP.md)

实时执行状态统一放在 [GitHub Issues](https://github.com/1919-doomer/DeepseekHarness-CLI/issues)。

## License 与关系说明

MIT License。本项目是独立社区项目，**不隶属于、不代表、也未获得 DeepSeek AI 官方背书**。“DeepSeek”与“DeepSeek Harness”仅用于说明与上游项目的互操作关系。
