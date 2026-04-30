# Claude Code 深度解析：从 0 到入门 Anthropic 官方 CLI

> 背景假设:C++/Python 编程基础,熟悉 LLM/VLM transformers 架构及 model serving,了解
> system prompt/user prompt,已经读过 [../tutorial.md](../tutorial.md)(OpenClaw 版),
> 想对照看 Anthropic 自家 harness 的做法。无 TypeScript 经验。
>
> 参考源码路径:`/mnt/disk1/projects/harness-framework/claude-code-main/src/`
> 泄露背景见 [README](../../../../harness-framework/claude-code-main/README.md):
> 2026-03-31,Claude Code CLI 的 `.map` 文件意外暴露在 npm registry,完整
> TypeScript 源码被 [@Fried_rice](https://x.com/Fried_rice/status/2038894956459290963)
> 公开。这份代码归 Anthropic 所有,仅供学习。

- **REPL** = **Read–Eval–Print Loop**,是交互式命令行界面的通用模式

---

## 零、这份代码是谁写的?

和 OpenClaw 一样,这是 AI 辅助编写的代码,但风格完全不同:

| 维度           | OpenClaw(社区 harness)         | Claude Code(Anthropic 官方)               |
| -------------- | ------------------------------ | ----------------------------------------- |
| 主要作者       | 社区维护者 + Claude Opus 系列  | Anthropic 内部 team(匿名)                 |
| 代码注释风格   | 简洁,中文混英文注释            | **密集英文注释**,大量 `gh-xxx` issue 引用 |
| commit message | `feat: ...` / `fix: ...` 惯例  | 无(仓库未公开 git 历史)                   |
| 规模           | ~500 文件,核心 src/ + 107 插件 | ~1,900 文件,单 src/ 目录                  |
| 面向           | 多渠道(飞书/TG/Discord/...)    | 终端 REPL + IDE bridge                    |
| Provider       | 30+ 家,社区扩展                | **只有 Anthropic**(SDK 直连)              |

**关键认知差异**:

- OpenClaw 的 `CLAUDE.md`(400+ 行)是 "写给 Claude Code 的项目指令"
- Claude Code **自己的代码** 里没有 `CLAUDE.md` —— 它就是 Claude Code 本身
- 注释风格透露出长期在 Anthropic 内部流转:大量形如 `// gh-24920, CC-79` 的引用
  指向内部 issue tracker,说明这份代码有完整 PR 评审 + 线上事故回溯记录

---

## 一、什么是 AI Harness?(同 OpenClaw)

AI Harness 是 **LLM 的运行时外壳** —— 类似 model serving(vLLM/TGI),但 harness
关注的不是推理吞吐,而是:

- **Prompt 编排**:system prompt → 历史消息 → tool results 的完整上下文组装
- **工具调用循环**:LLM 输出 tool_use → 执行 → 结果回填 → 再次调用 LLM(ReAct loop)
- **UI 呈现**:流式 token → 终端 UI / IDE 面板
- **权限/审批**:tool 执行前用户确认机制
- **扩展机制**:让第三方接新 tool / skill / hook

和 OpenClaw 最大的不同:**Claude Code 没有 "多 channel" 概念** —— 它就是一个终端
工具 + IDE bridge,不接飞书/TG 这些 IM。想让 Claude Code 走 IM,得外面再套一层
gateway(比如 OpenClaw 那种)。

---

## 二、项目总体架构

```
harness-framework/claude-code-main/src/
├── main.tsx                 # 入口:Commander.js CLI 解析 + React/Ink 启动
├── commands.ts              # 命令注册表(~25K lines)
├── tools.ts                 # 工具注册表
├── Tool.ts                  # 工具基类定义(~29K lines)
├── QueryEngine.ts           # LLM 查询引擎(~46K lines)
├── query.ts                 # Turn loop 主循环
├── context.ts               # getUserContext / getSystemContext
│
├── commands/                # ~101 个 slash command 实现
├── tools/                   # ~43 个 tool 实现
├── components/              # ~140 个 Ink UI 组件
├── services/                # ~36 个外部服务集成
│   ├── api/                 # Anthropic API client
│   ├── mcp/                 # Model Context Protocol(外部 tool 主通道)
│   ├── compact/             # 会话压缩
│   ├── lsp/                 # Language Server Protocol
│   ├── analytics/           # GrowthBook feature flags
│   └── oauth/               # OAuth 2.0 登录
│
├── bridge/                  # IDE 双向通信(VS Code / JetBrains)
├── coordinator/             # 多 agent 编队
├── plugins/                 # 插件子系统(比 OpenClaw 轻很多)
├── skills/                  # Skill 系统(比 OpenClaw skill 重)
├── schemas/                 # Zod v4 schema 定义(hooks / config / ...)
├── entrypoints/             # SDK 入口 + 类型导出
│
├── memdir/                  # 持久化记忆
├── tasks/                   # 任务管理
├── remote/                  # Remote sessions
├── server/                  # Server mode
├── vim/                     # Vim mode
├── voice/                   # 语音输入
├── buddy/                   # 吉祥物(彩蛋)
└── ...
```

> 文件量 ~1,900,代码 ~512,000 行。比 OpenClaw 大一个量级 —— 原因之一是
> 它 **内置 140+ React 组件做终端 UI**,OpenClaw 没有 UI 层。

### 核心设计原则

和 OpenClaw 有重叠也有分歧:

| 原则                       | 说明                                            | 对比 OpenClaw                  |
| -------------------------- | ----------------------------------------------- | ------------------------------ |
| **SDK-first**              | SDK 类型在 `entrypoints/sdk/` 定义,供外部调用   | OpenClaw 用 `plugin-sdk/`      |
| **MCP-first extension**    | 外部 tool **只能** 通过 MCP server 接入         | OpenClaw 有 `api.registerTool` |
| **Hook = settings,非代码** | Hook 写在 `settings.json`,跑 shell/prompt/agent | OpenClaw 是插件 JS 回调        |
| **Dead-code elimination**  | `feature('X')` 编译期删代码                     | 无                             |
| **React for CLI**          | 终端 UI 用 Ink(React renderer)                  | 无 UI                          |
| **Lazy loading**           | OpenTelemetry/gRPC 等重模块 `await import()`    | 相同模式                       |

---

## 三、端到端消息流

以用户在 REPL 里敲 "修一下这个 bug" 到拿到 Claude 最终回复的完整路径:

```
User 在终端输入                     cli/print.ts 或 REPL component
         ↓
UserPromptSubmit hook              可在 settings.json 配 shell/prompt 检查
         ↓
QueryEngine.ask()                   启动查询,拉 settings
         ↓
Context Assembly                    context.ts + constants/prompts.ts
├── getSystemPrompt()                ← 工具定义 + 基本指令(STATIC)
├── getUserContext()                 ← CLAUDE.md + 当前日期(半 STATIC)
└── getSystemContext()               ← git status + 动态(DYNAMIC)
         ↓
asSystemPrompt(...)                 拼出 ["static part", "__BOUNDARY__", "dynamic part"]
         ↓
services/api/claude.ts              调 Anthropic SDK
         ↓
┌─── Turn Loop (query.ts:queryLoop L241-L1729) ───┐
│                                                 │
│  1. 发 HTTP 到 Anthropic                        │
│  2. 流式拉 response(tokens one by one)        │
│  3. 如果返回 tool_use block:                    │
│     → PreToolUse hook(可 allow/deny/ask)       │
│     → canUseTool(规则/用户 UI 决策)             │
│     → services/tools/ 里的 handler 执行         │
│     → PostToolUse hook(fire-and-forget 日志)   │
│     → 结果拼回 messages[]                       │
│     → 再跑一轮                                  │
│  4. 如果 stop_reason=end_turn:                  │
│     → Stop hook(可 continue=false 强制再来)    │
│     → 让它真的停,进入输出阶段                  │
│  5. 如果 compaction 阈值触发:                   │
│     → PreCompact hook                           │
│     → services/compact/compact.ts 生成 summary  │
│     → PostCompact hook                          │
│     → 新的 messages 替换历史                    │
└─────────────────────────────────────────────────┘
         ↓
Ink 流式渲染到终端
         ↓
SessionEnd hook                     session 关闭事件
```

**关键洞察**:

- 和 OpenClaw 的 Pi turn loop 几乎一模一样(都是 ReAct 循环)
- 最大差异:**Stop hook 是 Claude Code 的专利** —— 可以阻止模型结束,强行再跑
  一轮。典型用法:"跑完 lint/test 通过才算真结束"
- Anthropic 自家的 harness 直接在 `services/api/claude.ts` 里调自家 SDK,不需要
  像 OpenClaw 那样做 provider 抽象

> 配套阅读:[agent-lifecycle-hooks.md](./agent-lifecycle-hooks.md) 有详细的 28 个
> hook 事件 + 4 种 hook 载体(command/prompt/agent/http)说明。

---

## 四、Prompt 编排架构(对照 OpenClaw)

Claude Code 的 system prompt 组装比 OpenClaw 更**声明式**、**更显式 cache
boundary**。核心文件:`constants/prompts.ts` 里的 `getSystemPrompt()` (L444)。

### 4.1 静态/动态分界

```typescript
// constants/prompts.ts L114-115
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";
```

这是一个**显式 marker 字符串**,作用和 OpenClaw 的
`<!-- OPENCLAW_CACHE_BOUNDARY -->` 完全等价:把 prompt 切成静态区(可缓存)
和动态区(每轮可能变)。

### 4.2 System Prompt 组装结构

看 `getSystemPrompt()` L560-L576 的返回值:

```
getSystemPrompt() 返回一个 string[],拼起来是完整 system prompt

[
  ┌─────────────────────────────────────┐
  │         STATIC ZONE(可缓存)        │
  │                                     │
  │  1. SimpleIntro                     │
  │     "You are Claude Code, Anthropic's│
  │      official CLI for Claude..."    │
  │                                     │
  │  2. SimpleSystem                    │
  │     系统注释(tool results 里的     │
  │     <system-reminder> 标签解释等)  │
  │                                     │
  │  3. DoingTasks(条件)              │
  │     若 keepCodingInstructions = true │
  │                                     │
  │  4. Actions                         │
  │     "Executing actions with care"   │
  │                                     │
  │  5. UsingYourTools                  │
  │     工具使用规范                    │
  │                                     │
  │  6. ToneAndStyle                    │
  │     语气、简洁、不加修饰            │
  │                                     │
  │  7. OutputEfficiency                │
  │     输出效率(字数限制等)          │
  │                                     │
  ├─── __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ ───┤
  │                                     │
  │         DYNAMIC ZONE(registry)     │
  │                                     │
  │  8.  session_guidance               │
  │  9.  memory(loadMemoryPrompt)      │
  │  10. ant_model_override(内部)     │
  │  11. env_info_simple                │
  │      (model/cwd/datetime)          │
  │  12. language                       │
  │  13. output_style                   │
  │  14. mcp_instructions               │
  │      (★ 标了 DANGEROUS_uncached,   │
  │       MCP 中途连接会破缓存)         │
  │  15. scratchpad                     │
  │  16. frc(function result clearing)│
  │  17. summarize_tool_results         │
  │  18. numeric_length_anchors(内部) │
  │  19. token_budget(feature flag)   │
  │  20. brief(KAIROS_BRIEF 时)       │
  │                                     │
  └─────────────────────────────────────┘
]
```

### 4.3 "DANGEROUS_uncached" 机制 —— 比 OpenClaw 更精细

Claude Code 给**每个 dynamic section** 都加了显式标记,决定 "这段是不是可以
跨轮 cache":

```typescript
// constants/systemPromptSections.ts

// 正常:memo 化,计算一次跨轮复用
systemPromptSection("memory", () => loadMemoryPrompt());

// 危险:每轮重算,会打破 cache(要求必须写 reason)
DANGEROUS_uncachedSystemPromptSection(
  "mcp_instructions",
  () => (isMcpInstructionsDeltaEnabled() ? null : getMcpInstructionsSection(mcpClients)),
  "MCP servers connect/disconnect between turns", // ← 必须写理由
);
```

**对照 OpenClaw**:OpenClaw 把 "静态/动态" 区分一次性放在 cache boundary 上,
section 本身不分 cacheable 与否。Claude Code 是**每个 section 单独打标**,
粒度更细,也更容易出事 —— 一个新 section 忘了加 `DANGEROUS_` 就会悄悄打破 cache。

### 4.4 System Context vs User Context(`context.ts`)

看 `context.ts` 的两个 memoize 函数:

| 函数               | 返回字段                    | 何时失效                             |
| ------------------ | --------------------------- | ------------------------------------ |
| `getSystemContext` | `gitStatus`, `cacheBreaker` | session 级 memoize,重新 session 失效 |
| `getUserContext`   | `claudeMd`, `currentDate`   | session 级 memoize,重新 session 失效 |

**`claudeMd`** 是啥?Claude Code 启动时会从 cwd 向上走,扫描每一层的 `CLAUDE.md`,
一路收集拼起来。这就是为什么 OpenClaw 仓库根目录放了那个 400 行的 `CLAUDE.md` ——
那是专门写给 Claude Code 看的项目指令。

和 OpenClaw 的 8 个硬编码文件名(`AGENTS.md`/`SOUL.md`/...)相比,Claude Code 只
认 `CLAUDE.md` 这一个文件名,但支持多级目录聚合,更简单。

### 4.5 Cache Boundary 的实际用法

两个地方会拆 boundary marker:

- `utils/api.ts` 的 `splitSysPromptPrefix` —— 按 `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`
  把数组切两半,前半发给 Anthropic 时打 `cache_control: ephemeral`,后半不打
- `services/api/claude.ts` 的 `buildSystemPromptBlocks` —— 把切好的 block 塞进
  Anthropic `messages.create` 请求的 `system` 字段

换句话说:**这个 marker 字符串从来不会真的发给 LLM**,它只是组装过程中的分隔符,
最终转成 Anthropic 请求里的 `cache_control` 标记。

---

## 五、插件系统 —— 轻得不可思议

如果你习惯了 OpenClaw 的 10 种 `registerXXX` API,看 Claude Code 会非常惊讶:

### 5.1 Built-in Plugin 定义

```typescript
// plugins/builtinPlugins.ts
interface BuiltinPluginDefinition {
  name: string;
  description: string;
  skills?: BundledSkillDefinition[]; // ← 挂 skill
  hooks?: HooksSettings; // ← 往 settings.json merge hook 配置
  mcpServers?: Record<string, McpServerConfig>; // ← 挂 MCP server
  isAvailable?: () => boolean;
  defaultEnabled?: boolean;
}
```

能注册的**只有 3 样**:skills / hooks / MCP servers。没有 `registerTool`,
没有 `registerChannel`,没有 `registerProvider`。

### 5.2 Bundled 情况

```bash
$ cat src/plugins/bundled/index.ts
export function initBuiltinPlugins(): void {
  // No built-in plugins registered yet — this is the scaffolding for
  // migrating bundled skills that should be user-toggleable.
}
```

**真的 0 个 built-in plugin**。Claude Code 的 plugin 子系统目前只是"脚手架",
所有功能都直接写在 core 里。

### 5.3 Tool 想新增 → 必须 MCP

这是和 OpenClaw 最大的哲学分歧:

| 维度       | OpenClaw                    | Claude Code                 |
| ---------- | --------------------------- | --------------------------- |
| 新 tool    | `api.registerTool(factory)` | 必须写 MCP server           |
| tool 协议  | OpenClaw 内部 JS interface  | **MCP 标准协议**            |
| 命名空间   | `tool_name`                 | `mcp__<server>__<tool>`     |
| 加载成本   | 同进程 require,~ms          | 启动子进程 + stdio/SSE 通信 |
| 第三方生态 | 依赖 OpenClaw 特定协议      | 任何 MCP server 即插即用    |

**含义**:Anthropic 赌的是 MCP 标准化。所有外部 tool 扩展都应该遵守 MCP 协议,
这样同一个 MCP server 可以被 Claude Code、Cursor、Continue、Cline 共用。

OpenClaw 的选择更灵活(JS hook 可以做任何事),但把自己锁在 OpenClaw 生态内。

### 5.4 Marketplace 加载路径

```
utils/plugins/pluginLoader.ts
├── loadMarketplaceEntries()      → 从社区注册中心拉 plugin 清单
├── loadLocalPlugins()            → ~/.claude/plugins/ 下的本地插件
└── mergeSettings()               → 把 plugin 的 hooks 写进全局 settings.json
```

用户把 plugin URL 加进 settings,启动时自动下载 + enable。

---

## 六、Hook 机制 —— 和 OpenClaw 完全两回事

详见 [agent-lifecycle-hooks.md](./agent-lifecycle-hooks.md),这里只说核心差异。

### 6.1 Hook 不是代码,是声明

OpenClaw 的 hook 是 JS 回调,Claude Code 的 hook 是 **settings.json 里的声明**:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "pre-commit-check.sh", "timeout": 5 }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "prompt", "prompt": "Did all tests pass? $ARGUMENTS" }]
      }
    ]
  }
}
```

四种 hook 载体(来自 `schemas/hooks.ts`):

| `type`    | 做什么                              | 何时选                         |
| --------- | ----------------------------------- | ------------------------------ |
| `command` | 跑 shell 命令,stdin 收 input JSON   | 绝大多数场景                   |
| `prompt`  | 让 Haiku(或指定模型)评估一段 prompt | 需要 "自然语言判断" 是否放行   |
| `agent`   | 启动一个 agentic verifier(子 agent) | "确认 tests 真的跑过了" 类任务 |
| `http`    | POST input JSON 到 URL              | 推到外部审计/IM 系统           |

### 6.2 28 种 hook 事件

来自 `entrypoints/sdk/coreTypes.ts` 的 `HOOK_EVENTS` 枚举,简写分类:

```
工具:  PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest / PermissionDenied
会话:  SessionStart / Setup / UserPromptSubmit / Stop / StopFailure / SessionEnd / Notification
压缩:  PreCompact / PostCompact
Agent: SubagentStart / SubagentStop / TaskCreated / TaskCompleted / TeammateIdle
交互:  Elicitation / ElicitationResult
配置:  ConfigChange / CwdChanged / FileChanged / InstructionsLoaded / WorktreeCreate / WorktreeRemove
```

**相比 OpenClaw 的 30 种**:

- 粒度更粗(OpenClaw 把 `inbound_claim / message_received / before_dispatch / reply_dispatch`
  分成 4 个 hook,Claude Code 合在 `UserPromptSubmit`)
- 多了 worktree / file-changed 类 hook(Claude Code 是 IDE 工具,这些更重要)
- 少了 channel 相关 hook(Claude Code 没有 channel 概念)

### 6.3 `Stop` hook 是独特武器

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "pnpm test --run 2>/dev/null && echo OK || echo '{\"continue\":false,\"stopReason\":\"tests failed\"}'"
          }
        ]
      }
    ]
  }
}
```

