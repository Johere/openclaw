# OpenClaw Skills 注入逻辑 —— 从发现到进入 prompt

> 目标读者:已经理解 OpenClaw system prompt 结构的人。想搞清楚 `<available_skills>`
> XML 里那几个 `<skill>` 到底是从哪儿来的、哪个会被淘汰、预算爆了怎么办。
>
> 配套文档:
> - [tools_schema_feishu.md §1.1](./tools_schema_feishu.md) —— Skills 与 tools[] 的关系
> - [mock_hi_prompts.txt](./mock_hi_prompts.txt) —— 含实际的 `<available_skills>` 注入样例

---

## 一、核心认知

**Skills 是"行为手册索引",不是工具**。整个机制分三步:

```
发现(6 个目录 + plugin manifest) → 去重(按 name,workspace 优先)
  → 过滤 / 预算裁剪(visibility / per-agent / OS / 150 个 / 30 KB)
  → 注入 system prompt 的 <available_skills> XML
```

最后 `tools[]` **完全不受影响**,变的只是 system prompt 的字节数和模型的行为引导
(看完 description → 用通用 `read` 工具去 `<location>` 加载 `SKILL.md`)。

---

## 二、发现路径:6 个目录 + plugin-shipped

按**从低到高**的优先级扫描,后扫描的覆盖先扫描的同名 skill:

| 顺序 | 来源 | 路径 | 典型用途 |
|---|---|---|---|
| 1 | `skills.load.extraDirs` | 配置里任意路径 | 临时测试 / 调试 |
| 2 | **Bundled** | `$OPENCLAW_BUNDLED_SKILLS_DIR` 或 repo 内 `./skills/` | 仓库自带(`peekaboo`, `github` 等) |
| 3 | **Managed** | `~/.openclaw/skills/` | `openclaw skills install` 装的 |
| 4 | Agents(个人) | `~/.agents/skills/` | 跨项目复用 |
| 5 | Agents(项目) | `<workspace>/.agents/skills/` | 项目私有 |
| 6 | **Workspace** | `<workspace>/skills/` | 当前 workspace,优先级最高 |
| ✚ | Plugin manifest | plugin 声明 `skills: ["path/..."]` | 跟 plugin enable 自动挂载 |

**关键事实**:这 6 条不是互斥的配置项,而是**都会扫**的并行列表。最终列表是它们
的 union,冲突时按顺序号大的赢。

---

## 三、去重:按 name,workspace 永远赢

假设:

```
~/.openclaw/skills/committer/SKILL.md         ← managed 版,稳定
<workspace>/skills/committer/SKILL.md         ← workspace 版,项目定制
```

最终 `<available_skills>` 里只有一条 `committer`,**内容来自 workspace**。优先级
排序([src/agents/skills/skill-loader.ts](../src/agents/skills/skill-loader.ts))
保证 workspace 后扫、覆盖 managed。

这个设计让用户可以:
- 在 workspace 里**临时 override** 某个 bundled/managed skill 的行为
- 不同项目用不同的 `committer` 策略(比如有的项目要求 `scripts/committer`,有的要 `pnpm commit`)

---

## 四、过滤:四层筛子

去重后还要过四层筛子才能进 prompt:

### 4.1 Visibility 过滤

SKILL.md frontmatter 里的 `disable-model-invocation: true` 直接剔除。用于 skill
作者标记"这个 skill 只给人读,不给模型自动选"。

由 [src/agents/skills/skill-visibility.ts `isSkillVisibleInAvailableSkillsPrompt`](../src/agents/skills/skill-visibility.ts)
执行。

### 4.2 Per-Agent 白名单

某个 agent 可以在配置里声明 `allowSkills: ["committer", "docs-mintlify"]`,这样
只有这两个 skill 会进 `<available_skills>`,哪怕发现了 50 个。

由 `resolveEffectiveAgentSkillFilter` 执行。用于把"通用 skills 池"按 agent 职责
切片(例如 Telegram channel agent 不需要 `docs-mintlify`)。

### 4.3 环境资格

SKILL.md frontmatter 可以声明运行前提:

```yaml
---
name: peekaboo
requires:
  os: ["darwin"]                    # 只在 macOS 出现
  binaries: ["peekaboo"]            # 系统里必须有这个二进制
  env: ["OPENAI_API_KEY"]           # 必须设了这个 env
---
```

任一条件不满足 → 这轮不注入。意思是用户在 Linux 上就看不到 `peekaboo`,即使
skill 目录里有它。

### 4.4 预算裁剪(最容易踩的坑)

硬上限:

| 预算 | 默认值 |
|---|---|
| 最多 skill 数 | **150** |
| 最多字符数 | **30 KB** |

超标时**格式降级**:

```
full   ( <name> + <description> + <location> )
  ↓  超 30 KB
compact( <name> + 短 description,去掉 location )
  ↓  仍超
binary search 截断尾部(按相关性或扫描顺序)
```

**对大多数用户没影响**(bundled + managed 一般几十个),但如果 workspace 有一大
堆项目私有 skill,可能看到"我明明装了这个 skill,为什么模型不知道?"—— 多半是被
预算裁掉了。

---

## 五、你的 tavily + brave 场景

**场景**:用户 workspace 装了 `tavily-search` + `brave-search` 两个 plugin,bundled
skills 一堆,怎么决定哪些进 `<available_skills>`?

**答案取决于 plugin 类型**:

### 5.1 Plugin 带 skill 清单(最常见)

