# OpenClaw Memory 插件系统深度解析

> 目标读者：熟悉 LLM/RAG/vector DB，部署过 OpenClaw，想理解 memory 插件如何组织、如何介入 prompt 与工具调用。

---

## 一、Memory 在 OpenClaw 中的两种形态

OpenClaw 的"记忆"其实分两条独立通路，很多用户把它们混为一谈。先把这两条区分清楚：

### 1.1 静态 memory（Context Files）

这是文件形态的记忆，由 **bootstrap/context-files 机制** 注入 system prompt 的**静态区**（cache boundary 之上）。

- 文件路径：`<workspaceDir>/MEMORY.md`（也接受小写 `memory.md`）
- 加载方式：`loadWorkspaceBootstrapFiles()` 扫描 8 个固定文件名
- 注入位置：system prompt 的 Project Context section（L22 in `system-prompt.ts`）
- 特性：跨轮次稳定，命中 prompt cache；用户可手动编辑
- **不依赖任何 memory 插件**——即使完全禁用 memory-core，这条路径仍然生效

### 1.2 动态 memory（Memory Plugin）

这是由 memory 插件（memory-core / memory-lancedb / memory-wiki）提供的能力：

- **工具**：`memory_search`、`memory_get`、可选的 `memory_write`
- **Hook**：`before_prompt_build` 可以动态拼接摘要到 prompt
- **后端存储**：SQLite / LanceDB / QMD sidecar / Honcho 等
- **搜索能力**：关键词 + 向量 + hybrid rerank
- 特性：跨会话的结构化/半结构化数据，按需检索

**两者关系**：静态 memory 是"低信号、始终可见"（MEMORY.md 里写的几十条事实），动态 memory 是"高信号、按需调取"（向量库里可能有数千条片段）。

---

## 二、Plugin Slot 机制：为什么 memory 是"互斥"的

OpenClaw 用 **slot 系统** 管理某些只能有一个实现的能力类别（`src/plugins/slots.ts`）：

```typescript
const DEFAULT_SLOT_BY_KEY: Record<PluginSlotKey, string> = {
  memory: "memory-core",       // 默认 memory 实现
  contextEngine: "legacy",
};
```

**关键规则**：
- `memory` slot 在任一时刻只有一个 winner
- 用户安装了 `memory-lancedb` 并把它设为 `plugins.slots.memory = "memory-lancedb"` → memory-core 自动被 disable
- 这是由 `applyExclusiveSlotSelection()` 自动完成的（slots.ts:76-162）

**为什么互斥**：多个 memory 插件同时注册 `memory_search` 工具会冲突；更根本的，每个 memory 后端的 embedding/索引是绑定的，不能混用。

**不互斥的例外**：`memory-wiki` 在 manifest 里没声明 `kind: "memory"`，它是**独立的知识库插件**（只做 compile + wiki_search），可以和任一 memory slot 插件并存。README 里也明说："This plugin is separate from the active memory plugin."

---

## 三、三个 bundled memory 插件对比

### 3.1 memory-core（默认）

**定位**：零配置开箱即用的默认后端，覆盖最基本的长期记忆 + 搜索场景。

**存储**：
- `MEMORY.md` — 长期记忆（durable facts）
- `memory/YYYY-MM-DD.md` — 每日笔记
- `DREAMS.md` — 可选的"做梦"整理报告
- 索引：SQLite（builtin）或 QMD sidecar（`memory.backend = "qmd"`）

**工具**：
- `memory_search` — 语义 + 关键词搜索
- `memory_get` — 按路径/行号读取

**Manifest schema 中可见的配置**（[extensions/memory-core/openclaw.plugin.json](extensions/memory-core/openclaw.plugin.json)）：
```yaml
plugins:
  entries:
    memory-core:
      config:
        dreaming:                    # "做梦"实验功能
          enabled: false             # 默认关
          frequency: "0 3 * * *"     # cron 表达式
          timezone: "Asia/Shanghai"
          phases:
            light:                   # 轻睡眠：收集短期信号
              enabled: true
              lookbackDays: 7
              limit: 50
            rem:                     # REM：找模式
              enabled: true
              minPatternStrength: 0.6
            deep:                    # 深睡眠：晋升到 MEMORY.md
              enabled: true
              minScore: 0.7
              minRecallCount: 3
              minUniqueQueries: 2
```

**Dreaming 机制简述**：定期扫描短期 recall 历史 → 筛选高频且多样化的查询命中项 → 晋升到 `MEMORY.md` 长期记忆。类似 RAG 领域的"continual learning"，但完全本地、可审查。