返回 `{continue: false}` → 模型不能停,必须再跑一轮。这是 "lint/test 通过才算完"
的通用实现模式。OpenClaw 的 `agent_end` 是 fire-and-forget,**没有这个能力**。

### 6.4 UserPromptSubmit 可注入 context

```
用户输入 → UserPromptSubmit hook → 返回 { additionalContext: "..." }
                                       ↓
                             拼到用户消息后面作为额外 system 上下文
```

类似 OpenClaw 的 `before_prompt_build.prependContext`。

---

## 七、Skills 系统 —— 比 OpenClaw 重得多

### 7.1 Claude Code Skill 本质

```typescript
// skills/bundledSkills.ts:BundledSkillDefinition
interface BundledSkillDefinition {
  name: string;
  description: string;
  aliases?: string[];
  hooks?: HooksSettings;
  context?: "inline" | "fork"; // ← 同进程 or 子 agent
  getPromptForCommand: (args, context) => Promise<ContentBlockParam[]>;
}
```

关键字段 `getPromptForCommand` 是**函数**,不是静态 Markdown:

- 可以返回多模态内容(文本 + 图片 + ...)
- 可以读环境(当前 cwd、git status)
- `context: 'fork'` 时启动子 agent 跑,不污染主上下文

### 7.2 Bundled Skill 列表

