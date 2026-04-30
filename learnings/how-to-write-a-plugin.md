# 如何写一个 OpenClaw plugin

> 面向想给 OpenClaw 加一个新能力（hook、工具、命令、provider、channel 等）的作者。下面按"最小可运行"到"完整契约"的顺序展开，文件引用全部仓库根相对。

## 0. 先决定 plugin 的 kind

OpenClaw 的 plugin 按职责分成几类，manifest 的 `kind` 字段决定它占哪个"插槽"：

| kind | 用途 | 独占槽 | 典型例子 |
|---|---|---|---|
| 省略（默认 skill） | 挂 hook、加命令、加工具、跑 HTTP 路由 | 否，可并存多个 | [extensions/prompt-tracer/](../extensions/prompt-tracer/)、[extensions/diffs/](../extensions/diffs/) |
| `memory` | 记忆存取 | 是（只能启用一个） | 记忆插件 |
| `context-engine` | 对话上下文拼装策略 | 是 | 上下文引擎 |
| 声明 `providers` | LLM provider（anthropic / openai / vllm / ...） | 否 | [extensions/anthropic/](../extensions/anthropic/)、[extensions/openrouter/](../extensions/openrouter/) |
| 声明 `channels` | 消息渠道（飞书/TG/Discord/...） | 否 | 飞书、matrix、zalo |

一个 plugin 可以同时声明多种能力（例如 provider + skill），manifest 的 `providers` / `channels` / `skills` 是字符串数组。

参考文档：[docs/plugins/architecture.md](../docs/plugins/architecture.md)、[docs/plugins/manifest.md](../docs/plugins/manifest.md)。

## 1. 目录骨架（skill 为例）

以 `extensions/my-plugin/` 为 root，最小文件集如下：

```
extensions/my-plugin/
├── openclaw.plugin.json     # 清单：id、kind、configSchema、UI 提示、env 声明
├── package.json             # 名字 @openclaw/my-plugin，runtime 依赖放这里
├── api.ts                   # 本地 barrel，re-export openclaw/plugin-sdk/*
├── index.ts                 # 入口：definePluginEntry({ id, configSchema, register })
└── src/
    ├── config.ts            # zod/JSON schema，validation + 默认值
    ├── plugin.ts            # registerXxxPlugin(api)：挂 hook / 命令 / HTTP
    ├── <feature>.ts         # 具体业务
    └── <feature>.test.ts    # 并列放置的 vitest 单测
```

仓库规范：extension 生产代码**只能**从 `openclaw/plugin-sdk/*` 和本地 `./api.ts` / `./runtime-api.ts` 导入，不能深挖 `src/**` 或别的 extension 内部 —— 详见 [extensions/CLAUDE.md](../extensions/CLAUDE.md)。

## 2. manifest：`openclaw.plugin.json`

**必需字段**：

- `id`：canonical id，对应配置里的 `plugins.entries.<id>`
- `configSchema`：JSON Schema，可空 `{ "type": "object", "additionalProperties": false }`

**常用可选字段**：

- `name` / `description` / `version` —— 人类可读元数据
- `kind` —— `memory` 或 `context-engine`
- `providers` / `channels` / `skills` —— 本 plugin 注册的 id 列表
- `enabledByDefault` —— bundle 的插件默认 false
- `uiHints` —— `{ "configFieldName": { label, help, placeholder, sensitive } }`
- `providerAuthEnvVars` / `channelEnvVars` —— 供 onboarding/doctor 扫描，无需跑代码就能识别
- `providerAuthChoices` —— 登录选择器里列出的 auth 方式
- `modelSupport` —— provider plugin 用的 `{ modelPrefixes, modelPatterns }`，让 `claude-*` 这类简写自动启用本 plugin
- `contracts` —— 静态 capability 快照（`speechProviders`、`tools`、`webSearchProviders` 等）

**关键思想**：discovery 和 config 校验发生在**代码被执行之前**。auth 环境变量、UI 提示、capability 声明都应该塞进 manifest，而不是等 `register` 回调里再暴露。

看例子：[extensions/prompt-tracer/openclaw.plugin.json](../extensions/prompt-tracer/openclaw.plugin.json)、[extensions/diffs/openclaw.plugin.json](../extensions/diffs/openclaw.plugin.json)。

