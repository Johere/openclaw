# OpenClaw Provider

> 目标读者:想理解 OpenClaw 怎么把 35+ LLM 供应商统一到同一条 agent loop
> 里,以及为什么"真实发送到 HTTP 的 wire body"不是一个 hook,而是 provider
> 自己的 `wrapStreamFn + onPayload` 装饰器链。
>
> 配套阅读:
>
> - [agent-lifecycle-hooks.md](./agent-lifecycle-hooks.md) —— 全部 30 个 hook 的 mermaid 视图
> - [tutorial.md](./tutorial.md) —— system prompt 结构与 cache boundary
> - `docs/plugins/sdk-provider-plugins.md` —— provider plugin 公开 SDK

---

## 一、Provider 是什么

OpenClaw 的 provider plugin = "一个能把 `ChatRequest -> AsyncIterable<ChatEvent>`
的模型接入",对上游看是统一的 `StreamFn`(来自 `@mariozechner/pi-agent-core`)。

注册入口:`api.registerProvider(...)`,定义见
[src/plugins/types.ts:1220-1400](src/plugins/types.ts)。每个 provider plugin 至少声明:

- `id` —— 例如 `"anthropic"`、`"openai"`、`"vllm"`
- 模型目录(catalog)或 `listModels`
- 认证(API key / OAuth / bearer 等)
- 可选的 `prepareExtraParams` / `createStreamFn` / `wrapStreamFn` /
  `resolveTransportTurnState` / `webSocketSessionPolicy`

### 当前 bundled providers(37 个)

| 类别       | 插件目录                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------- |
| 一线闭源   | `anthropic`, `anthropic-vertex`, `openai`, `google`, `xai`                                          |
| 聚合/代理  | `openrouter`, `copilot-proxy`, `cloudflare-ai-gateway`, `github-copilot`, `litellm`, `kilocode`     |
| 国产/区域  | `zai`, `volcengine`, `stepfun`, `byteplus`, `minimax`, `deepseek`, `kimi-coding`, `arcee`, `chutes` |
| 自托管/OSS | `vllm`, `sglang`, `ollama`, `huggingface`, `fireworks`, `groq`, `vydra`                             |
| 云厂商     | `amazon-bedrock`, `amazon-bedrock-mantle`, `microsoft-foundry`                                      |
| 其他       | `fal`, `comfy`, `opencode`, `opencode-go`, 等                                                       |

用 `rg 'registerProvider\\(' extensions` 可以看到完整清单。

### Provider 如何被调用

在 [src/agents/pi-embedded-runner/run/attempt.ts](src/agents/pi-embedded-runner/run/attempt.ts)
的 turn loop 里,核心一步就是:

```
streamFn = resolveStreamFn(providerId, modelId)
for await (event of streamFn(model, context, options)) { ... }
```

`streamFn` 默认来自 `@mariozechner/pi-ai` 的 `streamSimple`,再依次经过:

1. OpenClaw 通用 transport wrapper(重试/取消/遥测等)
2. **Provider 自己的 `wrapStreamFn`**(provider-specific 兼容性/body patch)
3. 最终命中 HTTP / WebSocket 传输

---

## 二、`wrapStreamFn + onPayload` 是什么

### 签名

```ts
// src/plugins/types.ts:1302
wrapStreamFn?: (ctx: ProviderWrapStreamFnContext) => StreamFn | null | undefined;

// src/plugins/types.ts:717
export type ProviderWrapStreamFnContext = ProviderPrepareExtraParamsContext & {
  model?: ProviderRuntimeModel;
  streamFn?: StreamFn;   // 上游已经装好的 StreamFn
};
```

返回值是**新的 `StreamFn`**。整个机制是典型的装饰器链:provider 插件可以包住
下游的 `streamFn`,在真正调用前修改 body / header,或者在事件流里做二次处理。

### `onPayload` 是 `pi-ai` 提供的 "出站 payload 侧信道"

`streamSimple` 在真正发 HTTP 之前会调用一次 `options.onPayload(finalBody, model)`
让上层拿到序列化完成的 JSON wire body。这是**目前 OpenClaw 能拿到 wire body 的
唯一路径**。

### 标准链式模式(最重要)