```bash
$ ls src/skills/bundled/
batch.ts              loop.ts                remember.ts
claudeApi.ts          loremIpsum.ts          scheduleRemoteAgents.ts
claudeApiContent.ts   skillify.ts            simplify.ts
claudeInChrome.ts     stuck.ts               verify.ts
debug.ts              updateConfig.ts        verifyContent.ts
keybindings.ts        ...
```

17 个 bundled skill,每个都是一个 `.ts` 文件,定义 `getPromptForCommand` 函数。

### 7.3 和 OpenClaw Skill 对照

| 维度       | OpenClaw                               | Claude Code                            |
| ---------- | -------------------------------------- | -------------------------------------- |
| Skill 形态 | 纯 prompt,一个 `SKILL.md` 文件         | **函数**,返回 `ContentBlockParam[]`    |
| 注入方式   | `<available_skills>` XML + 模型 `read` | `SkillTool` 调用 + slash command       |
| 调用 UX    | 模型自己决定读哪个                     | 用户敲 `/skillname` 或模型走 SkillTool |
| Context    | 总是同进程                             | 可选 `fork` 到子 agent                 |
| 多模态     | 只能文本(Markdown)                     | 原生支持 content blocks(含图像)        |

**一句话**:OpenClaw skill = "行为手册",Claude Code skill = "可编程子命令"。