## 3. package.json

```json
{
  "name": "@openclaw/my-plugin",
  "version": "2026.4.9",
  "private": true,
  "type": "module",
  "dependencies": {
    /* 真正的运行期依赖放这里，例如 playwright-core */
  },
  "devDependencies": {
    "@openclaw/plugin-sdk": "workspace:*"
  },
  "openclaw": {
    "bundle": { "stageRuntimeDependencies": true },
    "extensions": ["./index.ts"]
  }
}
```

**规则**：

- 不要把 `openclaw` 放进 `dependencies`，用 `devDependencies` 或 `peerDependencies`（`workspace:*` 放进 `dependencies` 会让 `npm install --omit=dev` 挂掉）
- runtime 依赖必须放 `dependencies`，因为安装 plugin 时执行的是 `npm install --omit=dev`
- 用 `pnpm.patchedDependencies` 的版本必须写死（不能 `^` / `~`）

## 4. entry：`index.ts`

```ts
import { definePluginEntry } from "./api.js";
import { myPluginConfigSchema } from "./src/config.js";
import { registerMyPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "my-plugin",
  name: "My Plugin",
  description: "…",
  configSchema: myPluginConfigSchema,
  register: registerMyPlugin,
});
```

- 非 channel plugin → `definePluginEntry`（[src/plugin-sdk/plugin-entry.ts](../src/plugin-sdk/plugin-entry.ts)）
- channel plugin → `defineChannelPluginEntry`（[src/plugin-sdk/core.ts](../src/plugin-sdk/core.ts)）
- 单 provider plugin 的便捷封装 → `defineSingleProviderPluginEntry`（[src/plugin-sdk/provider-entry.ts](../src/plugin-sdk/provider-entry.ts)）

## 5. `register(api)` 回调 —— OpenClawPluginApi 通用接口

`register` 是 plugin 真正做事的地方。`api` 是 `OpenClawPluginApi`，按"你要做什么"分组如下：

### 5.1 元信息 / 日志 / 配置

- `api.id` / `api.name` / `api.description` / `api.source` / `api.rootDir`
- `api.pluginConfig` —— manifest 里 `configSchema` 校验过的用户配置
- `api.logger` —— `{ debug?, info, warn, error }`

### 5.2 挂 hook：`api.on(event, handler)`

这是最常用的接口。事件列表在 [src/plugins/types.ts](../src/plugins/types.ts) 的 `PluginHookHandlerMap`。核心事件（常用优先）：

| hook | 时机 | payload 要点 |
|---|---|---|
| `before_prompt_build` | system prompt 拼装前 | `messages[]`, base `prompt`, 可返回 `prependSystemContext` 等做注入 |
| `llm_input` | 真正发给 LLM 前 | `systemPrompt`, `prompt`, `historyMessages`, `provider`, `model`, `runId`, `sessionId` |
| `llm_output` | LLM 返回后 | `assistantTexts`, `usage` |
| `before_tool_call` / `after_tool_call` | 工具调用前后 | `toolName`, `params`, `result`, `error`, `durationMs` |
| `before_message_write` | 消息落 JSONL 前（**同步**，不要 await） | `message`, `sessionKey` |
| `session_start` / `session_end` | 会话生命周期 | `sessionKey`, `channelId` |
| `agent_end` | agent 跑完 | 收尾兜底 |
| `inbound_claim` | 入站消息分派前 | channel 可认领/拒绝，用来做兜底命令匹配 |
| `subagent_spawning` / `subagent_ended` | 子 agent 生命周期 | |
| `message_received` / `message_sending` / `message_sent` | channel 消息收发 | |

**同步 hook 约束**：`before_message_write` 不能 await 任何异步操作 —— push 到内存，异步写盘走别的触发点（`/trace_end` 命令、`session_end` 等）。

### 5.3 注册命令：`api.registerCommand(cmd)`

```ts
api.registerCommand({
  name: "trace_start",
  nativeNames: { default: "trace_start" },   // 各 channel 的原生命令名
  description: "Start capturing a trace.",
  handler: handleTraceStart(deps),
});
```

