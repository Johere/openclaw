# OpenClaw Tools Schema 编排 —— Feishu 场景

> 目标读者:已经理解 Pi Embedded Runner 的人。想搞清楚一次 Feishu turn 里,
> `tools[]` 是怎么拼出来的、每个工具从哪个组件来、拼好后给 LLM 的 wire 长什么样。
>
> 配套 mock 文件:
> - [mock_hi_prompts.txt](./mock_hi_prompts.txt) —— 纯 `"hi"`,未启用 memory-core
> - [mock_hi_prompts_memory.txt](./mock_hi_prompts_memory.txt) —— `"hi, what do you know me?"`,启用 memory-core

---

## 1. 工具来源:四路汇流

Pi Embedded Runner 在每一轮推理之前,需要把"当前这个 turn 能用的工具"拼成
`tools[]` 塞给 LLM。这个数组来自四个来源,由不同层各负责一部分:

```
┌─────────────────────────────────────────────────────────────────┐
│  ①  Pi 原生编辑工具(来自 @mariozechner/pi-coding-agent)        │
│      read / write / edit                                         │
├─────────────────────────────────────────────────────────────────┤
│  ②  OpenClaw wrapper 工具(createOpenClawCodingTools 封装)      │
│      exec / process / cron / update_plan                         │
│      session_status / sessions_list / sessions_send              │
│      sessions_yield / sessions_spawn / subagents                 │
├─────────────────────────────────────────────────────────────────┤
│  ③  Plugin 注册的工具(api.registerTool)                        │
│      memory-core    → memory_search, memory_get                  │
│      memory-lancedb → memory_search, memory_get (替换 memory-core)│
│      memory-wiki    → wiki_search, wiki_get, wiki_apply, ...     │
│      skill plugin   → skill (若 skills 目录非空)                 │
│      gateway plugin → gateway (仅 owner + local gateway)         │
├─────────────────────────────────────────────────────────────────┤
│  ④  Channel 专属工具(channel plugin 注册)                      │
│      Feishu / Telegram / Slack / Discord 共用一把:message      │
│      Feishu 的 action 枚举: send / read / edit / thread-reply /  │
│          pin / list-pins / unpin / react / reactions /           │
│          member-info / channel-info / channel-list               │
└─────────────────────────────────────────────────────────────────┘
```

**source of truth**:每个工具的 name / description / parameters 都由其原始
定义决定(①是 pi-coding-agent 的 `.d.ts`,②是 `createOpenClawCodingTools`,
③④是 plugin 的 `api.registerTool(...)` 调用)。System prompt 里的 `## Tooling`
段只讲**策略**(什么时候用),不复述**参数**。

### 1.1 特例:Skills —— 只进 prompt,不进 tools[]

⚠️ **重要认知修正**:`skill` 不是一个工具。跟 memory-core 不同,skills 机制
**不往 `tools[]` 注册新工具**,整个机制是**纯 system prompt 级别**的:

- **注入内容**:一段 `## Skills (mandatory)` 引导 + 一段 `<available_skills>`
  XML(列出每个 skill 的 `<name>` / `<description>` / `<location>`),由
  [src/agents/system-prompt.ts:111 `buildSkillsSection`](../src/agents/system-prompt.ts#L111)
  + [src/agents/skills/skill-contract.ts:44 `formatSkillsForPrompt`](../src/agents/skills/skill-contract.ts#L44)
  生成。
- **执行方式**:模型用**已有的 `read` 工具**按 `<location>` 路径去加载 `SKILL.md`
  —— 所以 skills **不占用 tools[] 名额**,也不需要新的工具 schema。
- **类比**:它类似"把一本操作手册的目录塞进 prompt",目录告诉模型手册里每一章
  讲什么、在哪。真正读手册还是靠通用文件读取工具。

**何时注入**:当 `skillsPrompt` 参数非空(workspace 下 `~/.openclaw/skills/*/SKILL.md`
扫到至少一个)时整段 `## Skills (mandatory)` + `<available_skills>` XML 都加入
system prompt;否则两段都不出现。

**注入位置**:`## OpenClaw CLI Quick Reference` 之后、memory 段(如果有)之前,
cache boundary **上方**(见 [system-prompt.ts:574](../src/agents/system-prompt.ts#L574))。

**对 tools[] 的影响**:**无**。即使挂了 10 个 skills,`tools[]` 长度不变;变的
只是 system prompt 字节数和模型的行为引导。

**跟 memory-core 的对比**:

| | memory-core | skills |
|---|---|---|
| 往 tools[] 注册工具? | ✅ `memory_search`, `memory_get` | ❌ 不注册 |
| 注入 prompt 段? | ✅ `## Memory Recall` | ✅ `## Skills (mandatory)` + `<available_skills>` |
| 模型调用方式 | 专用工具 `memory_search(...)` | 用通用 `read` 工具读 `SKILL.md` |
| 触发条件 | 插件启用 | `skillsPrompt` 非空(skills 目录非空) |

所以严格说:**memory-core 是"工具 + 引导" 双侧注入,skills 是"纯引导"单侧注入**。
如果你看过我之前把 `skill` 列在 §6 速查表工具清单里,那是错的 —— 已在 §6 更正。

### 1.2 Tools 编排 vs Skills 编排:完整对比

上面 §1.1 只讲了"skill 不进 tools[]",下面这张表讲两者在**触发 / 执行 / 生命周期**
上的全差异。配套阅读:[skills-discovery.md](./skills-discovery.md) —— 详解 skills
怎么被发现、去重、裁剪。

| 维度 | Tools 编排 | Skills 编排 |
|---|---|---|
| **注入位置** | 请求 body 的 `tools: [...]` 数组(API 层) | system prompt 的 `<available_skills>` XML(文本层) |
| **模型感知** | 结构化 schema(JSON Schema) | 自然语言 `<description>` + `<location>` 路径 |
| **触发方式** | 模型输出 `tool_call` → runtime 分发 → handler 执行 | 模型看完 description → 用 `read` 工具打开 SKILL.md → 按 markdown 指令行动 |
| **谁在"执行"** | OpenClaw runtime / plugin handler(代码) | 模型自己(读完 SKILL.md 后按指令一步步做) |
| **返回形态** | `tool_result` 消息(结构化 JSON) | 无直接返回;SKILL.md 内容变成后续 turn 的 context |
| **来源** | pi-coding-agent 内建 + plugin `api.registerTool(...)` + channel 注册 | 6 个目录扫描 + plugin manifest `skills:` 声明 |
| **预算控制** | 无显式上限(但太多会吃 prompt cache + token) | 硬上限 **150 个 / 30 KB**,超了触发格式降级或截断 |
| **确定性排序** | 要求(按 source + name) | 要求(影响 prompt cache 命中) |
| **生命周期** | 每轮都完整发送 schema | 每轮都发送 description 摘要,**不是**完整 SKILL.md |
| **可过滤层** | channel capability / gateway ownership / memory slot winner | visibility / per-agent 白名单 / OS / binaries / env / budget |
| **与 cache boundary 的关系** | tools[] 在请求 body,不在 prompt 内,按 body 缓存策略 | `<available_skills>` 在 system prompt cache boundary **上方** |
| **典型例子** | `read`, `write`, `bash`, `memory_search`, `message` | `committer`, `docs-mintlify`, `openclaw-release-maintainer` |

### 一个例子看清楚(用户说"帮我提交这些改动")

**Tools 路径**(如果用户没装 `committer` skill,模型直接用 `bash`):
```
model → tool_call: bash({"command": "git add src/foo.ts"})
     → tool_call: bash({"command": "git commit -m '...'"})
```

**Skills 路径**(装了 `committer` skill):
```
model 看 <available_skills> → 发现 committer 的 description 匹配
model → tool_call: read({"path": "~/.openclaw/skills/committer/SKILL.md"})
       ← SKILL.md 返回:告诉它要用 scripts/committer 而不是裸 git commit
model → tool_call: bash({"command": "scripts/committer 'fix: ...' src/foo.ts"})
```

**关键洞察**:
- Skills **不提供新能力**,它只是告诉模型在某种情境下**怎么用现有 tools**
- 所以 skills 是给模型的 **"行为手册索引"**;tools 是 **"能力接口"**
- 加一个 skill 不会让 tools[] 变长,但会让模型对同类情境的行为更一致

### 三种配对关系速查

| 关系 | 体现 | 例子 |
|---|---|---|
| **纯 tool,无 skill** | 模型看 JSON Schema 自己决定怎么用 | `memory_search` |
| **纯 skill,无新 tool** | 只教"怎么用已有 tools 的组合" | `committer`(只用 `bash` + `read`) |
| **skill + 专属 tool** | plugin 同时注册工具 + 贡献 SKILL.md 讲用法 | `peekaboo`(`peekaboo_capture` 工具 + SKILL.md) |

**推论**:如果你发现 plugin 只注册了工具但行为经常被用错,加一个 SKILL.md 比改
tool description 更有效 —— description 受 schema 长度约束,SKILL.md 可以写几页。

---

## 2. 拼装时机:Pi Embedded Runner 每轮都重拼

入口:[src/agents/pi-embedded-runner/run/attempt.ts:788](../src/agents/pi-embedded-runner/run/attempt.ts#L788) 左右。

关键事实:

- **每次 LLM 调用前**重新拼一次(不是 session 启动时拼一次就固定下来)。
- 原因:channel capability、memory plugin 状态、gateway ownership、skills 目录
  非空与否都可能变(比如用户中途切频道、临时 disable memory),tools[] 必须
  反映"当前这一 turn 真正可用的工具"。
- **确定性排序**是硬要求:tools[] 的顺序影响 prompt cache 命中率,所以几个
  源合并时排序不能依赖 `Map.values()` 迭代顺序或 plugin 加载时序。见
  [CLAUDE.md](../CLAUDE.md) 的 "Prompt Cache Stability" 段。

---

## 3. 关键差异:有无 memory-core

| | 未启用 memory-core | 启用 memory-core |
|---|---|---|
| tools[] 长度 | 14 个 | 16 个(多 `memory_search` + `memory_get`) |
| system prompt | 无 `## Memory Recall` 段 | 多一段 `## Memory Recall` 指令 |
| 首轮典型行为 | 直接回复 | 先调用 `memory_search`,再回复 |
| turn 数 | 1 | ≥2 |

**注意**:`memory_search` 的注入是**条件性**的 —— 只要 slot 里 active memory 插件
提供它就在,否则没有。所以 memory-core 被 memory-lancedb 替换时,tools[] 里仍然
有 `memory_search`,只是实现后端不同。

---

## 4. 对其他 provider 的 wire 形态差异

OpenClaw 内部拿到的是一个统一的 tool list(pi-ai 抽象层),到出口再按 provider
翻译成对应格式:

| Provider | wire format | tools 字段名 |
|---|---|---|
| Anthropic | `{ tools: [{name, description, input_schema}], tool_choice: {type:"auto"} }` | `tools` |
| OpenAI / vLLM openai-completions | `{ tools: [{type:"function", function:{name, description, parameters}}], tool_choice: "auto" }` | `tools` |
| Gemini | `{ tools: [{functionDeclarations: [{name, description, parameters}]}], toolConfig: {functionCallingConfig: {mode:"AUTO"}} }` | `tools[0].functionDeclarations` |
| OpenAI Responses API | `{ tools: [{type:"function", name, description, parameters}] }`(扁平化) | `tools` |

本文档的完整 JSON 以 **OpenAI Chat Completions 兼容格式** 展示(也是 vLLM 用的),
其它 provider 只是同一批 `name / description / parameters` 的不同封装。

---

## 5. 完整 tools[] 文本(可展开)

<details>
<summary><strong>5.1 场景 A —— Feishu + vLLM/Qwen3.5,未启用 memory-core(14 个工具)</strong></summary>

```json
"tools": [
  {
    "type": "function",
    "function": {
      "name": "read",
      "description": "Read a file from the workspace with optional offset/limit. Supports images with auto-resize.",
      "parameters": {
        "type": "object",
        "properties": {
          "path":   { "type": "string",  "description": "Workspace-relative or absolute file path." },
          "offset": { "type": "integer", "description": "Zero-based line offset." },
          "limit":  { "type": "integer", "description": "Max number of lines to read." }
        },
        "required": ["path"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "write",
      "description": "Write or create a file with the given content. Overwrites existing content.",
      "parameters": {
        "type": "object",
        "properties": {
          "path":    { "type": "string" },
          "content": { "type": "string" }
        },
        "required": ["path", "content"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "edit",
      "description": "Edit a file by replacing oldText with newText. Returns a unified diff.",
      "parameters": {
        "type": "object",
        "properties": {
          "path":  { "type": "string" },
          "edits": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "oldText": { "type": "string" },
                "newText": { "type": "string" }
              },
              "required": ["oldText", "newText"]
            }
          }
        },
        "required": ["path", "edits"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "exec",
      "description": "Execute shell commands. Supports background continuation (yieldMs/background) for work that keeps running; use `process` to inspect later. Use pty=true for TTY-required commands.",
      "parameters": {
        "type": "object",
        "properties": {
          "command":    { "type": "string" },
          "workdir":    { "type": "string" },
          "env":        { "type": "object", "additionalProperties": { "type": "string" } },
          "yieldMs":    { "type": "integer" },
          "background": { "type": "boolean" },
          "timeout":    { "type": "integer" },
          "pty":        { "type": "boolean" },
          "elevated":   { "type": "boolean" },
          "host":       { "type": "string" },
          "security":   { "type": "string" },
          "ask":        { "type": "string" }
        },
        "required": ["command"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "process",
      "description": "Inspect and control running exec sessions: list, poll, log, write, send-keys, submit, paste, kill, clear, remove.",
      "parameters": {
        "type": "object",
        "properties": {
          "action":    { "type": "string", "enum": ["list","poll","log","write","send-keys","submit","paste","kill","clear","remove"] },
          "sessionId": { "type": "string" },
          "data":      { "type": "string" },
          "keys":      { "type": "array",  "items": { "type": "string" } },
          "hex":       { "type": "array",  "items": { "type": "string" } },
          "literal":   { "type": "string" },
          "text":      { "type": "string" },
          "bracketed": { "type": "boolean" },
          "eof":       { "type": "boolean" },
          "offset":    { "type": "integer" },
          "limit":     { "type": "integer" },
          "timeout":   { "type": "integer" }
        },
        "required": ["action"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "cron",
      "description": "Manage Gateway cron jobs (status/list/add/update/remove/run/runs/wake) for reminders, delayed follow-ups, and recurring tasks.",
      "parameters": {
        "type": "object",
        "properties": {
          "action":          { "type": "string", "enum": ["status","list","add","update","remove","run","runs","wake"] },
          "job":             { "type": "object", "description": "Required for add/update. Shape: { name, schedule, sessionTarget, payload, delivery, enabled }." },
          "jobId":           { "type": "string" },
          "patch":           { "type": "object" },
          "text":            { "type": "string" },
          "mode":            { "type": "string", "enum": ["now","next-heartbeat"] },
          "runMode":         { "type": "string", "enum": ["due","force"] },
          "includeDisabled": { "type": "boolean" },
          "contextMessages": { "type": "integer" },
          "gatewayUrl":      { "type": "string" },
          "gatewayToken":    { "type": "string" },
          "timeoutMs":       { "type": "integer" }
        },
        "required": ["action"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "update_plan",
      "description": "Update the current structured work plan. Mark at most one step as in_progress at a time; keep steps short.",
      "parameters": {
        "type": "object",
        "properties": {
          "explanation": { "type": "string" },
          "plan": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "step":   { "type": "string" },
                "status": { "type": "string", "enum": ["pending","in_progress","completed"] }
              },
              "required": ["step","status"]
            }
          }
        },
        "required": ["plan"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "session_status",
      "description": "Show session status, usage, time, cost, and linked background task context. Optional model param sets a per-session override.",
      "parameters": {
        "type": "object",
        "properties": {
          "sessionKey": { "type": "string" },
          "model":      { "type": "string" }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "sessions_list",
      "description": "List visible sessions with filters for kind (main|group|cron|hook|node|other), recent activity, and messages.",
      "parameters": {
        "type": "object",
        "properties": {
          "kinds":         { "type": "array", "items": { "type": "string", "enum": ["main","group","cron","hook","node","other"] } },
          "limit":         { "type": "integer" },
          "activeMinutes": { "type": "integer" },
          "messageLimit":  { "type": "integer" }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "sessions_send",
      "description": "Send a message to another visible session by sessionKey or label. Waits for target run and returns the updated assistant reply.",
      "parameters": {
        "type": "object",
        "properties": {
          "sessionKey":     { "type": "string" },
          "label":          { "type": "string" },
          "agentId":        { "type": "string" },
          "message":        { "type": "string" },
          "timeoutSeconds": { "type": "integer" }
        },
        "required": ["message"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "sessions_yield",
      "description": "End your current turn and wait for subagent results as the next message.",
      "parameters": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "sessions_spawn",
      "description": "Spawn an isolated session with runtime=(subagent|acp). mode=(run|session); optional attachments, workdir/model/thinking overrides. For ACP-harness intents (codex/claude-code/cursor/gemini), use runtime=\"acp\".",
      "parameters": {
        "type": "object",
        "properties": {
          "task":              { "type": "string" },
          "label":             { "type": "string" },
          "runtime":           { "type": "string", "enum": ["subagent","acp"] },
          "agentId":           { "type": "string" },
          "resumeSessionId":   { "type": "string" },
          "model":             { "type": "string" },
          "thinking":          { "type": "string" },
          "cwd":               { "type": "string" },
          "runTimeoutSeconds": { "type": "integer" },
          "timeoutSeconds":    { "type": "integer" },
          "thread":            { "type": "boolean" },
          "mode":              { "type": "string", "enum": ["fire-and-forget","stream","wait"] },
          "cleanup":           { "type": "string", "enum": ["delete","keep"] },
          "sandbox":           { "type": "string", "enum": ["inherit","require"] },
          "streamTo":          { "type": "string", "enum": ["parent"] },
          "lightContext":      { "type": "boolean" },
          "attachments": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "name":     { "type": "string" },
                "content":  { "type": "string" },
                "encoding": { "type": "string", "enum": ["utf8","base64"] },
                "mimeType": { "type": "string" }
              },
              "required": ["name","content"]
            }
          },
          "attachAs": {
            "type": "object",
            "properties": { "mountPath": { "type": "string" } }
          }
        },
        "required": ["task"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "subagents",
      "description": "List, kill, or steer spawned sub-agents for this requester session.",
      "parameters": {
        "type": "object",
        "properties": {
          "action":        { "type": "string", "enum": ["list","kill","steer"] },
          "target":        { "type": "string" },
          "message":       { "type": "string" },
          "recentMinutes": { "type": "integer" }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "message",
      "description": "Send and manage messages across configured channels. For Feishu, action ∈ {send, read, edit, thread-reply, pin, list-pins, unpin, react, reactions, member-info, channel-info, channel-list}. Per-action required fields differ (see the `Messaging` / `### message tool` sections in the system prompt).",
      "parameters": {
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "enum": [
              "send","read","edit","thread-reply",
              "pin","list-pins","unpin",
              "react","reactions",
              "member-info","channel-info","channel-list"
            ]
          },
          "channel":   { "type": "string", "enum": ["feishu","telegram","slack","discord","signal","imessage","whatsapp","matrix","zalo","voice"] },
          "target":    { "type": "string", "description": "Feishu: user:<open_id> | chat:<chat_id>. Omit to reply to current conversation." },
          "targets":   { "type": "array", "items": { "type": "string" } },
          "message":   { "type": "string" },
          "messageId": { "type": "string", "description": "Required for edit / pin / unpin / react / reactions." },
          "threadId":  { "type": "string", "description": "Required for thread-reply." },
          "emoji":     { "type": "string", "description": "Required for react." },
          "accountId": { "type": "string" },
          "dryRun":    { "type": "boolean" }
        },
        "required": ["action"]
      }
    }
  }
]
```

</details>

<details>
<summary><strong>5.2 场景 B —— Feishu + vLLM/Qwen3.5,启用 memory-core(16 个工具)</strong></summary>

相对于场景 A,在 `subagents` 和 `message` 之间插入两个 memory 工具。其余 14 个
工具与场景 A 完全一致,不再重复。

```json
// ...前 13 个工具与场景 A 相同:
// read, write, edit, exec, process, cron, update_plan,
// session_status, sessions_list, sessions_send, sessions_yield,
// sessions_spawn, subagents