### 7.4 Skill 触发流程

```
用户: /remember save: "API key 在 1Password"
           ↓
commands.ts 解析 slash command
           ↓
skills/bundled/remember.ts:getPromptForCommand(args, context)
   返回 [{ type: 'text', text: '...' }, { type: 'image', ... }]
           ↓
作为一轮 user message 塞进 queryLoop
           ↓
Claude 按照 skill prompt 执行
```

---

## 八、Tool 系统

### 8.1 43 个内置 Tool

```
BashTool              FileEditTool          WebFetchTool
FileReadTool          GlobTool              WebSearchTool
FileWriteTool         GrepTool              AgentTool            ← 子 agent
SkillTool             MCPTool               ListMcpResourcesTool ← MCP 桥
LSPTool               NotebookEditTool      ToolSearchTool       ← 延迟工具发现
TaskCreateTool        TaskUpdateTool        TaskListTool
TaskGetTool           TaskStopTool          TaskOutputTool
SendMessageTool       TeamCreateTool        TeamDeleteTool       ← 编队
EnterPlanModeTool     ExitPlanModeTool                           ← 规划模式
EnterWorktreeTool     ExitWorktreeTool                           ← git worktree 隔离
ScheduleCronTool      RemoteTriggerTool     SleepTool            ← 定时/远程/等待
AskUserQuestionTool   ConfigTool            TodoWriteTool
SyntheticOutputTool   REPLTool              PowerShellTool
...
```