用户发 `/trace_start` 走这条路径，会绕过 agent 直接交给 handler。OpenClaw 的 `/help` 会自动列出已注册命令。

### 5.4 注册工具：`api.registerTool(tool | factory, opts?)`

给 LLM 可调用的 tool。工具 schema 用 zod；注意 [CLAUDE.md](../CLAUDE.md) 里的 "Tool schema guardrails"：避免 `Type.Union`、`anyOf/oneOf/allOf`，用 `stringEnum` / `Type.Optional`，顶层必须是 `type: "object"` + `properties`。

### 5.5 注册 HTTP 路由：`api.registerHttpRoute`

```ts
api.registerHttpRoute({
  path: "/plugins/my-plugin",
  auth: "gateway",          // gateway 认证后放行
  match: "prefix",          // 或 "exact"
  handler: myHttpHandler,
});
```

用来暴露 viewer HTML、下载文件、查询 plugin 状态等。

### 5.6 注册服务：`api.registerService({ id, start })`

有生命周期的后台服务（定时任务、WebSocket、清理钩子）。`start` 里可以 `process.once("beforeExit", …)` 做兜底 flush。

### 5.7 注册 provider（provider plugin 用）

- `api.registerProvider(provider)` —— 文本推理 provider
- `api.registerSpeechProvider(...)`、`api.registerRealtimeVoiceProvider(...)`、`api.registerImageGenerationProvider(...)` 等 —— 分类 provider
- provider 对象要给：`id`、`label`、`docsPath`、`auth`、`catalog`，可选 `wrapStreamFn`（包一层做 payload 捕获 / 协议兼容）

`wrapStreamFn` 的三步契约（让别的 plugin 能 hook 住你的 wire body）：

1. 在 `api.registerProvider` 里导出 `wrapStreamFn`
2. wrap 里 **preserve + chain** 上游的 `options.onPayload`
3. provider 底层 streamFn 在真正发 HTTP 前主动调 `options.onPayload?.(finalBody)`

少一步都静默失败。参考 [extensions/xai/stream.ts](../extensions/xai/stream.ts) 和 [src/agents/anthropic-payload-log.ts](../src/agents/anthropic-payload-log.ts)。

### 5.8 注册 channel（channel plugin 用）

`api.registerChannel({ plugin })`，`plugin` 是 `ChannelPlugin<TResolvedAccount>`，要给：`id`、`setup`、`config`（账号 schema）、`security`（DM 策略）、`pairing`（配对审批）、`threading`（回复线程）、`outbound`（发送适配器）。推荐用 `createChatChannelPlugin` helper。详见 [docs/plugins/sdk-channel-plugins.md](../docs/plugins/sdk-channel-plugins.md)。

### 5.9 其他

- `api.registerGatewayMethod(method, handler, opts?)` —— 对 Gateway 控制面暴露 RPC
- `api.registerCli(registrar, opts?)` —— 给 `openclaw` CLI 加子命令
- `api.registerContextEngine(...)` —— 仅 `kind: "context-engine"`
- `api.registerMemoryProvider(...)` —— 仅 `kind: "memory"`

## 6. 测试约定

- 文件就地并列：`src/foo.ts` ↔ `src/foo.test.ts`
- 用 vitest：`describe / it / expect / vi`
- mock seam：对 `node:fs/promises`、外部 SDK 用 `vi.mock(...)` 打桩
- 运行：`pnpm test extensions/my-plugin/src/foo.test.ts`（根目录原生入口，会走仓库默认 pool 配置）
- **不要**在 hot loop 里 `vi.resetModules() + await import`，一次 beforeAll import 后只重置 mock 状态
- 在 extension 内部的生产代码不要反向 `openclaw/plugin-sdk/<self>`，用本地 `./api.ts` barrel

参考：[extensions/prompt-tracer/src/manager.test.ts](../extensions/prompt-tracer/src/manager.test.ts)、[extensions/prompt-tracer/src/command.test.ts](../extensions/prompt-tracer/src/command.test.ts)。

## 7. 构建、落地、发布前的 gate

本地开发：

