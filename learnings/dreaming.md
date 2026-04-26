# OpenClaw Dreaming 机制深度解析

> 目标读者：熟悉 LLM、RAG、vector memory，想理解 OpenClaw 如何把"短期记忆"自动晋升到"长期记忆"。

---

## 一、为什么叫 "Dreaming"

`memory-core` 用人类睡眠周期做类比，把**离线记忆整理**拆成三个阶段：

| 阶段 | 人类睡眠类比 | 实际工作 |
|------|-------------|---------|
| Light Sleep（浅睡眠） | 巩固白天的记忆片段 | 扫描 `memory/YYYY-MM-DD.md` 等每日笔记，生成"信号快照" |
| REM（快速眼动期） | 把碎片记忆关联起来，做梦 | 在 session 历史中找"模式"（相同主题被反复提到、高频 recall） |
| Deep Sleep（深睡眠） | 把重要记忆**固化**到长期 | 通过阈值的候选 → **APPEND 到 `MEMORY.md`** |

这不是 marketing 修辞，源码里是字面用 `light`/`rem`/`deep` 分阶段（`dreaming-phases.ts`）。

### 核心类比

传统 RAG：数据入库就静态化（"记忆是死的"）
OpenClaw：每天晚上跑一个 cron job，**重新打分、重新筛选、有选择地晋升**（"记忆会消化"）

这本质是 **continual learning for memory**：把高频被检索的内容识别出来，提炼到"长期"那一层，让 prompt 的静态区命中率更高。

---

## 二、三阶段流水线

### 2.1 Light Sleep（收集信号）

**源文件**：[extensions/memory-core/src/dreaming-phases.ts](extensions/memory-core/src/dreaming-phases.ts)

**输入**：
- `memory/YYYY-MM-DD.md`（每日笔记，由 memory flush 写入）
- session transcript（conversation 历史，JSONL 格式）

**处理**：
1. 按 `lookbackDays`（默认 7 天）回溯扫描
2. 把每条笔记拆分成 chunk（最多 `DAILY_INGESTION_MAX_CHUNK_LINES = 4` 行/块）
3. 通过 `dedupeSimilarity`（默认 0.x）去重
4. 计算初始 score（`DAILY_INGESTION_SCORE = 0.62`）
5. 写入 **short-term promotion store**（`memory/.dreams/` 下的 JSON 文件）

**不做什么**：不写 `MEMORY.md`。只是"把白天的内容摆到床头柜上准备挑选"。

### 2.2 REM Sleep（找模式）

**输入**：short-term promotion store + recall 历史（`recordShortTermRecalls()` 记录的每次 memory_search 命中）

**处理**：
1. 聚合相同主题的 recall 次数
2. 计算 `uniqueQueries`：同一条笔记被**多少个不同查询**命中过
3. 计算 `signalCount`：recall 频次 + daily 出现次数
4. 通过 `minPatternStrength`（默认 0.6）过滤

**特色**：一条笔记在 REM 阶段能通过，不是因为它"新"或"长"，而是因为它**被反复查**——从使用信号反推价值。

### 2.3 Deep Sleep（写入 MEMORY.md）