### 8.2 Tool 基类 `Tool.ts` 的抽象

每个 tool 必须实现:

```typescript
{
  name: string; // 工具名
  description: () => Promise<string>; // 给 LLM 看的描述(可异步生成)
  inputSchema: ZodSchema; // 参数 schema
  inputJSONSchema: () => JSONSchema; // 转 Anthropic API 格式用
  isEnabled: (context) => boolean | Promise; // 运行时是否启用
  needsPermissions: (input, context) => boolean; // 是否需要审批
  renderToolUseMessage: (input) => string; // 终端 UI 渲染
  call: (input, context) => AsyncGenerator; // 执行(流式返回进度)
}
```

**有意思的点**:

- `call` 是 **async generator** —— tool 可以边执行边 yield 中间状态(比如
  `Bash` 工具边跑边吐 stdout),Ink UI 实时渲染
- `needsPermissions` 决定是否触发 `PreToolUse` + 用户 UI 弹窗

### 8.3 权限门(对照 OpenClaw 的 `before_tool_call`)

```
模型发出 tool_use block
         ↓
[Phase A] PreToolUse hook 运行(settings.json 声明的 shell/prompt)
  - deny → 硬阻,直接给模型返回 "denied"
  - allow → 直通
  - ask 或无返回 → 进入 Phase B
         ↓
[Phase B] canUseTool 交互
  - checkRuleBasedPermissions(如 Bash 命令 allowlist)
  - permission mode: default / plan / auto / bypassPermissions
  - 必要时弹 Ink UI 让用户拍板
         ↓
[Phase C] 执行 tool.call()
  - 成功 → PostToolUse hook
  - 失败 → PostToolUseFailure hook
```

