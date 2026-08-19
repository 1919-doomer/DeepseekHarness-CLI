# DeepSeek Harness CLI

> 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方、终端原生交互控制台。

**当前状态：pre-alpha。M0 开发前准备已完成，M1 runtime 实现可以开始；暂不可安装使用。**

[English](README.md) · [设计](docs/DESIGN.md) · [协议](docs/PROTOCOL.md) · [开发](docs/DEVELOPMENT.md) · [路线图](docs/ROADMAP.md)

## 核心想法

DeepSeek Harness 是插件优先的 Agent Runtime。`dshc` 的目标是在不 fork、不重写 Harness 核心的前提下，为它提供持续多轮、真正终端原生的交互界面。

> **Harness 负责 Agent 语义；`dshc` 负责终端交互、可观测性与呈现。**

插件哲学也保持一致：

> **DSH：万物皆插件。**  
> **dshc：所有终端界面能力都可插件化。**

DSH 插件决定 Agent 能做什么；dshc 的 terminal plugins 决定这些能力如何在终端里呈现和交互，例如命令、tool/event renderer、view、status segment、diagnostics，以及未来经过安全设计后的社区扩展。

## 为什么它不同

`dshc` 不是 DeepSeek API 聊天壳，也不是另一套独立 coding-agent harness。

- 相比 DSH Web UI：它面向 shell、编辑器 Terminal、SSH 等终端工作流。
- 相比官方 headless：它面向持续多轮，而不是一次任务一次最终 stdout。
- 相比 Codex CLI / Claude Code：底层 Agent 语义仍然由 DeepSeek Harness 提供。
- 相比 Pi/OpenCode 一类 Harness：它不再建立第二套 model/tool/plugin 生态，而是把 DSH 已有能力带进终端。

真正的差异点是：**event-native 可观测性、Harness 原生概念、协议诚实、capability-driven UI。**

## 架构

```text
Terminal user
    │
    ▼
 dshc
 ├─ input / commands
 ├─ normalized session projection
 ├─ terminal plugin host
 ├─ renderers / views / trace
 └─ lifecycle controller
    │
    │ stdio JSON-RPC
    ▼
 Official DeepSeek Harness runtime
 ├─ models
 ├─ tools / skills
 ├─ sessions / persistence
 ├─ approval / sandbox
 ├─ subagents / jobs / workflows
 └─ agent loop
```

核心规则：终端层只依赖本项目自己的 normalized state；所有上游版本/协议差异统一隔离在 `src/upstream/`。

## 目标终端体验

```text
DeepSeek Harness Console                         V4-Pro
workspace  E:\project                     session  8b72…
──────────────────────────────────────────────────────

> inspect the failing tests and explain the root cause

● Exploring repository
  ├─ read package.json
  ├─ search src/
  └─ run pnpm test

● Running 2 subagents
  ├─ researcher       web search · 18s
  └─ tester           tests · 11s

● Found the failure
  ...

> /plugins
> /agents
> /trace
> /status
```

终端 UI 最终应根据当前 Harness composition 自适应，而不是永远展示固定面板。未知 tool/event 也必须有安全、可读的 generic fallback。

## 当前上游约束

M1 基线在 2026-08-20 按 DeepSeek Harness `0.1.0-rc.8` 复核。

当前公开 JSON-RPC 主要包括 `initialize`、`session/prompt`、`shutdown`、session event/status 与支持的 subagent notifications。现在没有 per-prompt cancel，也没有 per-session close；`session/prompt` 返回的是 enqueue receipt，不是严格的一问一答 result。

`dshc` 不会在 UI 层伪造这些不存在的能力。

详见 [协议与上游兼容](docs/PROTOCOL.md)。

## 开发路线

开发从 runtime boundary 开始，而不是从漂亮 TUI 开始。

**M1 — Runtime vertical slice**（[#10](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/10)）：

```text
launch runtime
 -> initialize
 -> enqueue prompt
 -> consume ordered events
 -> normalize/project
 -> plain safe renderer
 -> idle
 -> clean shutdown
 -> cross-platform CI
```

之后依次是：

- M2：持续交互式 terminal loop；
- M3：完整终端产品 + first-party terminal plugin plane；
- M4：可靠性 / 安全 / 兼容性强化；
- M5：公开 alpha；
- M6：安全的社区插件生态和高级 capability views。

第一个可执行开发任务是 [#2](https://github.com/1919-doomer/DeepseekHarness-CLI/issues/2)。

## 插件方向

优先级较高的能力包括：

- Capability Explorer（`/plugins` / `/capabilities`）；
- plugin-aware tool/event renderers；
- Session Debugger / `/trace`；
- live agent topology；
- Harness 支持时的 jobs / plan views；
- adaptive status / help / commands；
- `dshc doctor` 兼容性诊断；
- 可选的 `dshc-bridge` Cordis 插件，用于更丰富的 capability metadata；
- 第三方 terminal plugins 必须等可靠的隔离/权限设计之后再开放。

详见 [设计](docs/DESIGN.md) 与 [路线图](docs/ROADMAP.md)。

## 文档

长期维护的技术文档只保留四个：

- [设计](docs/DESIGN.md)
- [协议与兼容](docs/PROTOCOL.md)
- [开发、测试与发布规则](docs/DEVELOPMENT.md)
- [路线图与功能池](docs/ROADMAP.md)

实时进度和执行任务统一放在 [GitHub Issues](https://github.com/1919-doomer/DeepseekHarness-CLI/issues)，不再重复维护大量 STATUS / CHECKLIST 文档。

## 命令名

上游已经占用 `dsh`，因此当前工作 binary 名称为：

```sh
dshc
```

即 **DeepSeek Harness Console**。npm package 名称在公开 alpha 前最终确定。

## License 与关系说明

MIT License。本项目是独立社区项目，**不隶属于、不代表、也未获得 DeepSeek AI 官方背书**。“DeepSeek”与“DeepSeek Harness”仅用于说明与上游项目的互操作关系。