参考 [`src/agents/anthropic-payload-log.ts:134-156`](src/agents/anthropic-payload-log.ts#L134)
和 [`extensions/xai/stream.ts:157-180`](extensions/xai/stream.ts#L157):

```ts
function myWrapStreamFn(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const underlying = ctx.streamFn;
  if (!underlying) return undefined;

  return (model, context, options) => {
    const originalOnPayload = options?.onPayload; // ① 保留上游 callback

    return underlying(model, context, {
      ...options,
      onPayload: (payload, m) => {
        // ② 在这里看到/修改 wire body
        mutateIfNeeded(payload);
        record({ ts: new Date().toISOString(), payload });

        // ③ 必须 chain 给下游,否则上层会拿不到
        return originalOnPayload?.(payload, m);
      },
    });
  };
}
```

关键三点:

1. **不要吞掉 `originalOnPayload`**。同一个 provider 上可能叠了多个 wrapper
   (例如 `anthropic-payload-log` + `prompt-tracer`),漏 chain 会导致后装的
   wrapper 拿不到 payload。
2. **`wrapStreamFn` 只能由 provider 插件自己注册**。其它插件要捕获 wire body
   必须走下面 §四 的机制。
3. **Provider 底层 streamFn 必须在真正 `fetch()` 前调用 `options.onPayload`**。
   `pi-ai` 的 `streamSimple` 天然满足;自己手搓 HTTP 客户端的 provider 必须
   主动触发 callback,否则 wrapper 再怎么装也拿不到。

---

## 三、为什么不是一个 hook?

(这是上一轮讨论的结论,总结在这里以备忘。)

OpenClaw 的 plugin hook(`before_prompt_build` / `llm_input` /
`before_tool_call` / ...)的**设计语义**是:

> "在 agent lifecycle 的抽象事件上发生时通知插件,事件 payload 是 **provider
> 无关**的规范化形状。"

但 wire body 本质是 **provider-specific 的 JSON schema**:

- Anthropic: `{ system, messages, tools, cache_control, thinking, ... }`
- OpenAI Chat Completions: `{ model, messages, tools, tool_choice, temperature, ... }`
- OpenAI Responses API: `{ input, reasoning, instructions, ... }`
- Gemini: `{ contents, generationConfig, tools[{ functionDeclarations }], ... }`

如果把 wire body 做成统一 hook,core 要么暴露 `unknown`(插件要自己按
provider 分支),要么维护一个巨大的 union type(违反 CLAUDE.md 的
"core 必须 provider-agnostic" 规则)。

所以 OpenClaw 的选择是:

- **抽象事件** → hook(稳定、generic、有类型)
- **provider wire 层** → `wrapStreamFn + onPayload`(provider 自己负责,
  允许 schema 随 vendor 演化)

这不是历史包袱,是刻意设计 —— 每个 provider 独立演进 wire schema,
core 只提供一个装饰器位点,不跟 vendor schema 绑定。

---

## 四、第三方 provider 接入 wire body 捕获的三步契约

第三方 provider plugin 想让 prompt-tracer / anthropic-payload-log /
diagnostics-otel 之类的插件能看到 wire body,必须满足:

### 1. 在 `registerProvider` 里挂 `wrapStreamFn`

```ts
// extensions/<my-provider>/index.ts
api.registerProvider({
  id: "my-provider",
  // ... catalog / auth / prepareExtraParams ...
  wrapStreamFn: myWrapStreamFn, // 没这行,永远拿不到 wire body
});
```

### 2. 在 `wrapStreamFn` 里遵守链式契约

见 §二 示例。核心:`const originalOnPayload = options?.onPayload` → chain
到下游。

### 3. 底层 streamFn 必须在 `fetch` 前触发 `options.onPayload(body, model)`

- 如果用 `pi-ai` 的 `streamSimple` —— 天然满足。
- 如果自己写 HTTP 客户端 —— 必须在 request 发出前主动调用:
  ```ts
  const body = buildBody(...);
  await options?.onPayload?.(body, model);
  const resp = await fetch(url, { body: JSON.stringify(body), ... });
  ```

**三步少做任一步,`wire_body` 就 silently 缺失**(没有报错,只是观察链拿不到
payload)。

### bundled providers 的现状(2026-04)

| 已挂 `wrapStreamFn` 并正确 chain                                                                        | 未挂(wire body 观察不到)                                                                                      |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `anthropic`, `openai`, `openrouter`, `xai`, `github-copilot`, `kimi-coding`, `ollama`, `amazon-bedrock` | `vllm`, `vercel-ai-gateway`, `sglang`, `zai`, `volcengine`, `deepseek`(大部分国产 provider 直接用通用 stream) |

对想观察 vLLM wire body 的用户,推荐 workaround:**改用 `openai` provider 指向
vLLM 的 `baseUrl`**(vLLM 是 OpenAI-compatible),`openai` 已经挂了 wrap hook,
白嫖即可。长期方案是给 `extensions/vllm` upstream 一个 `wrapStreamFn` PR。

---

## 五、什么时候用 hook,什么时候用 `wrapStreamFn`?

| 需求                                           | 用什么                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 记录用户输入 / assistant 输出 / tool_call 事件 | Plugin hook(`before_prompt_build` / `llm_output` / `after_tool_call`)                                    |
| 注入 system prompt 内容、prepend 用户消息      | `before_prompt_build` 返回 `prependContext` / `prependSystemContext`                                     |
| 观察 / 修改真实 HTTP wire JSON                 | **只能** `wrapStreamFn + onPayload`,且插件必须是 **provider 自己**                                       |
| 业务层插件需要 wire body                       | 不行 —— 只能看 `llm_input`(prompt 文本层),缺 `tools[]` / `cache_control` / `tool_choice` / sampling 参数 |
| Provider-specific header / retry policy        | `resolveTransportTurnState` / `webSocketSessionPolicy`                                                   |
| Provider-specific tool schema 兼容性修复       | `wrapStreamFn`(见 xai `stripUnsupportedStrictFlag`)                                                      |

**经验法则**:

- 抽象事件 → hook。
- 真实 wire 层 → provider-owned wrapper。
- 跨 provider 通用的 transport-level 行为 → 走
  `openclaw/plugin-sdk/*` 的共享 family helper(见
  [extensions/CLAUDE.md](extensions/CLAUDE.md) boundary rules),不要每个
  provider 各写一份。

---

## 六、Provider 解析:id 只是 lookup key,`model.api` 才是真正驱动

很多人以为 "provider id 决定了发请求去哪" —— **错**。真正干活的字段是
`model.api`(transport family 枚举)。provider id 只是插件注册表的 lookup key,
用来找那些**可选**的 hook(`createStreamFn` / `wrapStreamFn` /
`prepareExtraParams` / ...)。

### 两层解析

**第一层:config 读入**(不要求 provider 有对应 plugin)

[src/agents/models-config.providers.implicit.ts](src/agents/models-config.providers.implicit.ts)
把 `models.providers.<anything>` 读成 `ProviderConfig`。这一层**只做解析**,
`<anything>` 是什么字符串都不报错。

**第二层:运行时选 `StreamFn`**

[src/agents/pi-embedded-runner/stream-resolution.ts](src/agents/pi-embedded-runner/stream-resolution.ts)
走这个决策:

```
resolveProviderRuntimePlugin(provider)
  ├─ 有 plugin?
  │    ├─ plugin.createStreamFn 有? → 用它(完全自定义 transport)
  │    └─ 没有 → 走 pi-ai streamSimple,按 model.api 分派
  └─ 没 plugin?
       └─ 直接走 pi-ai streamSimple,按 model.api 分派
           ├─ api = "openai-responses"     → pi-ai 的 OpenAI Responses transport
           ├─ api = "openai-completions"   → pi-ai 的 OpenAI Chat Completions
           ├─ api = "anthropic-messages"   → pi-ai 的 Anthropic Messages
           ├─ api = "gemini"               → pi-ai 的 Gemini transport
           └─ api 未知                      → 启动时报错
```

[src/plugins/provider-runtime.ts:583-590](src/plugins/provider-runtime.ts#L583)
的 `resolveProviderStreamFn` 就是这个分派:

```ts
return resolveProviderRuntimePlugin(params)?.createStreamFn?.(params.context) ?? undefined;
// → undefined 时调用方 fallback 到 pi-ai streamSimple + model.api
```

### 验证:用随便起的 provider id 能 work

```yaml
models:
  providers:
    vllm-local: # ← 没有任何 plugin 叫这个名字
      baseUrl: http://localhost:41091/v1
      apiKey: none
      api: openai-completions # ← 关键的一行
      models:
        - id: Qwen/Qwen3.5-35B-A3B
          input: ["text", "image"]
          contextWindow: 49152
          maxTokens: 4096
          cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 }
          compat: { thinkingFormat: qwen-chat-template }
```

这份 config 能 work 的原因:

1. `vllm-local` 在 `resolveProviderRuntimePlugin("vllm-local")` 里找不到 plugin
   → 返回 `undefined`(**不报错**)
2. Fallback 到 `model.api = "openai-completions"`
3. `pi-ai.streamSimple` 认识 `openai-completions` → 用 OpenAI Chat Completions
   的 wire format 发请求到 `baseUrl + "/chat/completions"`
4. SSE 返回,解析成 `AssistantMessage` 事件流

**把 `api: openai-completions` 改成 `foo-bar`,立刻报 unknown API family**。

### 各字段的实际职责

| 字段                   | 谁读它              | 什么时候生效            |
| ---------------------- | ------------------- | ----------------------- |
| `providers.<id>` key | 插件注册表 lookup | 运行时找 hook,没找到就跳过 |
| `baseUrl`              | pi-ai streamSimple  | 拼 HTTP URL             |
| `apiKey`               | pi-ai streamSimple  | `Authorization: Bearer ...` |
| `api`(provider 级别) | pi-ai streamSimple  | **决定 transport family** |
| `api`(model 级别)    | 同上,优先级更高     | 覆盖 provider 级别        |
| `models[].id`          | pi-ai streamSimple  | HTTP body 里的 `model` 字段 |
| `models[].input`       | OpenClaw catalog    | capability gating / UI 展示 |
| `models[].contextWindow` | token 预算管理    | compaction / truncation |
| `models[].maxTokens`   | 默认 `max_tokens`   | body 里的生成长度       |
| `models[].cost`        | usage tracking      | 计费 / 统计(本地可以 0) |
| `models[].compat.*`    | OpenClaw per-model 行为 | thinking 格式 / cache 策略等 |

### 所以 "provider plugin" 的附加价值在哪

没有 plugin 也能跑 → 那 plugin 给你什么?答:**UX + 自动化 + 可观察性**:

- Onboard UI 里有 "my-provider" 选项,不用手写 yaml
- `discovery` 自动拉 `/v1/models`,不用手写 `models: [...]`
- API key env var 的 fallback / OAuth / Azure / ChatGPT Codex 特殊分支
- `wrapStreamFn`:**prompt-tracer / anthropic-payload-log 能看到 wire body**
- `prepareExtraParams`:注入 provider default sampling 参数
- `resolveDynamicModel` / `resolveSystemPromptContribution`:模型发现、
  provider-specific system 提示(Anthropic 的 `<system>` vs OpenAI 的 system role)
- 公司级 doctor / setup 检查

**传输层 HTTP 调用本身跟不写 plugin 完全等价** —— 差的是这圈工程化。

---

## 七、接入本地 RESTful microservice:实操路径

### 路径 A:服务是 OpenAI-compatible,只想跑通

**什么都不写,只编辑 config**:

```yaml
models:
  providers:
    my-svc:
      baseUrl: http://localhost:8000/v1
      apiKey: any
      api: openai-completions
      models:
        - id: my-model-0.1
          contextWindow: 32768
```

完事。agent 里用 `my-svc/my-model-0.1` 就能调。

- **限制**:`wrapStreamFn` 无,prompt-tracer 观察不到 wire body(除非 tracer
  自己直接塞 `onPayload`,要看组装顺序)
- **建议场景**:smoke test、临时接入、个人实验

### 路径 B:要独立的 UI / catalog / 观察链(复刻 vLLM plugin)

100 行薄壳 plugin,照抄 [extensions/vllm/index.ts](extensions/vllm/index.ts):

```ts
api.registerProvider({
  id: "my-svc",
  label: "My Service",
  envVars: ["MY_SVC_API_KEY"],
  auth: [
    {
      id: "custom",
      kind: "custom",
      run: (ctx) =>
        providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
          cfg: ctx.config,
          prompter: ctx.prompter,
          providerId: "my-svc",
          defaultBaseUrl: "http://localhost:8000/v1",
          defaultApiKeyEnvVar: "MY_SVC_API_KEY",
          modelPlaceholder: "<model-id>",
        }),
    },
  ],
  discovery: {
    order: "late",
    run: (ctx) =>
      providerSetup.discoverOpenAICompatibleSelfHostedProvider({
        ctx,
        providerId: "my-svc",
        buildProvider: buildMySvcProvider,
      }),
  },
});
```

依旧**没有** `createStreamFn` / `wrapStreamFn` —— 走 pi-ai generic transport。
如果想让 prompt-tracer 看到 wire body,额外加 `wrapStreamFn` 按 §二 链式模板。

### 路径 C:服务是自己的 JSON schema(不是 OpenAI / Anthropic / Gemini 兼容)

必须写完整的 `createStreamFn`,参考
[extensions/ollama/src/stream.ts](extensions/ollama/src/stream.ts)。关键点:

1. 把 `pi-agent-core` 的 `Context`(messages + tools + systemPrompt)序列化成
   你的服务格式
2. **在 `fetch` 前调 `options.onPayload?.(body, model)`**,否则 prompt-tracer
   拿不到 wire body
3. 用 `createAssistantMessageEventStream`(pi-ai 出的 helper)把响应组装成
   `AssistantMessage` 事件流
4. 错误 throw 出去,由 agent loop 决定重试

### 接入 microservice 时必须注意的点

- **streaming**:OpenClaw 期望**事件流**。非流式响应需要手工包成单事件流。
- **`onPayload` 必须在 `fetch` 前调用**(路径 C 才需要注意,路径 A/B 走
  `pi-ai.streamSimple` 天然满足)。
- **Tool calling**:服务不支持 tools → agent loop 可能生成工具调用然后 hang。
  缓解:`prepareExtraParams` 返回清掉 tools 的 params,或 agent 配置不给 tools。
- **Auth**:本地无 auth 放哨兵值(Ollama 用 `"ollama-local"`);bearer token
  走 `ProviderAuthMethod.kind: "api-key"` + env var。
- **Model catalog**:至少一条 model entry,否则 agent 找不到 model。每条
  必须有 `api` 字段(路径 A 用 `"openai-completions"` / `"openai-responses"`)。
- **Prompt cache**:本地服务通常没 cache,core 的 cache boundary 注入照常
  发生但服务会忽略,不影响功能。
- **Timeout / retry**:通用 wrapper 默认有重试,flakey 服务可能被打 3 次。
  长推理需要在 `createStreamFn` 里自己管 `AbortSignal` + 超时。
- **包边界**:扩展内从 `openclaw/plugin-sdk/*` 引入,不跨 `src/**`。详见
  [extensions/CLAUDE.md](extensions/CLAUDE.md)。

### 最小验证清单

```
[ ] microservice 起在 http://localhost:PORT,curl 能拿到流
[ ] 如果 OpenAI-compatible,/v1/chat/completions 能走通 stream:true
[ ] config 里出现 models.providers.<id>.{baseUrl, apiKey, api, models[]}
[ ] pnpm openclaw 启动 → 发消息 → microservice 日志有请求进来
[ ] tools 调用能往返(如果服务支持)
[ ] 用 prompt-tracer 录一轮,看 wire_body 是否被捕获
    (取决于 wrapStreamFn 或 createStreamFn 里是否触发 onPayload)
[ ] 如果写了 plugin,pnpm test 跑插件单测
```

### 决策速查

| 服务形态                         | 路径        | 要写什么                                         |
| -------------------------------- | ----------- | ------------------------------------------------ |
| OpenAI-compatible,不在乎独立 UI | A(纯 config) | config 里 `api: openai-completions`              |
| OpenAI-compatible,要独立品牌   | B(薄壳 plugin) | 复刻 vLLM ~100 行,无自定义 stream              |
| OpenAI-compatible,要观察 wire body | B + wrapStreamFn | 上面 + 按 §二 链式模板加 wrapper            |
| 自己的 JSON schema              | C           | 写 `createStreamFn` + 可选 `wrapStreamFn`         |
| Anthropic 兼容(少见)           | 类 A/B      | `api: anthropic-messages`                         |
| 完全 async(非流式)              | C + 手工包流 | `createStreamFn` 里用 `createAssistantMessageEventStream` |

推荐从 **A** 起步 → 跑通 → 再考虑是否要升级到 B / C。

---

## 八、`createStreamFn` / `wrapStreamFn` 源码解析

前面几节把这两个函数当黑盒描述。这节深入到 types.ts 和 runner 的实际调用链,
回答:**这两个钩子的边界到底在哪?为什么一个"完全替换",一个"装饰"?**

### 8.1 签名对比 —— 类型先说话

两个函数都出现在 provider plugin 注册对象里
([src/plugins/types.ts:1288-1302](src/plugins/types.ts#L1288)):

```ts
/**
 * Provider-owned transport factory.
 *
 * Use this when the provider needs a fully custom StreamFn instead of a
 * wrapper around the normal `streamSimple` path.
 */
createStreamFn?: (ctx: ProviderCreateStreamFnContext) => StreamFn | null | undefined;

/**
 * Provider-owned stream wrapper applied after generic OpenClaw wrappers.
 *
 * Typical uses: provider attribution headers, request-body rewrites, or
 * provider-specific compat payload patches that do not justify a separate
 * transport implementation.
 */
wrapStreamFn?: (ctx: ProviderWrapStreamFnContext) => StreamFn | null | undefined;
```

差别全在 context 上:

| 字段              | `ProviderCreateStreamFnContext` | `ProviderWrapStreamFnContext`                  |
| ----------------- | ------------------------------- | ---------------------------------------------- |
| `config`          | ✅                              | ✅(继承自 `ProviderPrepareExtraParamsContext`) |
| `provider`        | ✅                              | ✅                                             |
| `modelId`         | ✅                              | ✅                                             |
| `model`           | ✅(必填,`ProviderRuntimeModel`)| 可选                                           |
| `extraParams`     | ❌                              | ✅                                             |
| `thinkingLevel`   | ❌                              | ✅                                             |
| **`streamFn`**    | ❌                              | ✅(**关键区别**—上游已经装好的 StreamFn)      |

一句话总结:

- `createStreamFn` 拿到"我要传输的 model",**从零开始**返回一个 StreamFn。
- `wrapStreamFn` 拿到"上游已经装好的 streamFn",**装饰并返回**一个新的 StreamFn。

定义点:[src/plugins/types.ts:701-708](src/plugins/types.ts#L701)、
[:717-720](src/plugins/types.ts#L717)。

### 8.2 运行时组装链 —— 两个钩子落在哪

真正把两个钩子串起来的是 runner 的 provider 初始化流程:
[src/agents/pi-embedded-runner/stream-resolution.ts:74-120](src/agents/pi-embedded-runner/stream-resolution.ts#L74)
拿到初始 `streamFn`,再交给
[src/agents/pi-embedded-runner/extra-params.ts:490-515](src/agents/pi-embedded-runner/extra-params.ts#L490)
依次叠 wrapper。**调用顺序是有讲究的**:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Step 1 — 选基底 StreamFn                                           │
│  resolveEmbeddedAgentStreamFn(stream-resolution.ts)                  │
│    ├─ plugin.createStreamFn 返回了非空? → 用它(绕过 pi-ai)        │
│    └─ 否则 → 用 streamSimple / WS / boundary-aware / anthropic-vertex │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Step 2 — applyExtraParamsToAgent(extra-params.ts:443)               │
│                                                                       │
│  agent.streamFn = providerStreamBase  ← Step 1 的结果                │
│                                                                       │
│  ┌──── providerRuntimeDeps.wrapProviderStreamFn(...) ────┐            │
│  │ 调用 plugin.wrapStreamFn,传入 streamFn = base       │            │
│  │ 如果 plugin 返回非空 → 替换 agent.streamFn           │            │
│  └──────────────────────────────────────────────────────┘            │
│                                                                       │
│  applyPrePluginStreamWrappers(L364-389)                              │
│    ├─ createStreamFnWithExtraParams(temperature/topP/... 注入)       │
│    └─ SiliconFlow thinking=off 兼容                                  │
│                                                                       │
│  applyPostPluginStreamWrappers(L391-435)                             │
│    ├─ OpenRouter system cache                                        │
│    ├─ OpenAI string content wrapper                                  │
│    ├─ (providerWrapperHandled 为 false 时) Google thinking / OpenAI  │
│    │   Responses context management                                  │
│    ├─ MiniMax thinking disabled                                      │
│    └─ parallel_tool_calls 注入                                       │
└──────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                          真正跑 agent loop
```

**要点**:

1. `createStreamFn` 在**最底层**就替换掉了 pi-ai 的 `streamSimple`,之后所有
   wrapper(通用 + plugin + 兼容层)都装在它外面。
2. `wrapStreamFn` 在 **pre-plugin 兼容 wrapper 之前**就被套上。这意味着:
   - plugin 拿到的 `ctx.streamFn` 是 Step 1 的"赤裸"基底,不带 extraParams 注入
   - 之后 `createStreamFnWithExtraParams` 会再套在外层
3. 如果 plugin `wrapStreamFn` 返回了非空,`providerWrapperHandled = true`,
   后面的 Google thinking / OpenAI Responses 通用 wrapper **会被跳过**
   (L408)—— 这是给 plugin 一个"我已经接管了相关 compat"的开关。

### 8.3 四个真实案例

**案例 A:Ollama `createStreamFn` —— 完全自定义 transport**

[extensions/ollama/src/stream.ts:595-640](extensions/ollama/src/stream.ts#L595)

```ts
export function createOllamaStreamFn(
  baseUrl: string,
  defaultHeaders?: Record<string, string>,
): StreamFn {
  const chatUrl = resolveOllamaChatUrl(baseUrl);
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const run = async () => {
      const ollamaMessages = convertToOllamaMessages(...);
      const ollamaTools = extractOllamaTools(context.tools);
      const body = buildOllamaChatRequest({...});
      options?.onPayload?.(body, model); // ← 关键:发 HTTP 前触发 callback
      // ...fetch(chatUrl, { body: JSON.stringify(body), ... })
    };
    run();
    return stream;
  };
}
```

在 [extensions/ollama/index.ts:239-245](extensions/ollama/index.ts) 注册时走
`createStreamFn`。Ollama 用的是**自己的 `/api/chat` endpoint**(不是
OpenAI-compatible 的 `/v1/chat/completions`),所以必须完整序列化。

**案例 B:anthropic-payload-log `wrapStreamFn` —— 观察型**

[src/agents/anthropic-payload-log.ts:134-156](src/agents/anthropic-payload-log.ts#L134)

```ts
function wrapAnthropicPayloadLogStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const underlying = ctx.streamFn;
  if (!underlying) return undefined;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload, m) => {
        writeJsonlPayloadLog({ ts: new Date().toISOString(), payload });
        return originalOnPayload?.(payload, m); // ← chain
      },
    });
  };
}
```

**只读**:不改 body、不改 header、不改行为,只在 payload 经过时写一行 JSONL。

**案例 C:xAI `wrapStreamFn` —— 修改型(compat patch)**

[extensions/xai/stream.ts:157-180](extensions/xai/stream.ts#L157)

```ts
export function createXaiToolPayloadCompatibilityWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const payloadObj = payload as Record<string, unknown>;
          if (Array.isArray(payloadObj.tools)) {
            payloadObj.tools = payloadObj.tools.map(stripUnsupportedStrictFlag);
          }
          delete payloadObj.reasoning;
          delete payloadObj.reasoning_effort;
        }
        return originalOnPayload?.(payload, model);
      },
    });
  };
}
```

xAI 不支持 OpenAI 的 `strict: true` 工具标志,也不支持 `reasoning_effort`
字段 —— 在发 HTTP 前**直接改 payload**。注册点
[extensions/xai/stream.ts:303-315](extensions/xai/stream.ts#L303) 用
`composeProviderStreamWrappers` 把几个 compat wrapper 叠起来。

**案例 D:GitHub Copilot `wrapStreamFn` —— 动态 header**

[extensions/github-copilot/stream.ts:13-41](extensions/github-copilot/stream.ts#L13)

```ts
export function wrapCopilotAnthropicStream(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    if (model.provider !== "github-copilot" || model.api !== "anthropic-messages") {
      return underlying(model, context, options);
    }
    return streamWithPayloadPatch(
      underlying, model, context,
      {
        ...options,
        headers: {
          ...buildCopilotDynamicHeaders({
            messages: context.messages,
            hasImages: hasCopilotVisionInput(context.messages),
          }),
          ...options?.headers,
        },
      },
      applyAnthropicEphemeralCacheControlMarkers,
    );
  };
}
```

Copilot 对 Anthropic 兼容端点要求每次请求附一组**根据内容计算**的 header
(含 vision 标志、消息特征),加 Anthropic 的 `cache_control` ephemeral 标记。
不改 body schema,也不改 transport,只是在 `streamSimple` 外套一层。

### 8.4 决策矩阵:什么时候用哪个?

| 需求                                               | 用 `createStreamFn` | 用 `wrapStreamFn` |
| -------------------------------------------------- | :-----------------: | :---------------: |
| Provider endpoint 是自己的 JSON schema(非 OpenAI/Anthropic/Gemini)| ✅    | ❌                |
| 需要自己管 SSE / WebSocket / long polling 逻辑     | ✅                  | ❌                |
| 需要完全绕过 pi-ai 的 retry / parse / event stream | ✅                  | ❌                |
| 需要在 HTTP body 发送前改 `tools[]` / `stream_options` | ❌             | ✅                |
| 需要加动态 header(per-request 计算)               | ❌                  | ✅                |
| 需要 observe wire body(只读)                      | ❌                  | ✅                |
| Tool schema 兼容性修复(删字段、改 format)         | ❌                  | ✅                |
| 取消 `reasoning_effort` / `thinking` 之类 vendor 特有字段 | ❌           | ✅                |

**经验法则**:能用 `wrapStreamFn` 就不用 `createStreamFn`。前者站在 pi-ai 已经
写好的 `streamSimple` 上,拿到的已经是序列化完、SSE 解析好的流,改几个字段就行;
后者要**自己实现**事件流构造、JSON 解析、error bubble-up,代码量差十倍。

**两个都定义会发生什么?** plugin 同时有 `createStreamFn` 和 `wrapStreamFn`时:

1. Step 1 用 `createStreamFn` 的返回值作为基底
2. Step 2 把 `wrapStreamFn` 装在外面,`ctx.streamFn` 就是 `createStreamFn`
   的返回值

这是合法的,用例是"自己写 transport,但还想把通用的 compat wrapper(例如统一
log)装外面"。bundled provider 里几乎没人这么做,但契约允许。

### 8.5 `onPayload` 契约 —— 为什么它能跨 wrapper 传递

`onPayload` 是 pi-ai `streamSimple` 定义的**回调**。看名字是"on",其实是
**sync invocation before fetch**:

```ts
// pi-ai 内部(伪代码)
async function streamSimple(model, context, options) {
  const finalBody = serializeForProvider(model, context);
  await options?.onPayload?.(finalBody, model);  // ← 等 callback 完成
  const resp = await fetch(url, { body: JSON.stringify(finalBody), ... });
  // ...
}
```

这意味着:

1. wrapper 里**改 `finalBody`** 会生效(mutation 反映到 fetch)
2. wrapper 里 **chain `originalOnPayload`** 是必须的,否则上层 wrapper
   拿不到 payload(多 wrapper 叠放时尤其重要)
3. `createStreamFn` 的作者**必须手动触发** `options?.onPayload?.(body, model)`
   (见案例 A 的 Ollama);不触发 → 任何 observer wrapper(prompt-tracer /
   anthropic-payload-log)都拿不到 wire body

### 8.6 共享 helper —— `composeProviderStreamWrappers` / `streamWithPayloadPatch`

重复的装饰器叠加很容易写成一坨嵌套 lambda,OpenClaw 把它抽成
[src/plugin-sdk/provider-stream-shared.ts:1-17](src/plugin-sdk/provider-stream-shared.ts):

```ts
export function composeProviderStreamWrappers(
  baseStreamFn: StreamFn | undefined,
  ...wrappers: ProviderStreamWrapperFactory[]
): StreamFn | undefined {
  return wrappers.reduce(
    (streamFn, wrapper) => (wrapper ? wrapper(streamFn) : streamFn),
    baseStreamFn,
  );
}
```

xAI 就是用它按顺序叠了"tool 兼容 → fastMode → 参数 decoding → tool_stream"
四层(见案例 C 的 `wrapXaiProviderStream`)。

`streamWithPayloadPatch`(案例 D 用到)是另一个专用 helper:一次性完成
"patch payload + 添加 header + 委托 streamSimple"。

**重点**:如果你发现自己在写 `const originalOnPayload = options?.onPayload;
return underlying(...)` 这种样板,先查 `provider-stream-shared.ts` 有没有现成
helper,有就用,没有就考虑加一个共享版本而不是 copy-paste(见
[extensions/CLAUDE.md](extensions/CLAUDE.md) 的 boundary rule)。

---

## 九、参考文件速查

- Provider 类型定义: [src/plugins/types.ts:1220-1400](src/plugins/types.ts)
- `ProviderWrapStreamFnContext`: [src/plugins/types.ts:717](src/plugins/types.ts)
- Provider 解析入口:
  - [src/plugins/provider-runtime.ts:208](src/plugins/provider-runtime.ts#L208) `resolveProviderRuntimePlugin`
  - [src/plugins/provider-runtime.ts:583](src/plugins/provider-runtime.ts#L583) `resolveProviderStreamFn`
- Config 层 provider 读入: [src/agents/models-config.providers.implicit.ts](src/agents/models-config.providers.implicit.ts)
- 运行时 StreamFn 决策: [src/agents/pi-embedded-runner/stream-resolution.ts](src/agents/pi-embedded-runner/stream-resolution.ts)
- 典型 wrapper 实现:
  - 观察型(只读 + record): [src/agents/anthropic-payload-log.ts:134-156](src/agents/anthropic-payload-log.ts)
  - 修改型(mutate body): [extensions/xai/stream.ts:157-180](extensions/xai/stream.ts)
  - 注册点: [extensions/anthropic/register.runtime.ts:479](extensions/anthropic/register.runtime.ts),
    [extensions/openrouter/index.ts:111](extensions/openrouter/index.ts),
    [extensions/xai/index.ts:173](extensions/xai/index.ts)
- 路径 A 模板: [extensions/vllm/index.ts](extensions/vllm/index.ts)(95 行)
- 路径 C 模板: [extensions/ollama/src/stream.ts](extensions/ollama/src/stream.ts)(完整 createStreamFn)
- 公开 SDK: `docs/plugins/sdk-provider-plugins.md`
- Plugin 接入清单: `openclaw/plugin-sdk/provider-entry`