### 3.2 memory-lancedb

**定位**：基于 LanceDB 的向量后端，适合有大量半结构化对话数据且需要高质量向量检索的用户。

**存储**：
- LanceDB 本地数据库（默认 `~/.openclaw/memory/lancedb`）
- 必须配置 OpenAI 或兼容 provider 的 embedding API（`embedding.apiKey` 必填）

**必填配置**（manifest 强制）：
```yaml
plugins:
  entries:
    memory-lancedb:
      config:
        embedding:
          apiKey: ${OPENAI_API_KEY}
          model: "text-embedding-3-small"
          baseUrl: "https://api.openai.com/v1"  # 可换成 Ollama/本地：http://localhost:11434/v1
          dimensions: 1536
        dbPath: "~/.openclaw/memory/lancedb"
        autoCapture: true       # 自动从对话中捕获要点
        autoRecall: true        # 自动把相关记忆注入上下文
        captureMaxChars: 500    # 超长消息不走 auto-capture
```

**与 memory-core 的关键差异**：
- memory-core 的默认 builtin 后端是 **SQLite + 可选向量列**
- memory-lancedb 是 **专职向量库**，索引规模大时检索质量和速度更好
- memory-lancedb 必须有外部 embedding service；memory-core builtin 可以跑纯关键词搜索

**启用方式**：
```yaml
plugins:
  slots:
    memory: "memory-lancedb"  # 自动 disable memory-core
  entries:
    memory-lancedb:
      enabled: true
      config: { ... }
```

### 3.3 memory-wiki

**定位**：**不是 memory slot 的替代品**，而是一个可选的 **知识库/wiki 层**，并行运行在 active memory 插件之上。

**提供的工具**：
- `wiki_search` / `wiki_get` — wiki 专属搜索
- `wiki_apply` — 结构化写入（claims + evidence + confidence）
- `wiki_lint` / `wiki_status`

**三种模式（`vaultMode`）**：

| 模式 | 行为 | 用途 |
|------|------|------|
| `isolated`（默认） | 独立 vault，不读取 memory-core 私有数据 | 纯 wiki 用途，边界清晰 |
| `bridge` | 通过 public 接口读取 active memory 插件的 artifacts、dream reports、daily notes | 想让 wiki 汇总 memory-core 的成果 |
| `unsafe-local` | 绕过公开接口直接读 memory-core 私有路径 | 实验性，不跨机器可用 |

**vault 结构**：
```
<vault>/
  AGENTS.md
  WIKI.md
  index.md
  entities/          # 实体页面
  concepts/          # 概念页面
  syntheses/         # 综合/总结页
  sources/           # 原始来源（可追溯）
  reports/           # 自动生成的 dashboard
  _attachments/
  .openclaw-wiki/cache/   # 机器可读的 digest（agent-digest.json / claims.jsonl）
```

**与 Obsidian 集成**：当 `vault.renderMode = "obsidian"` 且 `obsidian.useOfficialCli = true`，compile 阶段会生成 Obsidian 兼容的 markdown（双向链接、dataview 格式），可以直接在 Obsidian 中浏览这个 vault。

**典型搭配**：
```
memory-core（或 memory-lancedb） ──>  动态 recall
        │
        │ bridge mode 读取
        ▼
memory-wiki ──> 编译成结构化知识库，人类可读 + Agent 用 wiki_search
```

---

## 四、Memory 插件如何介入运行时

理解下面几个介入点，就理解了 memory 插件在 OpenClaw 中的"存在感"。

### 4.1 启动期：插件激活

```
plugin discovery → manifest 校验 → slot 选择（memory slot winner）→ register(api)
                                                                         │
                                    ┌────────────────────────────────────┘
                                    ▼
                          api.registerTool("memory_search", ...)
                          api.registerTool("memory_get", ...)
                          api.registerHook("before_prompt_build", ...)
                          api.registerHook("after_tool_call", ...)
                          api.registerHttpRoute("/memory/status", ...)
                          api.registerService("dreaming-cron", ...)
```

### 4.2 Prompt 构建期：`before_prompt_build` hook

memory 插件通过这个 hook 往 system prompt 注入动态摘要。参见 `PluginHookBeforePromptBuildResult`：

```typescript
{
  prependSystemContext?: string;    // 静态区（缓存）
  prependContext?: string;          // 动态区（不缓存）
  appendSystemContext?: string;     // 静态区（缓存）
}
```