// ↓↓↓ 新增 ↓↓↓
{
  "type": "function",
  "function": {
    "name": "memory_search",
    "description": "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos. Optional corpus=wiki or corpus=all also searches registered compiled-wiki supplements. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
    "parameters": {
      "type": "object",
      "properties": {
        "query":      { "type": "string" },
        "maxResults": { "type": "number" },
        "minScore":   { "type": "number" },
        "corpus":     { "type": "string", "enum": ["memory","wiki","all"] }
      },
      "required": ["query"]
    }
  }
},
{
  "type": "function",
  "function": {
    "name": "memory_get",
    "description": "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; corpus=wiki reads from registered compiled-wiki supplements. Use after search to pull only the needed lines and keep context small.",
    "parameters": {
      "type": "object",
      "properties": {
        "path":   { "type": "string" },
        "from":   { "type": "number" },
        "lines":  { "type": "number" },
        "corpus": { "type": "string", "enum": ["memory","wiki","all"] }
      },
      "required": ["path"]
    }
  }
}
// ↑↑↑ 新增 ↑↑↑

// 最后一个 message 工具与场景 A 相同
```

</details>

---

## 6. 工具速查表

| 工具 | 来源 | 何时可用 | 必填 |
|---|---|---|---|
| `read` | pi-coding-agent | 始终 | path |
| `write` | pi-coding-agent | 始终 | path, content |
| `edit` | pi-coding-agent | 始终 | path, edits |
| `exec` | OpenClaw wrapper | 始终 | command |
| `process` | OpenClaw wrapper | 始终 | action |
| `cron` | OpenClaw wrapper | gateway 可达 | action |
| `update_plan` | OpenClaw wrapper | 始终 | plan |
| `session_status` | OpenClaw wrapper | 始终 | — |
| `sessions_list` | OpenClaw wrapper | 始终 | — |
| `sessions_send` | OpenClaw wrapper | 始终 | message |
| `sessions_yield` | OpenClaw wrapper | 始终 | — |
| `sessions_spawn` | OpenClaw wrapper | 始终 | task |
| `subagents` | OpenClaw wrapper | 始终 | — |
| `memory_search` | memory-core plugin | slot winner 提供 | query |
| `memory_get` | memory-core plugin | slot winner 提供 | path |
| `message` | channel plugin(Feishu) | channel 已配置 | action |
| `gateway` | gateway plugin | owner + local gateway | — |

> ⚠️ **Skills 不在上表**。skills 机制只注入 system prompt 段(`## Skills (mandatory)`
> + `<available_skills>` XML),**不注册任何新工具**,模型用通用 `read` 工具去加载
> `SKILL.md`。详见 §1.1。