**源文件**：[extensions/memory-core/src/short-term-promotion.ts:1280-1360](extensions/memory-core/src/short-term-promotion.ts#L1280-L1360)

**阈值**（配置项）：
```yaml
phases:
  deep:
    minScore: 0.7          # 综合分阈值
    minRecallCount: 3      # 至少被 recall 3 次
    minUniqueQueries: 2    # 至少被 2 种不同查询命中
    recencyHalfLifeDays: 14 # 最近 14 天的衰减半衰期
    maxAgeDays: 90         # 超过 90 天不再晋升
    limit: 10              # 单次最多晋升 10 条
```

**筛选逻辑**（关键代码）：
```typescript
options.candidates
  .filter((candidate) => {
    if (candidate.promotedAt) return false;                  // 已晋升的跳过
    if (candidate.score < minScore) return false;            // 分数不够
    if (candidateSignalCount < minRecallCount) return false; // recall 不够多
    if (uniqueQueries < minUniqueQueries) return false;      // 查询多样性不够
    if (maxAgeDays >= 0 && candidate.ageDays > maxAgeDays) return false; // 太老
    return true;
  })
  .slice(0, limit);                                          // 限流
```

**写入方式（APPEND-ONLY）**：
```typescript
const existingMemory = await fs.readFile(memoryPath, "utf-8").catch(/*ENOENT→""*/);
const existingMarkers = extractPromotionMarkers(existingMemory);  // 防重复的 marker
const toAppend = selected.filter(c => !existingMarkers.has(c.key));

const header = existingMemory.trim() ? "" : "# Long-Term Memory\n\n";
const section = buildPromotionSection(toAppend, nowMs, timezone);
await fs.writeFile(memoryPath, `${header}${existingMemory}\n${section}`);
```

**关键设计**：
- **只 APPEND**：不修改已有内容，避免破坏用户手写的 memory
- **用 marker 防重复**：每条晋升带 `<!-- openclaw:promo:<key> -->` 式 marker，重复跑不会写第二次
- **读旧 → 拼新 → 整体写回**：原子操作（+ 锁文件），防止并发写坏文件

---

## 三、调度机制：Managed Cron Job

### 3.1 自动注册

源文件 [extensions/memory-core/src/dreaming.ts:29-30](extensions/memory-core/src/dreaming.ts#L29-L30)：

```typescript
const MANAGED_DREAMING_CRON_NAME = "Memory Dreaming Promotion";
const MANAGED_DREAMING_CRON_TAG = "[managed-by=memory-core.short-term-promotion]";
```

memory-core 启用 `dreaming.enabled = true` 后，自动：
1. 检测是否已有 managed cron（通过 tag 识别）
2. 没有 → 创建一个 `schedule: { kind: "cron", expr: "0 3 * * *", tz }` 的 job
3. 已有但 frequency/timezone 变了 → 更新
4. 已禁用 → 移除

这用的是 OpenClaw 的 **Cron Service**（`api.registerService` 注册），不是系统 crontab。

### 3.2 触发

Cron 到点 → OpenClaw 向主 session 发送一条 **SystemEvent 消息**：
```typescript
payload: { kind: "systemEvent", text: "__openclaw_memory_core_short_term_promotion_dream__" }
```

Agent 接收到这条 token 化的事件 → memory-core 的 hook 识别 → 触发 `runDreamingSweepPhases()`。

这设计精巧：Agent 运行循环里**多了一个"定时 tick"**，不需要独立进程，也能被 Agent 的 observability 工具观测到（日志、错误处理都走主循环）。

### 3.3 legacy 迁移

老版本 memory-core 有两个独立 cron（light/rem），新版本合并成一个。源码里看到：

```typescript
const LEGACY_LIGHT_SLEEP_CRON_TAG = "[managed-by=memory-core.dreaming.light]";
const LEGACY_REM_SLEEP_CRON_TAG = "[managed-by=memory-core.dreaming.rem]";
```

每次启动会检测这些 legacy tag → 如果存在 → 自动迁移到统一的 `MANAGED_DREAMING_CRON_TAG`。Agent 无感升级。

---

## 四、产出物

### 4.1 MEMORY.md（主产出）

晋升的 section 追加到末尾，大致长这样：

```markdown
# Long-Term Memory

...既有内容...

<!-- openclaw:promo:abc123 -->
## 2026-04-24 — Dreaming Promotion

- 用户偏好 TypeScript 而非 Python（来源：memory/2026-04-15.md, recall 8 次跨 5 个查询）
- 项目 Atlas 使用 pnpm，禁止 npm install（来源：2026-04-18.md, recall 12 次）
```

### 4.2 DREAMS.md（审查日志，可选）

**存储模式**（`dreaming.storage.mode`）：
- `inline`（默认）：阶段报告写进 `memory/YYYY-MM-DD.md` 的 managed block
- `separate`：写到 `DREAMS.md`
- `both`：两边都写

`DREAMS.md` 里记录的是"dreaming 过程"本身，不是内容：

```markdown
## 2026-04-24 Light Sleep
- 扫描了 7 天笔记，找到 42 个候选
- 去重后 28 个
- ...

## 2026-04-24 REM Sleep
- 22 个候选通过模式强度 >= 0.6
- ...

## 2026-04-24 Deep Sleep
- 5 条晋升到 MEMORY.md
- 17 条未通过阈值（score 不足 3, recall 不足 8, ...）
```

人类可以审查这个日志，判断是否需要调整阈值（比如总是晋升太少就降 minScore）。

### 4.3 narrative（实验性）

`dreaming-narrative.ts` 可选地生成一段**自然语言总结**——"今天 Agent 重温了关于 Rust 的讨论，注意到用户更偏爱 borrow checker 而非 GC..."。这是更偏人类可读的 diary 风格，不是给 Agent 用的。

---

## 五、配置完整表

```yaml
plugins:
  entries:
    memory-core:
      config:
        dreaming:
          enabled: false              # 默认关
          frequency: "0 3 * * *"      # 每天凌晨 3 点
          timezone: "Asia/Shanghai"
          verboseLogging: false
          storage:
            mode: "inline"            # inline | separate | both
            separateReports: false
          phases:
            light:
              enabled: true
              lookbackDays: 7         # 回溯几天的笔记
              limit: 50               # 最多收集多少候选
              dedupeSimilarity: 0.85  # 去重阈值
            rem:
              enabled: true
              lookbackDays: 7
              limit: 30
              minPatternStrength: 0.6 # 模式强度阈值
            deep:
              enabled: true
              limit: 10               # 每晚最多晋升 10 条
              minScore: 0.7
              minRecallCount: 3
              minUniqueQueries: 2
              recencyHalfLifeDays: 14
              maxAgeDays: 90
```

---

## 六、手动触发（CLI）

即使 `enabled: false`，也可以手动跑一次做测试：

```bash
openclaw memory dreaming run        # 跑一次全流程
openclaw memory dreaming promote    # 只跑 deep sleep（晋升）
  --limit 5                         # 最多 5 条
  --min-score 0.8                   # 只要高分
  --apply                           # 真正写 MEMORY.md（不加只 dry-run）
```

dry-run 模式会列出"如果 apply 会晋升哪些"，用于调优阈值。

---

## 七、与其他机制的交互

### 7.1 和 memory_search 的闭环

```
用户提问 → memory_search → 命中某条笔记
                              ↓
               queueShortTermRecallTracking()
                              ↓
               recall store 更新（recallCount++, uniqueQueries+=1）
                              ↓
               下次 dreaming 跑时，该笔记 signalCount 更高
                              ↓
               更容易通过 deep sleep 阈值，晋升到 MEMORY.md
```

**反馈循环**：越被查的内容越容易晋升。这天然对抗"长尾废话"——很多笔记永远不会被查，永远不会晋升。

### 7.2 和 memory flush 的分工

| 机制 | 何时触发 | 写什么 | 写哪里 |
|------|---------|--------|--------|
| Memory Flush | compaction 前 | 对话里未存下的临时事实 | `memory/YYYY-MM-DD.md`（短期） |
| Dreaming | 定时 cron | 高频 recall 的短期记忆 | `MEMORY.md`（长期） |

严格分层：flush 只写短期，dreaming 只写长期。长期由 dreaming 独占（除了用户手动编辑）。

### 7.3 和 memory-wiki 的互动（bridge 模式）

当 memory-wiki 配置为 `bridge` 模式且 `indexDreamReports: true` 时：
- 每次 dreaming 跑完 → 产出的 DREAMS.md 条目被 memory-wiki 读取
- 编译进 wiki vault 的 `reports/` 目录
- 形成"记忆 → 晋升 → 编译 → 知识库"的完整链路

---

## 八、设计洞察

### 8.1 为什么不直接让 Agent 在对话中写 MEMORY.md？

理论上 Agent 可以对话中用 Edit 工具直接改 MEMORY.md。但 OpenClaw 不鼓励这样做，原因：

1. **Agent 容易过度记忆**：用户一说"我喜欢 TypeScript" → Agent 可能马上写进长期记忆。如果用户下周改主意呢？
2. **污染 cache**：MEMORY.md 每次修改都会让 prompt 的 cache boundary 以上失效
3. **无可追溯性**：人看到 MEMORY.md 里多了一条，不知道是 Agent 哪次写的、基于什么证据

Dreaming 解决的是：**用统计信号代替即时判断**——只有反复出现的才值得晋升，过程有日志，用户可审查。

### 8.2 为什么用 cron 而不是 compaction 时触发？

有人可能想："既然 flush 能在 compaction 前触发，为什么 dreaming 不也在 compaction 前触发？"

原因：
- **Compaction 是时间敏感**（用户在等回复），跑重量级 dreaming（扫描多天笔记、计算多维评分）不合适
- **Dreaming 需要冷静**：跨多天的 recall 统计才有意义，compaction 只看本次会话
- **cron 离线跑**：不阻塞用户交互，可以慢慢做更好的 embedding/聚类

### 8.3 `signalCount` 的组合设计

```typescript
signalCount = recallCount + dailyCount
```

- `recallCount`：被 memory_search 主动查中的次数
- `dailyCount`：在每日笔记里被提到的次数

两者加权，**既看"被使用"，也看"被写入"**。只看 recall 会错失那些"经常写但少查"的事实（如每天都在做但 Agent 没主动搜过的任务）；只看 daily 会误晋升那些"写了很多但没价值"的东西。

### 8.4 和 LLM 上下文窗口的关系

Dreaming 的经济价值：
- `MEMORY.md` 每轮都进 prompt 的**静态区**（命中 cache）
- 如果一条信息被晋升到 MEMORY.md，后续每轮访问成本 ≈ 0（cache hit）
- 如果留在 `memory/*.md` 不晋升，每次用都要走 memory_search（tool call 开销 + embedding 计算）

所以 dreaming 本质是在**优化长期运行的经济效率**——高频内容上移到静态区，低频内容留在动态索引。

---

## 九、源码导航

| 关注点 | 文件 |
|--------|------|
| Dreaming 入口与 cron 注册 | [extensions/memory-core/src/dreaming.ts](extensions/memory-core/src/dreaming.ts) |
| 三阶段流水线实现 | [extensions/memory-core/src/dreaming-phases.ts](extensions/memory-core/src/dreaming-phases.ts) |
| 晋升到 MEMORY.md 的写入逻辑 | [extensions/memory-core/src/short-term-promotion.ts:1280-1360](extensions/memory-core/src/short-term-promotion.ts#L1280-L1360) |
| recall 跟踪（反馈环） | [extensions/memory-core/src/short-term-promotion.ts](extensions/memory-core/src/short-term-promotion.ts) 的 `recordShortTermRecalls` |
| DREAMS.md 写入格式 | [extensions/memory-core/src/dreaming-markdown.ts](extensions/memory-core/src/dreaming-markdown.ts) |
| narrative 生成 | [extensions/memory-core/src/dreaming-narrative.ts](extensions/memory-core/src/dreaming-narrative.ts) |
| CLI `openclaw memory dreaming` | [extensions/memory-core/src/dreaming-command.ts](extensions/memory-core/src/dreaming-command.ts) |
| manifest schema 中的 dreaming 配置 | [extensions/memory-core/openclaw.plugin.json](extensions/memory-core/openclaw.plugin.json) |
| 官方文档 | [docs/concepts/memory.md](docs/concepts/memory.md)（L117-134 "Dreaming (experimental)"） |