memory-core 的选择取决于内容：
- 如果注入的是**稳定的"最重要记忆 top-N"** → 放进 `prependSystemContext`（命中 cache）
- 如果注入的是**实时 recall 结果** → 放进 `prependContext`（不缓存，每轮重新计算）

### 4.3 Tool 调用期：ReAct 循环中的 memory_search

```
Agent: "用户问的是去年某项目的代码，我需要查 memory"
  ↓ 输出 tool_call: memory_search({query: "去年 XX 项目", limit: 5})
  ↓
OpenClaw runtime: 查 plugin registry → 找到 memory-core 注册的 memory_search tool
  ↓
memory-core handler:
  1. hybrid search (BM25 + vector)
  2. 取 top-N
  3. decorateCitations()（按 citationsMode 决定是否附 Source 行）
  4. clampResultsByInjectedChars()（预算控制）
  5. queueShortTermRecallTracking()（记录本次 recall，供 dreaming 用）
  ↓
返回 MemorySearchResult[] → 回填到会话 → 再次调用 LLM
```

关键源文件 [extensions/memory-core/src/tools.ts](extensions/memory-core/src/tools.ts)：
- `memory_search` handler 入口
- 调用 `tools.shared.ts` 中的 `createMemoryTool()` 创建统一封装
- 通过 `resolveMemoryCorePluginConfig()` 拿到配置
- 走 `loadMemoryToolRuntime()` 加载重量级索引模块（lazy）

### 4.4 Compaction 期：memory flush（**最主要的存储触发点**）

这是 memory-core 触发记忆落盘**最高频**的路径，绝大多数 `memory/*.md` 文件都由这条路径产生。

