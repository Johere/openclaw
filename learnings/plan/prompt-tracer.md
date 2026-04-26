# prompt-tracer Plugin — Implementation Plan

## Context

用户希望观察 OpenClaw 在真实对话中"发给 LLM 的完整 prompt"，像 [netron.app](https://netron.app/) 那样点击节点展开查看每一环的细节。当前 OpenClaw 没有任何 transcript / trace / replay 类插件，唯一接近的是 `src/agents/anthropic-payload-log.ts`——只针对 Anthropic，只写 jsonl，没有 UI，不会合并 tool call 回路或 hook 级别的前后状态。

目标：用户在任一 channel 里发送 `/trace_start`，插件开始捕获该 session 的所有 turn（user → system prompt → LLM wire body → tool calls → assistant reply → next user ...），发送 `/trace_end` 结束；插件回复 XML 文件路径 + 自包含 HTTP viewer 路径，双击即可在浏览器里查看流程图。

## Capture Points（已核实，不需要 core patch）

| 环节 | Hook | 关键字段 |
|---|---|---|
| Pre-assembly | `before_prompt_build` | `messages[]`, base `prompt` |
| 最终送入 LLM 前 | `llm_input` | `systemPrompt`, `prompt`, `historyMessages`, `imagesCount`, `provider`, `model`, `runId`, `sessionId` |
| 真实 HTTP wire body | `wrapProviderStreamFn` + `onPayload` callback | 出站 JSON（Anthropic/OpenAI/Gemini 真实 body） |
| 工具调用 | `before_tool_call` / `after_tool_call` | `toolName`, `params`, `result`, `error`, `durationMs` |
| LLM 响应完成 | `llm_output` | `assistantTexts`, `lastAssistant`, `usage` |
| Session JSONL 追加 | `before_message_write` | 任何 role 的 AgentMessage 入盘前 |
| Session 生命周期 | `session_start` / `session_end` / `agent_end` | 自动关闭/兜底 flush |

参考模式：[`src/agents/anthropic-payload-log.ts`](src/agents/anthropic-payload-log.ts#L139-L148) 的 `onPayload` 注入法；`before_message_write` 同步 hook。

**不新增任何 core hook**——这是社区严格红线。

## Module Layout — `extensions/prompt-tracer/`

以 [`extensions/diffs/`](extensions/diffs/) 为模板（结构对齐：manifest + config + http + viewer-client + viewer-assets + plugin）。

| 文件 | 职责 | ≈LOC |
|---|---|---|
| `openclaw.plugin.json` | manifest（kind=skill，不占 slot） | — |
| `package.json` | plugin-only deps | — |
| `index.ts` | `definePluginEntry` → `registerPromptTracerPlugin` | 15 |
| `src/plugin.ts` | 挂 hook / command / http route；构造 TraceManager | ~120 |
| `src/config.ts` | Zod schema + 默认值 | ~110 |
| `src/types.ts` | `TurnRecord`, `PhaseRecord`, `TraceSession`, `TraceStatus` | ~90 |
| `src/manager.ts` | in-memory `sessionKey → TraceSession`，start/stop/append/flush | ~250 |
| `src/recorder.ts` | 纯 hook 事件 → TraceManager 映射（便于单测） | ~220 |
| `src/stream-wrap.ts` | `wrapProviderStreamFn` + `onPayload` 透传 | ~110 |
| `src/xml.ts` | 确定性 XML writer（CDATA 转义 + 属性稳定排序） | ~180 |
| `src/viewer-assets.ts` | `viewer.html` 模板（inline CSS + JS，无 CDN） | ~80 |
| `src/viewer-client.ts` | 浏览器端纯 DOM 渲染（DOMParser + 手写 SVG 连线） | ~600 |
| `src/http.ts` | `GET /plugins/prompt-tracer/sessions/:id.xml` + `/viewer` | ~140 |
| `src/command.ts` | `trace_start` / `trace_end` / `trace_status` handler | ~130 |
| `src/paths.ts` | `~/.openclaw/traces/...` 解析 + 防路径穿越 | ~60 |

每个文件 ≤ 700 LOC（仓库规范）；均有 co-located `*.test.ts`。

## Activation Model

**主路径：** `api.registerCommand({ name: "trace_start", nativeNames: { telegram, discord, feishu, ... }, handler })` —— 这是 OpenClaw 的 plugin command 机制（`src/plugins/types.ts:2275`），原生 UI 菜单可见，`/help` 会列出。

**兜底：** `api.on("inbound_claim", ...)` 检查 `event.content` 是否是 `/trace_start`/`/trace_end` 原文；channel 没走 registered command 分派时捕获。用 `messageId` dedupe 避免双跑。

状态机：

```
idle ──/trace_start──▶ recording ──/trace_end──▶ flushing ──write OK──▶ idle
  ▲                       │
  │                       └── session_end / SIGINT / beforeExit ─▶ flushing (best-effort)
```

每个 `sessionKey`（channel + conversation）独立状态。并发会话不冲突。

## XML Schema（确定性，属性按字母序）

```xml
<trace schema="1" sessionId="..." sessionKey="..." channel="feishu"
       startedAt="2026-04-25T10:15:00Z" endedAt="...">
  <meta>
    <provider>anthropic</provider>
    <model>claude-opus-4-7</model>
    <openclawVersion>...</openclawVersion>
  </meta>
  <turns>
    <turn index="0" startedAt="..." endedAt="..." durationMs="1843">
      <phase kind="before_prompt_build" at="...">
        <messages count="7"><![CDATA[...json...]]></messages>
      </phase>
      <phase kind="llm_input" at="..." imagesCount="0">
        <systemPrompt><![CDATA[...]]></systemPrompt>
        <prompt><![CDATA[...]]></prompt>
        <history><![CDATA[...json...]]></history>
      </phase>
      <phase kind="wire_body" at="..." digest="sha256:..." truncated="false">
        <![CDATA[{...raw http body...}]]>
      </phase>
      <phase kind="tool_call" name="memory_search" at="..." durationMs="412"
             runId="..." toolCallId="...">
        <params><![CDATA[...]]></params>
        <result><![CDATA[...]]></result>
      </phase>
      <phase kind="llm_output" at="...">
        <usage input="1234" output="567" cacheRead="100" cacheWrite="0"/>
        <assistant><![CDATA[...]]></assistant>
      </phase>
    </turn>
  </turns>
</trace>
```

CDATA 里 `]]>` 替换为 `]]]]><![CDATA[>`。所有时间戳 ISO-8601 UTC。超长（> `maxBytesPerPrompt`，默认 256KB）仅写 `<truncated originalBytes="..." digest="sha256:..."/>`。

## Viewer — netron.app 风格

单 HTML 文件，`viewer-assets.ts` 把 `viewer-client.ts` 编译后的 JS 字符串内联。**无 CDN、无运行时 bundler、无外部字体**——双击 file:// 即可用。

布局：
- 顶栏：session meta（model/provider/channel）、turn selector、搜索
- 左栏：turn 竖列表（可点击滚动定位）
- 主画布：每个 turn 是一行，phase 是圆角矩形节点，SVG 画箭头连接。配色：prompt-build 蓝 / llm_input 紫 / wire_body 灰 / tool_call 橙（错误红）/ llm_output 绿 / message_write 石板色
- 点击节点 → 右抽屉打开，pretty-print CDATA（JSON 可解析则缩进高亮，否则纯文本）。`j`/`k` 键切换节点
- 可选迷你地图：turn 栅格缩略图

渲染：`DOMParser` 读 XML → 构 virtual model → 模板字符串注入 root。若 `viewer.inlineXml=true`，XML 嵌入 `<script type="application/xml">` 标签，避免 `file://` fetch 跨域。

## 配置（`plugins.entries.prompt-tracer.config`）

```yaml
enabled: true
tracesDir: ~/.openclaw/traces
maxBytesPerPrompt: 262144
captureWireBody: true        # 开 wrapProviderStreamFn
captureImages: true          # 原样记录（不脱敏，用户决定）
autoStartChannels: []        # channel id 列表，自动开启
viewer:
  theme: dark                # light | dark
  inlineXml: true            # 嵌入 XML 使 file:// 可开
```

**不脱敏策略**：tool params、tool results、wire body 原样记录，包含图像 base64、API key（如果意外出现）、文件内容等全部落地。用户自己负责 trace 文件的访问控制。`~/.openclaw/traces/` 目录创建时权限 `0700`。

## 边界情况

- **/trace_start 未配对 /trace_end**：`session_end` hook + `process.on("beforeExit"|"SIGINT"|"SIGTERM")` 同步 flush，写 `.partial.xml`；下次启动扫描改名为 `.crashed.xml`。
- **并发 session**：Map by `sessionKey`，互不干扰。
- **超大 prompt**：CDATA 截断 + digest + `<truncated/>` 标记；viewer 显示 "content truncated"。
- **无 LLM 的工具调用**（极少见）：生成 `<turn synthetic="true">`。
- **Provider 不支持 wrapStreamFn**：`wire_body` phase 直接缺席，XML 照常渲染，viewer 显示灰占位。
- **非 JSON 可序列化**（Buffer / 循环引用）：`safeJsonStringify` + `[omitted: N bytes]` 占位。
- **中途崩溃**：每 N 个 turn 写一次 `.partial.xml` checkpoint。

## 测试（vitest，插件内）

- `manager.test.ts`：状态机 + mutex 并发安全
- `xml.test.ts`：golden 两轮 session；CDATA 转义；属性排序确定性
- `recorder.test.ts`：fake hook API 重放合成 turn
- `command.test.ts`：start/stop/status 返回文本；重复 `/trace_start` 幂等
- `paths.test.ts`：路径穿越防护
- `http.test.ts`：auth + content-type
- `viewer-assets.test.ts`：viewer HTML 不含 `http(s)://` 外链（正则断言）
- `viewer-client.test.ts`：jsdom 烟雾测——解析 XML + DOM 有预期节点

## 关键引用文件

- Reference plugin: [`extensions/diffs/src/plugin.ts`](extensions/diffs/src/plugin.ts), [`extensions/diffs/src/http.ts`](extensions/diffs/src/http.ts), [`extensions/diffs/src/viewer-assets.ts`](extensions/diffs/src/viewer-assets.ts), [`extensions/diffs/src/viewer-client.ts`](extensions/diffs/src/viewer-client.ts)
- Hook types: [`src/plugins/types.ts`](src/plugins/types.ts) — `PluginHookBeforePromptBuildEvent` (L2414), `PluginHookLlmInputEvent` (L2497), `PluginHookBeforeToolCallEvent` (L2715), `PluginHookAfterToolCallEvent` (L2740), `api.registerCommand` (L2275)
- `onPayload` wire capture 模板: [`src/agents/anthropic-payload-log.ts:139`](src/agents/anthropic-payload-log.ts#L139)
- 插件 SDK 入口: `openclaw/plugin-sdk/plugin-entry`, `openclaw/plugin-sdk/core`

## 已知局限（详解）

### 1. `wrapProviderStreamFn` 只对声明了它的 provider 生效

**什么是 `wrapProviderStreamFn`**：OpenClaw 的 provider plugin（anthropic / openai / vllm / ...）可以在自己的 plugin entry 里选择性导出一个 `wrapStreamFn` 函数。这个函数的作用是"在真正调用 provider 网络请求前，让别的插件有机会包一层"。`src/agents/anthropic-payload-log.ts` 就是用这个机制做 Anthropic 的 payload 落盘的。

**问题**：不是所有 provider 都开了这个口子。如果用户用的 provider（比如某个第三方 plugin、或某个社区 fork 的 provider）没有走 `wrapProviderStreamFn` 流程，我们的 `onPayload` 回调根本不会被调用。

**实际影响**：
- **有 wrap hook 的 bundled provider**：anthropic / openai / openrouter / ollama / xai → wire_body 能捕获到（真实 HTTP body）
- **没有 wrap hook 的**：vllm / vercel-ai-gateway → wire_body 这一节是空的
- 用户注意：就是上面 mock 文件的 vLLM 场景——默认装下来 wire_body 捕获不到
- XML 仍然会写，但 `<phase kind="wire_body">` 节点缺失；viewer 显示灰色占位 "wire body unavailable (provider does not expose wrap hook)"

**第三方 provider plugin 要做什么才能让 wire_body 被捕获**（compatibility checklist）：

这是 OpenClaw plugin 作者侧的工作，不是 prompt-tracer 插件能单方面解决的——需要目标 provider 插件遵守下面三步契约：

1. **注册 `wrapStreamFn` 到 `api.registerProvider()`**（在 provider plugin 自己的 entry 里）：
   ```typescript
   // extensions/<my-provider>/index.ts
   api.registerProvider({
     id: "my-provider",
     // ...
     wrapStreamFn: myWrapStreamFn,   // ← 没有这行 OpenClaw 就不会走 wrap 链
   });
   ```
   参考 [`extensions/openrouter/index.ts:19`](extensions/openrouter/index.ts#L19)、[`extensions/anthropic/register.runtime.ts:479`](extensions/anthropic/register.runtime.ts#L479)。

2. **在 `wrapStreamFn` 里 preserve + chain `onPayload` 回调**（关键）：
   ```typescript
   function myWrapStreamFn(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
     const underlying = ctx.streamFn;
     if (!underlying) return undefined;
     return (model, context, options) => {
       const originalOnPayload = options?.onPayload;    // ← 保留上游回调
       return underlying(model, context, {
         ...options,
         onPayload: (payload) => {
           // 你这层想做的事（例如 provider 特有的 tool schema 兼容性处理）...
           return originalOnPayload?.(payload, model);   // ← 必须 chain 给下游
         },
       });
     };
   }
   ```
   参考 [`extensions/xai/stream.ts:157-180`](extensions/xai/stream.ts#L157-L180) 和 [`src/agents/anthropic-payload-log.ts:139`](src/agents/anthropic-payload-log.ts#L139)。

3. **Provider 的底层 streamFn 必须在真正发 HTTP 前调用 `options.onPayload(body)`**：
   - 如果 provider 用的是 `pi-ai` / OpenAI SDK 已经带 `onPayload` 触发机制的 stack → 天然满足
   - 如果 provider 自己写 HTTP 客户端 → 必须在 `fetch` / `axios` 调用前主动触发 `options.onPayload?.(finalBody)`
   - 这一步是最容易漏的：很多第三方 provider 直接用 raw `fetch`，忘了触发 callback，wrapper 再怎么装也拿不到 body

**三步都做了，prompt-tracer 就能拿到完整 wire body；少做任一步，silently 失败（没有错误，只是 `wire_body` phase 不出现在 XML 里）。**

**针对 vLLM 的具体修复**（用户自己启用 vLLM，最常见场景）：
- 选项 A：给 `extensions/vllm/index.ts` 加 `wrapStreamFn`（upstream PR 或本地 patch）——最干净
- 选项 B：不改 vLLM 插件，改用 `extensions/openai` 通用 provider 指向 vLLM 的 baseUrl（vLLM 是 OpenAI-compatible）——openai 插件已经挂了 wrap hook，白嫖即可
- 选项 C：prompt-tracer 降级，靠 `llm_input` 记录文本层，viewer 明确标注 "wire body unavailable"

推荐 B 路径做 workaround，A 路径作为长期修复（写个 upstream PR）。

**补偿**：`llm_input` hook 给出的 `systemPrompt + prompt + historyMessages` 仍然覆盖了"发出去的信息"的 95%——只是差 provider 专有的那一层序列化细节。

**"差的那一层"具体是什么 —— 用 `learnings/mock_hi_prompts.txt` 举例**：

mock 文件第 266-589 行给出了 vLLM (OpenAI-compatible) 的真实 wire body，大致结构是：
```json
{
  "model": "qwen3.5-35b-a3b",
  "stream": true,
  "messages": [ { "role": "system", "content": "<#1 SYSTEM PROMPT 全文>" },
                { "role": "user",   "content": "hi" } ],
  "tools": [ ... 14 个 function schema ... ],
  "tool_choice": "auto",
  "temperature": 0,
  "max_tokens": <由 model 配置决定>
}
```

如果我们**只用 `llm_input` hook** 捕获，能写进 XML 的是：
- `systemPrompt`：上面 `messages[0].content` 的文本 ✅
- `prompt`：`"hi"` ✅
- `historyMessages`：`[]`（第一轮） ✅
- `imagesCount`：0 ✅
- `provider` / `model`：`vllm` / `qwen3.5-35b-a3b` ✅

**拿不到的**（也就是"差的那一层"）：
- `tools[]` 的完整 JSON schema 数组（14 个 function 定义） ❌
- `tool_choice`: `"auto"` / `"required"` / `{"type":"function", "function":{"name":"..."}}` ❌
- `temperature` / `max_tokens` / `top_p` 等 sampling 参数 ❌
- `stream: true` / `stream_options` 等传输模式 ❌
- **Anthropic 特有**：每条 message 上的 `cache_control: {"type":"ephemeral"}` 标记（决定 prompt cache 在哪截断）
- **Anthropic 特有**：`thinking: { type: "enabled", budget_tokens: 10000 }` extended thinking 配置
- **Anthropic 特有**：`tools[i].cache_control` 标记
- **OpenAI Responses API 特有**：`reasoning: { effort: "medium", summary: "auto" }`
- **Gemini 特有**：`generationConfig: { thinkingConfig: { thinkingBudget: 8192 } }`
- **所有 provider**：各自的 retry header / request id / provider-specific extensions

换句话说，**没有 `wire_body` 的 XML 里，看到的是"prompt 文本层"；有 `wire_body` 的 XML 里才能看到"这一轮到底用了多少 tool、tool_choice 强制了哪个、cache boundary 在哪、thinking 预算多少"**。对排查 cache miss、tool selection 异常、reasoning 配置这类问题，`wire_body` 是必需的。

---

### 2. Plugin 拿不到 tools array

**背景**：OpenClaw 在 `src/agents/pi-embedded-runner/run/attempt.ts:587` 定型 tools。之后触发 `llm_input` hook（L1828），但**这个 hook 的 event payload 里没有 tools 字段**——上一轮我们讨论 tool selection 时查过的。

**实际影响**：
- `llm_input` phase 写进 XML 的是 systemPrompt / prompt / history，**不含 tools 定义的 JSON schema**
- viewer 里看不到"这一轮 LLM 被告知有哪些工具"
- 只能从"发生的 tool_call"反推出"它至少看到了这几个工具"

**补偿路径**：
- `wire_body` phase 如果可用（见局限 1），HTTP body 里**原样包含 tools 字段**（Anthropic 和 OpenAI 的 wire format 都带 tools）——能看到真实 tool schema
- 所以实际上：用 bundled provider 时，tools 可以从 `wire_body` phase 里读到；用不开 wrap hook 的 provider 时，tools 完全看不到

**未来改进**：需要 core patch 加 `before_llm_request` hook 把 tools 暴露给插件（就是你上一轮问的那个想法）——但社区严格，不是这个 plan 的范围。

---

### 3. `before_message_write` 是同步 hook

**什么是 `before_message_write`**：每当一条消息（user / assistant / tool_result）要追加到 session JSONL 文件时，这个 hook 同步触发。

**同步的约束**：hook handler 必须立刻返回，不能 await 任何异步操作（包括磁盘 IO）。如果在这里写文件，会阻塞整个 agent 主循环。

**我们的做法**：handler 只做一件事——把 event 对象 push 到 `TraceSession.phases[]` 内存数组。真正的 XML 写盘发生在 `/trace_end` 或 session_end 时的异步 flush 阶段。

**实际影响**：trace 期间内存占用随 turn 数线性增长（每 turn 约几 KB～几 MB，取决于 prompt 大小）。长时间录制（几百轮）可能吃掉几百 MB 内存。边界情况处理：超过 `maxBytesPerPrompt * 100` 时强制写 `.partial.xml` checkpoint 并清空内存 phases。

---

### 4. 超大 trace viewer 性能

**背景**：viewer 纯 DOM 渲染，每个 phase 是一个 `<div>`，phase 之间用 SVG 画连线。

**问题**：如果一个 trace 有 100 轮、每轮 10 个 phase = 1000 个 DOM 节点 + 1000 条 SVG 连线，浏览器开起来已经明显发卡；5000+ 就基本不能用。

**预期负载**：正常对话 1-20 轮足够测试用，这个局限在 95% 场景下不触发。

**未来改进**：需要时加虚拟滚动（只渲染视口内的 turn），或者把 turn 列表改成折叠，点击才展开 phase 节点。

## 已决定的设计决策

1. **`/trace_start` 那一轮不包含在 trace 里**。trace 从**下一轮 user 消息**开始捕获。`/trace_start` 自身的命令处理 + 回复不进 trace 文件。
2. **不脱敏**。tool params / results / wire body 原样写入。目录权限 `0700`，由用户负责文件访问控制。
3. **Viewer 交付方式**：
   - `/trace_end` 的回复消息里包含 **gateway 机器上的 file:// 绝对路径**（主推荐，离线可用、双击即开）
   - **不追加 gateway HTTP URL**——因为 loopback bind 默认下远程打不开，给 URL 反而误导用户
   - 用户在手机飞书上收到的消息是"trace saved at `/home/.../traces/<id>.xml` 和 `viewer.html`——回到 gateway 机器双击 viewer.html 打开"
   - 如果用户明确开了 `gateway.bind=all` 或 Tailscale，手动访问 gateway URL 也能用（viewer 在 gateway 机器上对应的 HTTP route 保留），但不作为默认宣传
4. **Trace 文件不自动过期**。用户自己清理。

## 端到端验证

1. `pnpm install` → `pnpm build`
2. 在 Feishu/Telegram/Web 任一 channel 发 `/trace_start`
3. 正常对话若干轮（含工具调用）
4. 发 `/trace_end` → 插件回复 XML 路径 + viewer HTML 路径
5. 本地双击 viewer.html 或通过 gateway URL 打开
6. 验证：每 turn 展开 → phase 节点点击 → CDATA 内容匹配实际发送
7. 单元测试：`pnpm -F @openclaw/prompt-tracer test`
8. Lint / format：`pnpm check`
9. 若改动任何 SDK 表层或 config schema，跑对应的 `:gen` 命令（本插件不应触发）