---

## 7. 如何自己打印当前 turn 的 tools[]

如果想验证"我这次发给 LLM 的 tools[] 到底长什么样",不要去猜 —— 打开
session 日志:

```bash
# 最新一轮
ls -t ~/.openclaw/agents/default/sessions/*.jsonl | head -1
```

搜索里面 `"tools"` 字段,或者直接看 pi-ai transport 打出的请求 body。

相关源码:
- 拼装入口:[src/agents/pi-embedded-runner/run/attempt.ts](../src/agents/pi-embedded-runner/run/attempt.ts)
- OpenClaw wrapper 工具:`createOpenClawCodingTools(...)` 附近
- Plugin tool 注册路径:[src/plugin-sdk/plugin-entry.ts](../src/plugin-sdk/plugin-entry.ts) 的 `api.registerTool`
- memory-core 两个工具的实现:[extensions/memory-core/src/tools.ts](../extensions/memory-core/src/tools.ts)
- Feishu `message` 工具 action 列表:[extensions/feishu/src/channel.ts](../extensions/feishu/src/channel.ts)

---

## 8. 常见疑问

### Q1: `tools[]` 的顺序重要吗?
重要。很多 provider 在底层把 tools 列表作为 prompt 前缀的一部分参与 cache key 计算;
顺序变化会让 prompt cache miss 掉。OpenClaw 规定在拼装时**按确定性顺序**输出
(通常按 source + name 排序),见 [CLAUDE.md](../CLAUDE.md) 的 "Prompt Cache
Stability" 段。

### Q2: 为什么不用 `tool_choice: "required"` 强制调用 `memory_search`?
因为 `memory_search` 不是每轮都该调的(用户说 "hi" 就没必要搜)。决策权留给模型,
`## Memory Recall` 段用 prompt 引导它:"涉及 prior work / preferences / ...
才搜"。`tool_choice: "auto"` 是默认最合理的选择。

### Q3: `message` 工具的参数是不是太宽松?
对。`message` 是所有 channel 共享的 omnibus tool,参数是动态 schema —— 不同
action 要求不同字段(`react` 需要 `messageId` + `emoji`,`thread-reply` 需要
`threadId` + `message`,但 JSON Schema 层面没法表达"action=react 时 messageId
必填")。OpenClaw 选择在 system prompt(`### message tool` 段)里用自然语言
告诉模型规则,工具 handler 再做运行时校验。如果你用的 provider 严格校验
discriminated union(例如 Anthropic 会比较挑),这里可能要拆成多个 tool 或用
`oneOf` —— 但参考 [CLAUDE.md](../CLAUDE.md) 里的 "Tool schema guardrails",
OpenClaw 默认避免 `anyOf/oneOf`,所以走"一个 tool + 宽 schema + 运行时校验"路线。
