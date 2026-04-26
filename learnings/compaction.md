# OpenClaw Compaction 机制深度解析

> 目标读者：熟悉 LLM 上下文窗口限制和 KV cache，想理解 OpenClaw 如何处理长会话的"压缩"。

---

## 一、Compaction 是什么

**问题背景**：LLM 有上下文窗口（如 Claude 200K、GPT 128K），长会话迟早会溢出。

**Naive 做法**：
- 截断最老的消息 → 丢失早期决策和约束
- 滑动窗口 → Agent 忘记正在做什么

**OpenClaw 的做法**：**摘要式压缩 + 保留近期消息**。把旧消息用 LLM 压缩成摘要，新消息保持原样，整体控制在预算内。

```
会话消息流：
[sys][u1][a1][u2][a2][u3][a3]...[u30][a30]
  ↓ compaction
[sys][summary: "前面讨论了 X, Y, Z, 决定 A, 当前在做 B"][u26][a26]...[u30][a30]
```

Summary 由单独的 LLM call 生成（当前版本用 `reasoning: "high"` 以提高保留质量）。

---

## 二、三种触发时机

### 2.1 Preemptive Compaction（预检压缩）

**源文件**：[src/agents/pi-embedded-runner/run/preemptive-compaction.ts](src/agents/pi-embedded-runner/run/preemptive-compaction.ts)

**触发**：每次向 LLM 发起请求**之前**，估算 prompt 大小。

**决策逻辑**：

```typescript
const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
const toolResultPotential = estimateToolResultReductionPotential({...});

let route: PreemptiveCompactionRoute = "fits";
if (overflowTokens > 0) {
  if (toolResultReducibleChars <= 0) {
    route = "compact_only";              // 必须压缩
  } else if (toolResultReducibleChars >= truncateOnlyThresholdChars) {
    route = "truncate_tool_results_only"; // 截工具结果就够了
  } else {
    route = "compact_then_truncate";      // 压缩 + 截工具结果
  }
}
```

**四种路由**：

| Route | 含义 |
|-------|------|
| `fits` | 一切正常，直接发请求 |
| `compact_only` | 需要 compaction（tool result 省不出足够空间） |
| `truncate_tool_results_only` | 只截老的 tool result 就够（便宜） |
| `compact_then_truncate` | 先压缩消息，再进一步截 tool result |

**关键设计**：优先截 tool result 而不是压缩对话。因为 tool result 通常是**可重新获取的**（重新运行 memory_search 就能拿到），而对话历史里的用户意图丢了就丢了。

### 2.2 Mid-Run Compaction（运行中压缩）

LLM 返回 "context length exceeded" 错误时触发。preemptive 已经尽力，但 token 估算不准（`SAFETY_MARGIN = 1.2` 只覆盖 20% 误差），真实请求仍可能超限。

**处理**：
1. 捕获 LLM 错误
2. 触发 compaction
3. 重试请求

### 2.3 Memory Flush（压缩前的 silent turn）

**在 compaction 真正开始之前**，先给 Agent 一个机会写下短期记忆。这不算 compaction 本身，但和 compaction 耦合。

**流程**：
```
检测到需要 compaction
    ↓
检查 agents.defaults.compaction.memoryFlush.enabled（默认 true）
    ↓
向 Agent 注入一条 silent turn：
  "Pre-compaction memory flush. Store durable memories only in
   memory/YYYY-MM-DD.md. Treat MEMORY.md as read-only."
    ↓
Agent 用 Edit/Write 工具写 memory/YYYY-MM-DD.md
    ↓
然后才真正 compaction
```

这是个**重要的数据保护**：在会话被摘要前，给 Agent 一次"手动备份"的机会，避免摘要过度损失细节。

---

## 三、压缩算法细节

### 3.1 消息分块

**源文件**：[src/agents/compaction.ts](src/agents/compaction.ts)

消息被分成 N 个 chunk（默认 `DEFAULT_PARTS = 2`），每个 chunk 单独压缩，最后合并：

```typescript
export function splitMessagesByTokenShare(
  messages: AgentMessage[],
  parts = DEFAULT_PARTS,
): AgentMessage[][] {
  // 总 token / parts = 目标每块 token
  const targetTokens = totalTokens / normalizedParts;
  // 按目标 token 切分，保持 tool_call 和 tool_result 不跨块
}
```

**关键约束**：**tool_call 和 tool_result 必须在同一 chunk**。如果切在中间，摘要看到 "Agent 调用了 tool X" 但看不到结果，会困惑。代码里用 `pendingToolCallIds` Set 跟踪未完成的 tool_call：