**OpenClaw 对照**:OpenClaw 的 `before_tool_call` 是 JS 回调,返回
`{ deny: { reason } }` / `{ params: {...} }` / `undefined`。Claude Code 是
`command/prompt/agent/http` 四选一,更灵活(能跑子 agent 验证)但也更慢
(起 subprocess 成本)。

---

## 九、Gateway / REPL / IDE Bridge

和 OpenClaw 的 gateway 截然不同 —— Claude Code 不是 server,是 **CLI + 可选 bridge**:

### 9.1 主入口 `main.tsx`(~4,683 行)

```typescript
// main.tsx 简化
startMdmRawRead()           // 异步读 MDM 策略(企业部署)
startKeychainPrefetch()     // 异步读 macOS Keychain
program                     // Commander.js 定义 subcommand
  .command('print <prompt>')      → cli/print.ts(一次性调用,SDK 友好)
  .command('repl')                → screens/REPL.tsx(交互式终端 UI)
  .command('mcp ...')             → entrypoints/mcp.ts
  .command('config ...')          → config subcommand
  ...
```

### 9.2 REPL 模式

`screens/REPL.tsx` 是 React + Ink 写的终端全屏应用:

- 左侧:消息历史(user / assistant / tool_result 各种 bubble)
- 底部:输入框(支持 vim 模式、多行、斜杠命令补全)
- 右上:token 余量、当前模型、cost 累计
- 实时流式渲染 tokens