```bash
pnpm install
pnpm openclaw ...      # 开发模式跑
pnpm check             # format + lint + 基础检查（默认本地 gate）
pnpm test              # 全量 vitest（main 落地 gate）
pnpm build             # 影响打包/模块边界/lazy-loading 时必须跑
```

**碰到下列情况时**需要跑对应的 `:gen` 并 commit 生成出的 `.sha256`：

- 改了 config schema / help → `pnpm config:docs:gen`
- 改了 Plugin SDK 公共表层 → `pnpm plugin-sdk:api:gen`

**commit**：用 `scripts/committer "<msg>" <file...>`，不要散手 `git add`；commit message 用 action-oriented 风格（`PromptTracer: capture tool observations`）。

**labels**：新 plugin 要在 `.github/labeler.yml` 登记路径，并在 GitHub 创建对应标签（复用现有 plugin 色）。

## 8. 关键参考文件清单

| 文件 | 内容 |
|---|---|
| [docs/plugins/building-plugins.md](../docs/plugins/building-plugins.md) | 入门 quick-start |
| [docs/plugins/architecture.md](../docs/plugins/architecture.md) | 边界与架构 |
| [docs/plugins/manifest.md](../docs/plugins/manifest.md) | 完整 manifest 字段表 |
| [docs/plugins/sdk-overview.md](../docs/plugins/sdk-overview.md) | SDK 总览 |
| [docs/plugins/sdk-entrypoints.md](../docs/plugins/sdk-entrypoints.md) | 入口函数 |
| [docs/plugins/sdk-runtime.md](../docs/plugins/sdk-runtime.md) | 运行期 helper |
| [docs/plugins/sdk-provider-plugins.md](../docs/plugins/sdk-provider-plugins.md) | provider plugin 合同 |
| [docs/plugins/sdk-channel-plugins.md](../docs/plugins/sdk-channel-plugins.md) | channel plugin 合同 |
| [src/plugin-sdk/plugin-entry.ts](../src/plugin-sdk/plugin-entry.ts) | `definePluginEntry` |
| [src/plugin-sdk/core.ts](../src/plugin-sdk/core.ts) | `defineChannelPluginEntry`、核心 helper |
| [src/plugin-sdk/provider-entry.ts](../src/plugin-sdk/provider-entry.ts) | `defineSingleProviderPluginEntry` |
| [src/plugins/types.ts](../src/plugins/types.ts) | 完整 `PluginHookHandlerMap`（30 个 hook） |
| [extensions/CLAUDE.md](../extensions/CLAUDE.md) | extensions 目录边界铁律 |
| [extensions/prompt-tracer/](../extensions/prompt-tracer/) | skill plugin 参考实现 |
| [extensions/diffs/](../extensions/diffs/) | skill plugin（带 UI viewer） |
| [extensions/openrouter/](../extensions/openrouter/) | 带 `wrapStreamFn` 的 provider 参考 |

## 9. 常见坑

- **import 越界**：extension 生产代码只能从 `openclaw/plugin-sdk/*` 和本地 barrel 走；`src/**` 是核心，碰就挂仓库的 architecture gate（`pnpm check-additional`）。
- **同步 hook 里 await**：`before_message_write` 是同步的，handler 必须立刻 return，阻塞会拖慢整个 agent 主循环。
- **provider plugin 丢了 `onPayload` 链**：wrap 里不 chain `originalOnPayload?.(payload, model)`，下游看不到 wire body，排查时以为是别人的 bug。
- **runtime dep 放 devDependencies**：安装时 `--omit=dev`，plugin 启动直接 `Cannot find module`。
- **动态 + 静态混用同一模块**：同一个模块不要 `import` + `await import` 混用，`pnpm build` 会报 `[INEFFECTIVE_DYNAMIC_IMPORT]`；要 lazy 就单独拆一个 `*.runtime.ts` 边界。
- **cache 稳定性**：拼给 model 的 payload 如果来源是 Map/Set/插件列表，必须排序后再送，否则每轮 prompt 前缀字节变化，cache miss。见 CLAUDE.md 的 "Prompt Cache Stability"。
- **manifest 里 env 变量不声明**：auth 变量不写进 `providerAuthEnvVars`，doctor / onboarding 扫不到，用户开箱即用体验坏掉。