```typescript
if (message.role === "assistant") {
  const toolCalls = extractToolCallsFromAssistant(message);
  pendingToolCallIds = new Set(toolCalls.map(t => t.id));
  pendingChunkStartIndex = current.length - 1;  // 记录边界
}
else if (message.role === "toolResult") {
  pendingToolCallIds.delete(resultId);
  // 所有 tool_call 都闭合了，才考虑切块
  if (pendingToolCallIds.size === 0 && currentTokens > targetTokens) {
    splitCurrentAtPendingBoundary();
  }
}
```

### 3.2 Summarization 指令

每个 chunk 发给 LLM 时，带一段**必保留**提示（[compaction.ts:24-37](src/agents/compaction.ts#L24-L37)）：

```
MUST PRESERVE:
- Active tasks and their current status (in-progress, blocked, pending)
- Batch operation progress (e.g., '5/17 items completed')
- The last thing the user requested and what was being done about it
- Decisions made and their rationale
- TODOs, open questions, and constraints
- Any commitments or follow-ups promised

PRIORITIZE recent context over older history. The agent needs to know
what it was doing, not just what was discussed.
```

这是 **LLM 总结的系统级约束**——不要压成"他们聊了天气和 Rust"，要压成"用户让 Agent 修 bug，Agent 改了文件 A 和 B，正在测试 C"。

### 3.3 Identifier 保留

**问题**：LLM 摘要容易把 `"req_abc123def456"` 简写成 `"the request"`，导致后续无法追溯。

**策略**（`AgentCompactionIdentifierPolicy`）：

| Policy | 行为 |
|--------|------|
| `strict`（默认） | 注入指令："Preserve all opaque identifiers exactly as written" |
| `custom` | 用用户自定义的 identifier instructions |
| `off` | 不做额外保护 |

默认 prompt 包含（[compaction.ts:38-40](src/agents/compaction.ts#L38-L40)）：

```
Preserve all opaque identifiers exactly as written (no shortening or
reconstruction), including UUIDs, hashes, IDs, tokens, API keys,
hostnames, IPs, ports, URLs, and file names.
```

这是 OpenClaw 在 real-world agent 使用中踩过的坑总结出来的防御。

### 3.4 Tool Result Details 脱敏

**关键安全点**（[compaction.ts:104-106](src/agents/compaction.ts#L104-L106)）：

```typescript
// SECURITY: toolResult.details can contain untrusted/verbose payloads;
// never include in LLM-facing compaction.
const safe = stripToolResultDetails(messages);
```

`toolResult.details` 字段可能含有：
- 从 web_search 抓到的外部 HTML
- 从 file_read 读到的超长文件
- 用户粘贴的敏感数据

这些内容**不发给 summarization LLM**。Summary 只基于 tool call 的元信息（调用了什么工具、返回成功/失败）。

### 3.5 Token 估算与 Safety Margin

```typescript
export const SAFETY_MARGIN = 1.2; // 20% buffer for estimateTokens() inaccuracy
export const SUMMARIZATION_OVERHEAD_TOKENS = 4096;
```

- `estimateTokens()` 是字符/4 的启发式估算，对 CJK、emoji、code 不准
- 乘 1.2 做安全 buffer
- summarization 本身还需要 4096 tokens（system prompt + 指令 + 之前的 summary）

---

## 四、配置完整表

```yaml
agents:
  defaults:
    compaction:
      reserveTokensFloor: 8192      # 最少保留给生成的 token 数（底线）
      identifierPolicy: "strict"    # strict | custom | off
      identifierInstructions: ""    # policy=custom 时生效
      memoryFlush:
        enabled: true               # 默认开
        softThresholdTokens: 4000   # 软阈值：flush 前的 token 预算
        forceFlushTranscriptBytes: 2097152  # 2MB transcript 强制 flush
        prompt: ""                  # 覆盖默认 user-facing flush prompt
        systemPrompt: ""            # 覆盖默认 system prompt
```

### 关键参数

| 参数 | 作用 | 默认值 |
|------|------|--------|
| `reserveTokensFloor` | 保留给 LLM 生成输出的 token 底线 | 8192 |
| `memoryFlush.enabled` | 是否在 compaction 前做 memory flush | `true` |
| `memoryFlush.softThresholdTokens` | 触发 flush 的软阈值 | 4000 |
| `memoryFlush.forceFlushTranscriptBytes` | transcript 超过此大小强制 flush | 2 MB |
| `identifierPolicy` | 摘要时是否严格保留 ID | `strict` |

---

## 五、Hook 生命周期

OpenClaw 的 Plugin Hook 系统提供 compaction 相关 hook（`src/plugins/types.ts`）：

```
before_compaction  → compaction 开始前（插件可做最后准备，如写缓存）
after_compaction   → compaction 完成后（插件可读取摘要，如 memory-core 更新 recall signals）
```

### 5.1 memory-core 对 compaction 的响应

memory-core 的 `flushPlanResolver`（[extensions/memory-core/src/flush-plan.ts:95](extensions/memory-core/src/flush-plan.ts#L95)）：

```typescript
export function buildMemoryFlushPlan(params): MemoryFlushPlan | null {
  const defaults = cfg?.agents?.defaults?.compaction?.memoryFlush;
  if (defaults?.enabled === false) return null;  // 用户禁用就不 flush

  return {
    softThresholdTokens,
    forceFlushTranscriptBytes,
    reserveTokensFloor,
    prompt: "Pre-compaction memory flush. Store durable memories only in memory/YYYY-MM-DD.md. ...",
    systemPrompt: "Pre-compaction memory flush turn. ...",
    relativePath: `memory/${dateStamp}.md`,  // 今天的日记文件路径
  };
}
```

**重点指令**（注入到 flush turn 的 system prompt）：
```
Treat workspace bootstrap/reference files such as MEMORY.md, DREAMS.md,
SOUL.md, TOOLS.md, and AGENTS.md as read-only during this flush;
never overwrite, replace, or edit them.
```

强制 Agent 只能写 `memory/YYYY-MM-DD.md`，**不能**污染 MEMORY.md。

### 5.2 为什么是 silent turn

Flush 插入的是一条 **silent turn**（不向用户显示）。Agent 完成 flush 后：
- 常见回复：`NO_REPLY`（OpenClaw 特殊 token，不发送给用户）
- 偶尔回复：只有 Agent 真觉得需要告知用户才输出

用户端完全感受不到有 flush 发生，体验上像是"连续对话"。

---

## 六、Retry 和容错

### 6.1 Summarization 失败重试

**源文件**：[src/agents/compaction.ts](src/agents/compaction.ts) 使用 `retryAsync`。

Summarization 本身是个 LLM call，可能：
- 超时
- Rate limit
- 返回空/格式错误

OpenClaw 会 retry（指数退避），几次失败后用 fallback：`"No prior history."`（[compaction.ts:22](src/agents/compaction.ts#L22)），宁可丢失历史也不阻塞主流程。

### 6.2 Chunk 合并失败

当消息分成多 chunk，每 chunk 各自 summarize，最后合并：

```
chunk1 → summary1
chunk2 → summary2
...
[summary1, summary2, ...] → final_summary
```

合并步骤（[compaction.ts:24-37](src/agents/compaction.ts#L24-L37)）：

```typescript
const MERGE_SUMMARIES_INSTRUCTIONS = [
  "Merge these partial summaries into a single cohesive summary.",
  "MUST PRESERVE: ... (same as individual)",
].join("\n");
```

如果合并失败，直接拼接：`summary1 + "\n\n" + summary2`。不如统一摘要漂亮，但内容不丢。

### 6.3 Context Overflow 的防御式处理

```typescript
export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";
```

当连 compaction 后都放不下（极端场景），抛出明确错误让用户感知，而不是让 LLM 静默截断产生奇怪输出。

---

## 七、与 Prompt Cache 的关系

**Compaction 会使缓存失效**——这是 OpenClaw prompt cache 设计的重要约束。

### 7.1 为什么 compaction 会失效 cache

LLM 的 prompt cache 是 **prefix-based**：只要前 N 个字节相同，就复用 KV cache。Compaction 把老消息替换成 summary，改变了 prefix 字节，cache boundary 之后的所有内容都要重算。

### 7.2 OpenClaw 的应对

**cache boundary 的分层设计**（在 [src/agents/system-prompt.ts](src/agents/system-prompt.ts) 中）：

```
┌─── static zone (cache hit) ───┐
│  identity, skills, MEMORY.md  │  ← 不受 compaction 影响
├─── cache boundary ────────────┤
│  heartbeat, runtime info      │
│                               │
│  compacted messages:          │  ← compaction 只影响这里
│    [summary]                  │
│    [recent u/a]               │
│                               │
└───────────────────────────────┘
```

**策略**：把 compaction 放在动态区之后，**不破坏静态区**的 cache。Summary + recent 消息每次变化，但这部分本来就是动态的，不命中 cache 也不亏。

这就是为什么 MEMORY.md 是 context file（静态区），而不是"通过 tool call 注入"（动态区）——放静态区才能长期 cache。

### 7.3 Compaction 频率的经济学

太频繁 compact → 每次都失效后续所有 cache
太少 compact → 请求 token 爆炸

OpenClaw 的策略：
- **Preemptive 只在确实溢出时触发**（不为了省钱提前 compact）
- **优先截 tool result**（不动对话历史，cache 失效面小）
- **Memory flush 保护短期记忆**（compact 丢的信息有备份）

---

## 八、运行时可见性

### 8.1 日志

Compaction 走 subsystem logger（[compaction.ts:17](src/agents/compaction.ts#L17)）：

```typescript
const log = createSubsystemLogger("compaction");
```

运行时可以 filter 看：
```bash
./scripts/clawlog.sh --category compaction
# 或 tail -f ~/.openclaw/logs/gateway.log | grep compaction
```

关键日志事件：
- `compaction.start` — 触发，带 token 预算和消息数
- `compaction.summary_generated` — 每个 chunk 的 summary 长度
- `compaction.completed` — 最终 summary + 剩余消息数
- `compaction.failed` — 失败原因

### 8.2 Session Transcript 的 compaction 标记

JSONL 文件中会记录一条特殊类型：

```json
{"type": "compaction", "at": "2026-04-24T10:00:00Z", "originalMessages": 45, "remainingMessages": 10}
```

读取 session 时可以看到历史上的 compaction 事件（用来判断"这次是否已压缩过"，与 bootstrap 的 continuation 检测有关）。

---

## 九、设计洞察

### 9.1 Compaction 不是简单的"截断"

很多 agent 框架的 compaction ≈ 丢弃老消息。OpenClaw 把它当成**一级公民**设计：
- 有专门的算法（chunk + summarize + merge）
- 有 identifier 保留策略
- 有安全过滤（strip tool result details）
- 有 memory flush 配合
- 有 hook 接口让插件参与
- 有与 prompt cache 的协同设计

### 9.2 "压缩 + flush" 的组合拳

单独看 compaction：损失信息
单独看 flush：数据无序堆积
组合：**先让 Agent 把重要信息结构化写盘，再做摘要**

类似内存管理里的 "swap to disk"：把冷数据换出到文件系统，保留热数据在 RAM（prompt）。

### 9.3 Reserve Tokens 的意义

`reserveTokensFloor: 8192` 容易让人困惑："不是要省 token 吗？为什么要保留？"

因为：**LLM 的 context = input + output 共享预算**。如果 input 塞满 200K，LLM 就没空间生成输出了。8192 是给生成回复预留的"空闲容量"，类似内存里的 headroom。

### 9.4 "tool_call 和 tool_result 必须同块"

这个细节体现了 OpenClaw 对 LLM 行为的理解：
- Summary 里只有 "Agent 调用了 memory_search" 但没结果 → LLM 以为调用失败了
- 只有结果但没调用 → LLM 不知道结果来源
- 必须成对保留或成对丢弃（转成 summary 里的 "检索过 X 并找到 Y"）

这种"成对性"在 tool-use agent 里非常重要，是许多 naive 实现的 bug 来源。

---

## 十、源码导航

| 关注点 | 文件 |
|--------|------|
| 主 compaction 逻辑 | [src/agents/compaction.ts](src/agents/compaction.ts) |
| 预检压缩 | [src/agents/pi-embedded-runner/run/preemptive-compaction.ts](src/agents/pi-embedded-runner/run/preemptive-compaction.ts) |
| Tool result 截断估算 | [src/agents/pi-embedded-runner/tool-result-truncation.ts](src/agents/pi-embedded-runner/tool-result-truncation.ts) |
| Memory flush 计划生成 | [extensions/memory-core/src/flush-plan.ts](extensions/memory-core/src/flush-plan.ts) |
| Transcript repair（compaction 后修复 tool_use/result 配对） | [src/agents/session-transcript-repair.ts](src/agents/session-transcript-repair.ts) |
| Compaction retry 单测 | [src/agents/compaction.retry.test.ts](src/agents/compaction.retry.test.ts) |
| Identifier 保留策略测试 | [src/agents/compaction.identifier-policy.test.ts](src/agents/compaction.identifier-policy.test.ts) |
| Tool result 脱敏测试 | [src/agents/compaction.tool-result-details.test.ts](src/agents/compaction.tool-result-details.test.ts) |
| 官方文档 | [docs/concepts/compaction.md](docs/concepts/compaction.md)（如果存在） |