**触发条件**（[src/auto-reply/reply/agent-runner-memory.ts:457](src/auto-reply/reply/agent-runner-memory.ts#L457) `runMemoryFlushIfNeeded`）：

- 当前 session 的 token 用量 >= `DEFAULT_MEMORY_FLUSH_SOFT_TOKENS`（默认 **4000 tokens**，距离硬上限还留有 compaction reserve），或
- transcript 字节数 >= `DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES`（默认 **2 MB**）

且同时满足：
- `agents.defaults.compaction.memoryFlush.enabled = true`（默认开）
- 不是 CLI / heartbeat provider（避免在非交互 turn 里乱写）
- 本次 compaction 周期内还没 flush 过（每轮只 flush 一次）

**执行流程（关键：memory-core 只编排，不自己写磁盘）**：

```
runMemoryFlushIfNeeded 判断阈值命中
   ↓
memory-core 的 buildMemoryFlushPlan() 生成一对 prompt:
    • systemPrompt: "Pre-compaction memory flush turn. The session is near
                     auto-compaction; capture durable memories to disk.
                     Store durable memories only in memory/YYYY-MM-DD.md..."
    • userPrompt:   "Pre-compaction memory flush.
                     Store durable memories only in memory/YYYY-MM-DD.md
                     (create memory/ if needed).
                     Treat MEMORY.md, DREAMS.md, SOUL.md, TOOLS.md, AGENTS.md
                     as read-only during this flush.
                     If memory/YYYY-MM-DD.md already exists, APPEND only."
   ↓
runEmbeddedPiAgent 跑一次 "silent turn"
   ↓
★ Agent 用普通 write / edit 工具写磁盘
   ← 没有 memory_write 工具，写入走的是通用文件 IO
   ↓
File watcher (chokidar) 检测到 memory/*.md 变更 → 标脏 → 懒惰重建索引
```

**关键认知**：
- **memory-core 不是 writer**，它是 orchestrator + indexer。
- 真正写 `memory/YYYY-MM-DD.md` 的是 agent，用的是通用 `write` 工具。
- 这样设计的好处：memory-core 不用重复实现 IO / 权限 / 沙箱，agent 工具链已经覆盖。

相关源码：
- 触发判断：[src/auto-reply/reply/agent-runner-memory.ts:457](src/auto-reply/reply/agent-runner-memory.ts#L457)
- Prompt 模板（固定文案）：[extensions/memory-core/src/flush-plan.ts:13-41](extensions/memory-core/src/flush-plan.ts#L13-L41)
- Plan builder：[extensions/memory-core/src/flush-plan.ts:95-139](extensions/memory-core/src/flush-plan.ts#L95-L139)

### 4.5 Dreaming 期（可选）：离线整理（memory-core 自己写）

当 `dreaming.enabled = true`，memory-core 通过 `api.registerService()` 注册 cron job，按 `frequency` 周期性跑三阶段流水线。这条路径的写入方是 **memory-core 自己**（不经过 agent），因为它是完全内部的状态持久化，不是用户对话内容。

| 阶段 | 类比 | 动作 | 写入目标 |
|---|---|---|---|
| `light` | 浅睡 | 扫最近 session，抽关键事件 | `memory/dreaming/light/YYYY-MM-DD.md` |
| `rem` | REM | 把 light 阶段的内容重组、去重、加结构 | `memory/dreaming/rem/YYYY-MM-DD.md` |
| `deep` | 深睡 | 评估 `memory/.dreams/short-term-recall.json` 里被反复召回的条目，筛选高价值内容 | **晋升到 `MEMORY.md`** |

`deep` 阶段是 `MEMORY.md` 唯一被插件自动写入的路径（正常 flush 明确禁止动 MEMORY.md，日常使用时 MEMORY.md 只能由用户手动编辑或 dreaming 深睡晋升）。

**触发时机**：空闲时 / cron 定时（**不是**每轮对话触发）。用户看不到这个过程，只在下次 `memory_search` 时感知到"诶，上次聊的事情它现在能想起来了"。

这是 OpenClaw 独有的设计——传统 vector store 里数据一旦入库就静态化，dreaming 相当于给 memory 加了一个"持续学习"的消化层。

源码：[extensions/memory-core/src/dreaming-markdown.ts:37](extensions/memory-core/src/dreaming-markdown.ts#L37)，[extensions/memory-core/src/short-term-promotion.ts](extensions/memory-core/src/short-term-promotion.ts)。

### 4.6 用户显式要求：agent 手动写（memory-core 被动索引）

当用户说"记一下 X"或"把这个存到 memory 里"，agent 直接用通用 `write` 工具写 `memory/YYYY-MM-DD.md`。memory-core 在这条路径上**没有主动触发任何逻辑**，只是 file watcher 事后把新文件加入索引。

严格说这条不算"memory-core 触发"，算"agent 触发，memory-core 跟进索引"。但从用户视角看仍然是 memory 系统的一部分，列在这里完整起见。

### 4.7 三条触发路径速查表

| 场景 | 触发者 | 写磁盘的是谁 | 频率 | 典型写入目标 |
|---|---|---|---|---|
| **Pre-compaction flush** | memory-core（token 阈值） | agent（通用 `write` 工具） | 每次 session 接近 compaction | `memory/YYYY-MM-DD.md`（追加） |
| **Dreaming light / rem** | memory-core（cron） | memory-core 自己 | 周期（默认每天 03:00） | `memory/dreaming/{light,rem}/YYYY-MM-DD.md` |
| **Dreaming deep 晋升** | memory-core（深睡阶段） | memory-core 自己 | 更低频，只选高价值条目 | `MEMORY.md`（追加） |
| **用户显式让记** | 用户 | agent（通用 `write` 工具） | 按需 | 任意（agent 决定） |

**一句话识别信号**：日志里看到 `"Pre-compaction memory flush turn."` 开头的 system prompt，就是 4.4 在跑（目前最高频的写路径）。

---

## 五、配置速查表

### 5.1 切换 memory 后端

```yaml
# 选项 A：用 memory-core（默认），保持零配置
# 什么都不用改

# 选项 B：memory-core + QMD sidecar（需装 qmd）
memory:
  backend: "qmd"

# 选项 C：换成 memory-lancedb（需 embedding API）
plugins:
  slots:
    memory: "memory-lancedb"
  entries:
    memory-lancedb:
      enabled: true
      config:
        embedding:
          apiKey: ${OPENAI_API_KEY}
```

### 5.2 关闭/限制 memory

```yaml
# 完全禁用 memory 插件（但 MEMORY.md 仍会作为 context file 注入 prompt）
plugins:
  entries:
    memory-core:
      enabled: false

# 保留插件，但关掉向量搜索（只允许文本读取）
agents:
  defaults:
    memorySearch:
      enabled: false

# 关闭群聊里的引用来源注入
memory:
  citations: "off"   # 默认 "auto"：私聊开、群聊关
```

### 5.3 额外索引路径（让 agent 能搜到 workspace 外的文档）

```yaml
agents:
  defaults:
    memorySearch:
      extraPaths:
        - "~/projects/docs"
        - "~/notes/alpha.md"
      multimodal:
        enabled: true
        modalities: ["image", "audio"]
```

### 5.4 启用 dreaming

```yaml
plugins:
  entries:
    memory-core:
      config:
        dreaming:
          enabled: true
          frequency: "0 3 * * *"   # 每天 3 点跑一次
          phases:
            deep:
              minScore: 0.7
              minRecallCount: 3
```

### 5.5 启用 memory-wiki 作为知识库层

```yaml
plugins:
  entries:
    memory-wiki:
      enabled: true
      config:
        vaultMode: "bridge"        # 从 memory-core 读 artifacts
        vault:
          path: "~/.openclaw/wiki/main"
          renderMode: "obsidian"
        obsidian:
          enabled: true
          useOfficialCli: true
        bridge:
          enabled: true
          readMemoryArtifacts: true
          indexDreamReports: true
        render:
          createBacklinks: true
          createDashboards: true
```

---

## 六、常见误区

### 误区 1：禁用 memory 插件就没有记忆了

错。`MEMORY.md` 作为 context file 会被独立机制（bootstrap-files）加载到 system prompt，和 memory 插件无关。想彻底清空记忆需要：
1. 禁用 memory 插件
2. 删除 `<workspaceDir>/MEMORY.md`
3. 删除 `<workspaceDir>/memory/` 目录

### 误区 2：citationsMode = "off" 会让 prompt 里没有 memory

错。citationsMode 只控制 snippet 末尾的 `Source: path#Lx` 行是否附加，snippet 正文永远会回到 prompt。真正控制"memory 是否进入 prompt"的是插件启用状态 + Agent 自己的 ReAct 决策。

### 误区 3：memory-wiki 可以替代 memory-core

错。memory-wiki 没声明 `kind: "memory"`，不能占用 memory slot。它是**并列工具**，提供 `wiki_*` 系列工具。想用 wiki 的话，memory-core（或其他 memory 插件）仍需要运行。

### 误区 4：向量搜索对所有模型都能用

错。memory-lancedb 必须配置外部 embedding API；memory-core builtin 的向量列需要兼容的 embedding provider（OpenAI / Voyage / Mistral / Gemini 自动检测）。如果一个 key 都没配，memory_search 会回退到**纯关键词搜索**（BM25 或 LIKE）。

### 误区 5：memory 越大越好

错。`MEMORY.md` 作为静态 context file 每轮都注入 prompt，太大会：
1. 吃 cache boundary 以上的字节预算
2. 降低信噪比（淹没真正有用的信息）
3. 推高 cost（即使命中 cache 也占 token）

推荐 `MEMORY.md` 控制在几 KB 以内，把详细内容下沉到动态 memory（走 `memory_search` 按需调取）。

---

## 七、进阶：自定义 memory 插件

如果 bundled 的三个插件都不满足需求（比如想接 Pinecone/Weaviate/Chroma），可以写自己的 memory plugin：

1. **Manifest**：`openclaw.plugin.json` 中声明 `"kind": "memory"`
2. **Entry**：用 `definePluginEntry` + `register(api)` 注册 `memory_search`/`memory_get` 工具
3. **Hook**（可选）：注册 `before_prompt_build` 注入自动摘要
4. **Config schema**：定义 `configSchema` JSON Schema，用户放在 `plugins.entries.<id>.config`
5. **SDK**：只能从 `openclaw/plugin-sdk/*` 导入，不能触碰 `src/**`

参考 [extensions/memory-core/](extensions/memory-core/) 和 [extensions/memory-lancedb/](extensions/memory-lancedb/) 的源码结构。

---

## 八、源码导航

| 关注点 | 文件 |
|--------|------|
| Slot 机制与 memory 默认值 | [src/plugins/slots.ts](src/plugins/slots.ts) |
| MemoryConfig 类型定义 | [src/config/types.memory.ts](src/config/types.memory.ts) |
| MemorySearchConfig 与默认值 | [src/config/types.tools.ts:334](src/config/types.tools.ts#L334), [src/agents/memory-search.ts:150](src/agents/memory-search.ts#L150) |
| memory-core 工具入口 | [extensions/memory-core/src/tools.ts](extensions/memory-core/src/tools.ts) |
| citations 策略 | [extensions/memory-core/src/tools.citations.ts](extensions/memory-core/src/tools.citations.ts) |
| dreaming 流水线 | [extensions/memory-core/src/dreaming.test.ts](extensions/memory-core/src/dreaming.test.ts)（从测试读出结构） |
| memory-lancedb manifest | [extensions/memory-lancedb/openclaw.plugin.json](extensions/memory-lancedb/openclaw.plugin.json) |
| memory-wiki README | [extensions/memory-wiki/README.md](extensions/memory-wiki/README.md) |
| memory 官方文档（Mintlify） | [docs/concepts/memory.md](docs/concepts/memory.md) |