### 9.3 IDE Bridge(`bridge/` 目录)

VS Code / JetBrains 插件通过 JWT 认证的 WebSocket 连到本地 CLI:

```
VS Code extension           ←→   bridge/bridgeMain.ts
    (TypeScript, 自己的进程)       (在 claude code CLI 进程内)
                                         ↓
                                  和主 REPL 共享 QueryEngine
                                         ↓
                                  Anthropic API
```

这个 bridge 就是你在 VS Code 里敲 `Cmd+Esc` 弹出 Claude Code 的背后通路。

---

## 十、关键设计模式(对比 OpenClaw)

### 1. Prompt Cache Stability —— 细粒度 DANGEROUS 标记

**Claude Code 更精细**:

- OpenClaw:静态/动态两个大区,section 不打标
- Claude Code:每个 section 显式 `systemPromptSection()` 或
  `DANGEROUS_uncachedSystemPromptSection(reason)`

**优点**:review 代码时一眼看出哪些 section 会打破 cache
**缺点**:容易漏打标,新 section 默认可缓存导致 stale 数据

### 2. Feature Flag 编译期删除

```typescript
// main.tsx
import { feature } from "bun:bundle";

const voiceCommand = feature("VOICE_MODE") ? require("./commands/voice/index.js").default : null;
```

Bun 在 bundle 阶段会把 `feature('VOICE_MODE')` 替换成 `true` 或 `false`,死代码
完全从产物中剥离 —— 和 C++ 的 `#ifdef` 等价,但是 TypeScript 能写。

OpenClaw **没有这个机制**,所有 feature 都在运行时判断,包体更大。

### 3. Hook = 配置,不是代码

OpenClaw:"给插件作者最大自由,hook 是 JS 回调"
Claude Code:"给运维/用户最大自由,hook 是 settings.json 声明"

Claude Code 的做法更 ops-friendly:用户不用懂 TypeScript,写 shell 脚本即可
扩展 harness。但灵活度不如 OpenClaw(JS 能做的事 shell 未必能做)。

### 4. MCP 作为唯一外部扩展通道

**Anthropic 押注 MCP 生态**:写一次 MCP server,在 Claude Code、Cursor、
Continue、Cline 都能用。OpenClaw 的 `registerTool` 是私有协议,只能在
OpenClaw 用。

长期看谁赢不好说 —— MCP 有标准化优势,私有协议有灵活性优势。

### 5. React for CLI —— 终端 UI 的新范式

Claude Code 有 **140+ 个 Ink 组件**。Ink 是把 React 模型搬到终端:

- `<Box>` 替代 HTML `<div>`
- `<Text>` 替代 `<span>`
- useState / useEffect 正常用
- 用 flexbox 布局终端

这让终端 UI 可组合、可测试(jsdom + Ink testing library)、可热重载。
OpenClaw 是后端服务,没有 UI 层。

### 6. Async Generator Tools —— 流式进度

```typescript
async function* callBash(input): AsyncGenerator<ToolEvent, ToolResult> {
  yield { type: "progress", message: "running..." };
  const proc = spawn(input.command);
  for await (const chunk of proc.stdout) {
    yield { type: "output", text: chunk };
  }
  return { exitCode: proc.exitCode };
}
```

tool 执行过程可以**流式**返回中间状态,Ink UI 实时渲染 "Running tests... 23/100 passed"
这种进度。OpenClaw 的 tool 是 "call → return"一次性返回,没有流式。

---

## 十一、动手路径建议

### 推荐阅读顺序(给 C++/Python 背景)

1. **读 system prompt 组装**:`constants/prompts.ts:getSystemPrompt()` L444 ——
   对比 OpenClaw 的 `system-prompt.ts:buildAgentSystemPrompt()`,感受差异
2. **读 turn loop**:`query.ts:queryLoop` L241-L1729 —— 核心循环的 Anthropic 版
3. **读一个 tool**:`tools/BashTool/` —— 看 async generator 怎么流式进度
4. **读一个 skill**:`skills/bundled/remember.ts` —— 对比 OpenClaw skill 的
   prompt-only 形态