```json
// extensions/tavily-search/openclaw.plugin.json
{
  "id": "tavily-search",
  "kind": "tool",
  "skills": ["skills/tavily-search"]   ← 关键字段
}
```

plugin enable 时,`skills/tavily-search/SKILL.md` 自动进入发现列表(相当于路径 ✚
那一行)。用户**完全不用手动拷贝**到 `~/.openclaw/skills/`。

### 5.2 Plugin 不带 skill 清单

那它只注册工具(例如 `tavily_search` 这个函数),**不出现在 `<available_skills>`
里**。模型看工具 schema 自己决定怎么用。

### 5.3 所以实际注入量

假设:
- bundled:`committer`, `docs-mintlify`, `openclaw-release-maintainer` (3 个)
- managed:`peekaboo` (1 个,但 Linux 上被 OS 过滤掉 → 0 个)
- plugin 带的:tavily + brave plugin 各贡献 1 个 SKILL.md (2 个)

最终 `<available_skills>` = 5 个。离 150 上限远得很,也远低于 30 KB。

**所以不用担心"装多了 plugin 会爆表"** —— 每个 plugin 通常只贡献 0-1 个 skill。
真正可能撞预算的是:workspace 下堆了大量项目内自定义 skill。

---

## 六、端到端流程图

```
┌──────────────────────────────────────────────────────────────┐
│  Pi Embedded Runner: attempt.ts 准备本轮 system prompt       │
└──────────────┬───────────────────────────────────────────────┘
               ▼
   resolveAvailableSkills(workspaceDir, agentId, config)
               │
               ├─ 扫 6 个目录 + plugin manifest
               ├─ 按 name 去重,workspace 最高优先级
               ├─ Visibility 过滤(disable-model-invocation)
               ├─ Per-agent 白名单(allowSkills)
               ├─ 环境资格(OS / binaries / env)
               └─ 预算裁剪(150 个 / 30 KB,触发 compact / truncate)
               │
               ▼
   formatSkillsForPrompt(filteredSkills)
     → 生成 <available_skills> XML(每个 skill 一个 <skill> 块)
               │
               ▼
   buildSkillsSection(skillsPrompt)
     → 包一层 "## Skills (mandatory)" 引导 + <available_skills>
               │
               ▼
   插入 system prompt,位置:
     "## OpenClaw CLI Quick Reference" 之后
     "## Memory Recall"(如有)之前
     cache boundary **上方**(命中 prompt cache)
               │
               ▼
   模型看到 <available_skills>,匹配某个 skill
     → 用 tool_call: read({"path": "<location>/SKILL.md"})
     → SKILL.md 内容回到下一轮 context
     → 模型按 SKILL.md 指令行动
```

---

## 七、常见疑问

### Q1: Skills 和 tools 优先级冲突了怎么办?
不会冲突,它们是**完全独立的注入通道**。skills 不会替换任何 tool,tool 也不会
让 skill 消失。见 [tools_schema_feishu.md §1.1](./tools_schema_feishu.md)
与该文件的"Skills vs Tools 编排差异"一节。

### Q2: 我在 workspace 写了个 SKILL.md,模型怎么不知道?
检查顺序:
1. 路径是否是 `<workspace>/skills/<name>/SKILL.md`?(目录层级要对)
2. frontmatter 有没有误写 `disable-model-invocation: true`?
3. 当前 agent 是否有 `allowSkills` 白名单把它排除了?
4. 是否撞了环境资格(比如声明了 `requires.os: ["darwin"]` 但你在 Linux)?
5. 总 skill 数有没有超 150 / 30 KB,被预算裁掉了?

### Q3: Bundled skills 在哪?想读 SKILL.md 看看格式
默认是 repo 内 `./skills/`(或由 `$OPENCLAW_BUNDLED_SKILLS_DIR` 覆盖)。实际例子:
- [skills/peekaboo/SKILL.md](../skills/peekaboo/SKILL.md)
- [skills/github/SKILL.md](../skills/github/SKILL.md)

### Q4: Plugin 怎么声明自己带 skill?
manifest 里加 `skills: ["path/to/skills-dir"]`(相对 plugin 根目录)。参考
[docs/plugins/manifest.md](../docs/plugins/manifest.md)。

### Q5: Skills 会进 prompt cache 吗?
会。`<available_skills>` XML 注入位置在 cache boundary **上方**,字节稳定时
命中 prompt cache。但如果 workspace skill 频繁增删或 workspace 切换,会触发
miss —— 这也是为什么 skills 发现走**确定性排序**(避免 Map 迭代顺序问题)。

---

## 八、源码导航

| 关注点 | 文件 |
|---|---|
| Skills 发现入口 | [src/agents/skills/skill-loader.ts](../src/agents/skills/skill-loader.ts) |
| Visibility 过滤 | [src/agents/skills/skill-visibility.ts](../src/agents/skills/skill-visibility.ts) |
| Per-agent 白名单 | `resolveEffectiveAgentSkillFilter` in [src/agents/skills/](../src/agents/skills/) |
| Prompt 格式化 | [src/agents/skills/skill-contract.ts:44 `formatSkillsForPrompt`](../src/agents/skills/skill-contract.ts#L44) |
| system prompt 注入位置 | [src/agents/system-prompt.ts:111 `buildSkillsSection`](../src/agents/system-prompt.ts#L111), [:574](../src/agents/system-prompt.ts#L574) |
| Plugin manifest `skills:` 字段 | [src/plugins/types.ts](../src/plugins/types.ts), [docs/plugins/manifest.md](../docs/plugins/manifest.md) |
| Bundled skills 实例 | [skills/](../skills/) |
