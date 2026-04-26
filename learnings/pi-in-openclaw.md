# Pi 在 OpenClaw 的位置

> 笔记目的:搞清楚 `@mariozechner/pi-*` 这套第三方 SDK 在 OpenClaw 里扮演的角色,以及为什么它会在很多 harness 框架里反复出现。

## 1. Pi 是什么

**Pi** 是 [Mario Zechner](https://github.com/badlogic) 开源的一套 **AI agent building blocks**,NPM scope 是 `@mariozechner/pi-*`。OpenClaw 在根 [package.json](../package.json) 里锁到 `0.65.2`:

```json
"@mariozechner/pi-agent-core": "0.65.2",
"@mariozechner/pi-ai": "0.65.2",
"@mariozechner/pi-coding-agent": "0.65.2",
"@mariozechner/pi-tui": "0.65.2",
```

名字 `pi` 来自 `pi-coding-agent` 的 `piConfig.name: "pi"` —— 它自己也有一个叫 `pi` 的 CLI,是一个最小化的 coding agent(类似 Codex/Claude Code 的骨架)。

四个包各司其职:

| 包 | 定位 |
|---|---|
| `@mariozechner/pi-ai` | **Unified LLM API**:统一 Anthropic/OpenAI/Google/Vertex/Bedrock/Groq/Cerebras/xAI/Ollama/vLLM… 的 provider 抽象 + 自动 model discovery |
| `@mariozechner/pi-agent-core` | **General-purpose agent**:transport 抽象、state management、attachment、turn loop(循环调 LLM + 执行 tools) |
| `@mariozechner/pi-coding-agent` | **Coding agent**:基于 pi-agent-core,带 `read / write / edit / bash / exec` 等 coding tools + session 管理 |
| `@mariozechner/pi-tui` | **Terminal UI**:差分渲染 TUI 库(`pi` CLI 自己用,OpenClaw 基本不用) |

## 2. Pi 在 OpenClaw 的位置

OpenClaw **不自己写 agent turn loop 和 tool executor**,而是把 `pi-coding-agent` + `pi-agent-core` 作为内核嵌进来,外面包一层自己的东西:

```
┌──────────────────────────────────────────────────────────────┐
│  OpenClaw 自己的层                                            │
│  • Channels (Feishu / Telegram / Discord / Slack / Signal / …)│
│  • Gateway / Session 持久化 / Reply dispatcher                │
│  • Plugin SDK(provider / channel / skill plugins)           │
│  • buildAgentSystemPrompt(拼 system prompt + cache boundary)│
│  • createOpenClawCodingTools(包装 Pi 原生工具)              │
│  • pi-embedded-runner(把 Pi 嵌进 gateway 进程)             │
├──────────────────────────────────────────────────────────────┤
│  Pi 内核(第三方,不由 OpenClaw 维护)                        │
│  • pi-coding-agent  → read / write / edit / bash / exec 工具 │
│  • pi-agent-core    → turn loop、state、transport           │
│  • pi-ai            → provider 抽象、model discovery        │
└──────────────────────────────────────────────────────────────┘
```

具体看 [src/agents/pi-embedded-runner/run/attempt.ts](../src/agents/pi-embedded-runner/run/attempt.ts):OpenClaw 的 `EmbeddedRunAttempt` 调用 pi-agent-core 的 agent loop,把 system prompt、tools、provider 通过参数喂进去。

**Pi 负责跑一轮推理,OpenClaw 负责把它接入真实世界** —— IM 消息、gateway、多 session、插件生态。

### 2.1 一次 "hi" 消息的调用链

```
用户在 Feishu 发送 "hi"
   ↓
Feishu channel plugin(OpenClaw 层)
   ↓ 归一化成 channel event
Gateway / session router(OpenClaw 层)
   ↓ 决定由 default agent 处理
pi-embedded-runner(OpenClaw 层)
   ↓ buildEmbeddedSystemPrompt(...) → buildAgentSystemPrompt(...)
   ↓ createOpenClawCodingTools(...) 把 Pi 工具包好
pi-agent-core.run(...)(Pi 层)
   ↓ 走 turn loop:拼 messages → 调 provider → 处理 tool_use
pi-ai.provider(vllm / anthropic / openai / …)(Pi 层)
   ↓ HTTP
LLM 服务(vLLM 127.0.0.1:8000、api.anthropic.com、…)
   ↓ assistant content
reply-dispatcher(OpenClaw 层)
   ↓ 解析 [[reply_to_current]] / NO_REPLY
Feishu channel plugin → 用户看到回复
```

配套参考:[mock_hi_prompts.txt](./mock_hi_prompts.txt) 展示了第 2–6 步之间塞给 LLM 的完整 prompt。

## 3. 为什么别的 harness 也用 Pi

不是"别的 harness 都用 Pi",而是 **Pi 本身就被设计成"给别人当内核用"**,因此自然会出现在多个 harness 里:

- `pi-ai` 是少数几个覆盖 10+ provider 并带自动 discovery 的轻量 TS SDK —— 谁要做多 provider 的 harness 都会考虑它。
- `pi-agent-core` 有 transport 抽象(stdio / ACP / embedded),可以同时当 CLI agent 和 embedded runner,同一套 agent loop 适配不同外壳。
- 作者自己的 `pi` CLI 就是参考实现,别人 fork / 嵌入它 = 拿到一个能跑的 coding agent 骨架,省掉自己实现 `read/write/edit/bash` 这些最脏最容易出错的部分。

所以规律是:**Pi 是 agent 层的"React"**,OpenClaw 是"用 React 搭出来的应用"。OpenClaw 的价值在 channel 生态 + gateway + plugin 系统,而不是重复造 agent turn loop 这个轮子。

## 4. 边界(哪些归 Pi 哪些归 OpenClaw)

| 职责 | 归属 |
|---|---|
| LLM HTTP 调用、流式解析、provider 差异 | **Pi** (`pi-ai`) |
| Turn loop、tool_use 调度、state/attachment | **Pi** (`pi-agent-core`) |
| `read / write / edit / bash / exec` 工具实现 | **Pi** (`pi-coding-agent`) |
| System prompt 内容、cache boundary 布局 | **OpenClaw** ([src/agents/system-prompt.ts](../src/agents/system-prompt.ts)) |
| 工具向 LLM 暴露时的名字 / 描述 / 策略包装 | **OpenClaw** (`createOpenClawCodingTools`) |
| Channel(Feishu / Telegram / Discord / …) | **OpenClaw** |
| Gateway / session 持久化 / cron / 子 agent | **OpenClaw** |
| Plugin SDK、provider / channel 插件契约 | **OpenClaw** ([src/plugin-sdk/](../src/plugin-sdk/)) |
| Reply dispatch、`[[reply_to_current]]` / `NO_REPLY` | **OpenClaw** |

**判断口诀**:"怎么跟 LLM 对话"归 Pi,"怎么跟用户和系统对话"归 OpenClaw。