5. **读 hook 执行**:`utils/hooks.ts`(~4000 行)+ `schemas/hooks.ts` ——
   看 command/prompt/agent/http 四种载体怎么跑
6. **读 REPL**:`screens/REPL.tsx` —— 感受 React + Ink 终端 UI
7. **读 MCP client**:`services/mcp/client.ts` —— 理解 Claude Code 怎么接外部 tool

### 学习 Claude Code 的价值

**值得学的**:

- Prompt 组装的显式 cache boundary + 每 section DANGEROUS 标记 —— 比 OpenClaw 更
  细粒度的 cache 控制
- Hook = 声明式配置 —— ops-friendly 的扩展范式(虽然没有 JS 灵活)
- MCP 作为 tool 协议 —— 工业界正在收敛的事实标准
- Async generator + Ink —— 终端 UI 的现代范式
- Stop hook 的 `continue: false` —— 强制 gate 的通用模式
- 4,683 行的 `main.tsx` 启动流程 —— 看商业级 CLI 怎么做 bootstrap

**要保留怀疑的**:

- 代码量 ~512K 行 —— 是否过度工程?很多功能(voice、buddy、KAIROS)用 feature flag
  锁死,是团队迭代遗迹还是真的将来要开?
- React 终端 UI —— 学习曲线陡,普通插件开发者未必需要这层
- `QueryEngine.ts` 46K 行,`query.ts` 1,729 行 —— 这种级别的文件违反了大多数
  工程规范(OpenClaw CLAUDE.md 建议 ≤ 700 行)

---

## 十二、OpenClaw vs Claude Code 快速对照表

作为结语,把两个 harness 的主要差异放一张表:

| 维度           | OpenClaw                             | Claude Code                              |
| -------------- | ------------------------------------ | ---------------------------------------- |
| 性质           | 社区 harness                         | Anthropic 官方 CLI                       |
| 主入口         | 多 channel gateway                   | 终端 REPL + IDE bridge                   |
| Provider       | 30+ 家(anthropic/openai/vllm/...)    | **只有 Anthropic**                       |
| 扩展机制       | `registerTool/Hook/Channel/Provider` | 只能加 skill/hook/MCP server             |
| 新 tool 怎么加 | 插件内直接注册                       | 必须写 MCP server                        |
| Hook 载体      | JS 回调                              | command/prompt/agent/http 声明           |
| Hook 数量      | 30                                   | 28                                       |
| Stop 能阻止吗  | 否(`agent_end` fire-and-forget)      | **是**(`continue: false`)                |
| Cache boundary | 整 prompt 切两半                     | **每 section 显式 DANGEROUS 标记**       |
| Skills 形态    | `SKILL.md` 纯 prompt                 | 函数返回 `ContentBlockParam[]`,支持 fork |
| Tool 调用方式  | 同步/异步函数                        | **async generator**(流式进度)            |
| UI 层          | 无(后端服务)                         | React + Ink 终端 UI(140+ 组件)           |
| Feature flag   | 运行时判断                           | **编译期删除**(Bun bundle)               |
| 代码量         | ~500 文件                            | ~1,900 文件                              |
| 生态站位       | 多 channel / 自家协议                | MCP 标准 / 单 channel                    |

---

## 十三、TypeScript 对照表(给 C++/Python 背景)

和 OpenClaw tutorial 一样,这里单独列一份,方便 Claude Code 里常见的模式:

| TypeScript                          | C++                             | Python                        |
| ----------------------------------- | ------------------------------- | ----------------------------- |
| `async function*`                   | coroutine + generator           | `async def` + `yield`         |
| `AsyncGenerator<T, R>`              | —                               | `AsyncIterator[T]`(加 return) |
| `feature('X') ? A : B`              | `#ifdef X` 预处理               | —                             |
| `z.object({...})` (Zod)             | —                               | `pydantic.BaseModel`          |
| `z.discriminatedUnion('type', ...)` | tagged union                    | `Union[TypedDict, ...]`       |
| `React.FC` / `<Box>`                | —(Ink 是 React 的终端 renderer) | —                             |
| `memoize(asyncFn)`                  | `std::once_flag`                | `functools.lru_cache`         |
| `lazySchema(() => z.object(...))`   | 延迟初始化                      | `@functools.cache` on builder |
| `process.env.CLAUDE_CODE_SIMPLE`    | `getenv("CLAUDE_CODE_SIMPLE")`  | `os.environ.get("...")`       |
