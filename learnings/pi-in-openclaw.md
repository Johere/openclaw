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

## 5. 量化:OpenClaw 里 Pi 的 import 分布

基于 `src/` + `extensions/` 全量统计(`from "@mariozechner/..."` 出现次数):

| 包 | 次数 | 主要导入符号 |
|---|---|---|
| `pi-agent-core` | 191 | `AgentMessage` / `AgentTool` / `AgentEvent` / `StreamFn` / `ThinkingLevel` —— agent loop 消息/事件模型 |
| `pi-ai` | 190 | `streamSimple` / `streamAnthropic` / `streamOpenAIResponses` / `Model` / `Api` / `Context` / `getModel` / `getApiProvider` / `OAuthCredentials` —— **真正的 provider HTTP 传输与 SSE 解析** |
| `pi-coding-agent` | 78 | `SessionManager` / `AgentSession` / `codingTools` / `ExtensionAPI` / `Skill` / `createEditTool` / `createReadTool` / `createWriteTool` —— 会话持久化 + 编码工具集 |
| `pi-tui` | 22 | CLI TUI(`pi` CLI 自用,OpenClaw 几乎只在 `pi-embedded-runner` 外壳里触到) |

### 哪些 extensions 直接 import `pi-ai`(12 个)

```
anthropic  openai  google  xai  byteplus  github-copilot
kilocode   kimi-coding  minimax  moonshot  zai
(+ src/ 自己的 agent/transport 代码)
```

典型用法就一个模式:`import { streamSimple } from "@mariozechner/pi-ai"` →
拿来当默认 `StreamFn` → 外面套自己的 `wrapStreamFn` 补 provider 兼容性。

## 6. OpenClaw 自己写的那部分(非 Pi)

用一句话概括:**Pi 负责"跟 LLM 聊天",其它一切都是 OpenClaw 自己的**。

更具体的 5 个板块:

### 6.1 Plugin 系统 + 公开 SDK

- [src/plugin-sdk/](../src/plugin-sdk/) —— `registerProvider` / `registerChannel` /
  `registerCommand` / hook 注册 / skill 注册的公开契约
- [src/plugins/](../src/plugins/) —— 插件发现、manifest 校验、loader、注册表
- 30+ 个 lifecycle hook(`before_prompt_build` / `llm_input` / `llm_output` /
  `before_tool_call` / `after_tool_call` / ...),详见
  [agent-lifecycle-hooks.md](./agent-lifecycle-hooks.md)。**Pi 本身没有这些 hook**
  —— 它是 OpenClaw 在 turn loop 外面补的切面。

### 6.2 Channels(消息入口)

`src/telegram`, `src/discord`, `src/slack`, `src/signal`, `src/imessage`,
`src/web`(WhatsApp),以及 bundled plugin 形式的 `matrix` / `zalo` / `feishu` /
`googlechat` / `line` / `mattermost` / Voice Call 等。

Pi 是 "input → output" 的 agent loop,**没有任何"从 IM 收消息"的概念**。
Channel 归一化成 `AgentMessage` 喂给 Pi,再把 Pi 的输出拆回 IM 语义
(`[[reply_to_current]]` / `NO_REPLY` 之类)。

### 6.3 Gateway + 多节点协议

- [src/gateway/](../src/gateway/) —— 控制面 / 节点 wire protocol / bridge
- `src/gateway/protocol/` —— 类型化的控制面协议(add/remove node、channel 状态、
  session 路由)

Pi 是单进程内的,**没有"多节点 gateway"这一层**。

### 6.4 Provider 注册/目录/认证/onboarding 适配

每个 `extensions/<provider>/` 里自己写的:

- `registerProvider()` 的 catalog(模型列表 + 价格 + 能力标签)
- OAuth / API key / Bearer 的 auth flow(`provider-auth.ts`)
- `onboard.ts`(CLI/UI 引导)
- **`wrapStreamFn`**(provider-specific 兼容性 patch,见
  [provider-stream-wrap.md](./provider-stream-wrap.md))
- 可选 `prepareExtraParams` / `resolveTransportTurnState` /
  `webSocketSessionPolicy`

这些都是"在 `pi-ai` 已经能说 OpenAI/Anthropic/Gemini 协议的基础上,补 OpenClaw
的配置、catalog、auth UI、兼容性兜底"。Pi 不管这些。

### 6.5 `pi-embedded-runner` —— 编排层

- [src/agents/pi-embedded-runner/run/attempt.ts](../src/agents/pi-embedded-runner/run/attempt.ts)
  —— OpenClaw 自己的 turn orchestrator
- 调用的是 `pi-agent-core` 的类型 + `pi-ai` 的 `streamFn`,但:
  - System prompt 怎么拼 → OpenClaw 的 `buildAgentSystemPrompt`
  - Cache boundary 在哪 → OpenClaw(见 [tutorial.md](./tutorial.md) §4.1)
  - Tools 怎么暴露给 LLM → `createOpenClawCodingTools`(包住 Pi 原生工具,
    加 OpenClaw 的策略)
  - Hook 在什么时间触发 → OpenClaw 自己定义的生命周期
  - Reply 怎么分发回 channel → `src/reply-dispatch/`

### 6.6 其他辅助层(非核心但也是 OpenClaw 自研)

- Session 持久化(JSONL 格式、`~/.openclaw/agents/<id>/sessions/`)——
  `pi-coding-agent` 有 `SessionManager`,但 **session 文件布局、agentId 路径、
  gateway 共享机制** 是 OpenClaw 的。
- Memory plugin(`memory-core` / `memory-lancedb`)、skills 发现、diffs viewer、
  diagnostics OTel、auth pairing、canvas-host / a2ui bundle 等。
- CLI(`openclaw` 命令)、Mac app、iOS/Android app、`openclaw doctor`。

## 7. 判断一段代码归谁:三条快速规则

1. **看 import**。`from "@mariozechner/..."` → 是 Pi 的直接消费者(基本就是
   transport 或 agent loop 边缘)。全是 `openclaw/plugin-sdk/*` 或 `src/**` 的
   → OpenClaw 自己。
2. **看能不能不升级 Pi 就改掉**。能 → 属于 OpenClaw;要动 `pi-*` 源码 → 属于 Pi。
3. **看改动影响范围**。只影响 "跟 LLM 怎么聊"(prompt 内容、tools schema、
   provider wrap)→ Pi 边界附近;影响 "消息怎么进来/回复怎么出去/插件怎么接入"
   → 纯 OpenClaw。

---

相关:[provider-stream-wrap.md](./provider-stream-wrap.md) 解释了 `wrapStreamFn +
onPayload` 为何天然可行 —— `onPayload` 本身是 `pi-ai` 的 `SimpleStreamOptions`
字段,OpenClaw 是**利用**而非**新增**这个 hook 点做观察/mutate。
