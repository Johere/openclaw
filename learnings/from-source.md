---
title: "从源码运行 OpenClaw"
summary: "克隆仓库,直接跑 TypeScript 源码、把本地 checkout 当全局 CLI 用、或者打成 tarball 验证发布包"
read_when:
  - "想改 OpenClaw 本身、边改 src/** 边调试"
  - "希望在任意目录用自己的 checkout 当 openclaw 命令"
  - "发版前想验证 npm tarball 是否正确"
---

# 从源码运行 OpenClaw

这个页面是给想**从 `git clone` 跑 OpenClaw**的人看的,而不是直接
`npm install -g openclaw`。下面四条路径按"从最快到最正统"排好:

| 场景 | 路径 |
|---|---|
| 改 `src/**` 立刻测 | [路径 A:开发循环](#路径-a开发循环) |
| 把 checkout 当全局 `openclaw` 命令用 | [路径 B1:npm link](#路径-b1npm-link) |
| 验证发布 tarball 的完整性 | [路径 B2:npm pack](#路径-b2npm-pack) |
| 只想跑一次看效果 | [路径 C:直接调用](#路径-c直接调用) |

日常开发 90% 的时间停留在**路径 A**,只有要测"真实安装体验"或把 checkout 当
系统命令时才切到 B。

## 前置条件

- **Node.js**:`22.16+`,推荐 `24`。`openclaw.mjs` 开头就有版本校验,低了直接
  拒启动。安装指南见 [Node.js](/install/node)。
- **pnpm**:仓库用 `pnpm-lock.yaml` 和 `pnpm.patchedDependencies`。`bun install`
  也能用,但动 deps 时要保持 lockfile 同步。**不推荐**在仓库根用 `npm install`。
- **Git**:用来 clone 主仓库 (`openclaw/openclaw`)。
- **磁盘**:`pnpm install` 之后大约 2 GB(bundled plugins + Playwright 浏览器
  + 测试 fixture)。

```bash
git clone https://github.com/openclaw/openclaw
cd openclaw
pnpm install
```

`pnpm install` 会自动把 [`extensions/`](https://github.com/openclaw/openclaw/tree/main/extensions)
下 100+ 个 bundled plugins 以 workspace 包的方式链好,**不需要**单独装插件。

## 路径 A:开发循环

直接跑 TypeScript 源码,不需要预先编译。改代码 → 下一次调用就生效,是
日常 hack 最常用的方式。

```bash
pnpm openclaw <args>
# 等价写法:
pnpm dev
pnpm start
```

三个都指向 `node scripts/run-node.mjs`,内部用 **tsdown + jiti** 直接执行
`src/**` 和 `extensions/**` 的 TS。它会监听 `src/**`、`extensions/**`、根级
`tsconfig.json` / `package.json` / `tsdown.config.ts`,下一次启动就会拿到
你刚改的代码。

典型用法:

```bash
pnpm openclaw --version
pnpm openclaw onboard
pnpm openclaw gateway run --bind loopback --port 18789 --verbose
pnpm openclaw channels status --probe
```

这条路径**不会**把 `openclaw` 命令装到 PATH 里。所有命令都用
`pnpm openclaw ...`。

## 路径 B1:npm link

先 build 一次,再把 checkout 注册成全局 `openclaw` 命令。这样在任何目录的
shell 里敲 `openclaw` 都走你的本地代码。

```bash
pnpm install
pnpm build       # 生成 dist/
npm link         # 在仓库根执行
openclaw --version
```

- `npm link` 是**非破坏性的** —— 它把全局 `openclaw` 符号链接到 checkout 里的
  `openclaw.mjs` + `dist/`,不会覆盖你装过的 npm 版本(但会抢 PATH 优先级)。
- 改完 `src/**` 需要重跑 `pnpm build`。`npm link` 指的是编译后的 `dist/`,不是源码。

切回 npm 上的发布版:

```bash
npm unlink -g openclaw       # 或者直接覆盖:
npm install -g openclaw@latest
```

## 路径 B2:npm pack

打出 npm 真的会发的那个 tarball 并全局安装。用来**验证发布包的完整性** ——
`package.json:files` 里该进的都进了没,有没有漏文件。

```bash
pnpm install
pnpm build
npm pack                              # 生成 openclaw-<version>.tgz
npm install -g ./openclaw-<version>.tgz
openclaw --version
```

tarball 里包含 `package.json:files` 列出的所有内容:`dist/`、`openclaw.mjs`、
`skills/`、`docs/`、`scripts/npm-runner.mjs`、
`scripts/postinstall-bundled-plugins.mjs`、`scripts/windows-cmd-helpers.mjs`。

## 路径 C:直接调用

不 link、不全局装,就跑这次。

```bash
pnpm install
pnpm build
node openclaw.mjs <args>
```

和路径 B1 link 出去的 `openclaw` 命令本质一样,只是少了个符号链接。

## 改什么、要不要 rebuild

| 改了什么 | 路径 A | 路径 B1 |
|---|---|---|
| `src/**` | 下次 `pnpm openclaw` 生效 | `pnpm build` |
| `openclaw.mjs`(CLI 入口) | 需要 `pnpm build` | `pnpm build` |
| `package.json:bin` / `exports` | `pnpm build` + 重新 link | `pnpm build` + 重新 link |
| `extensions/<id>/**` | 下次启动生效 | `pnpm build` |

## 本地 verify

提交/推送前,按你改动的范围选对应的 gate:

```bash
pnpm check       # format + lint + tsgo + 额外策略检查(默认本地 gate)
pnpm test        # vitest 全量
pnpm build       # 动到打包 / 公开面 / 懒加载边界时必跑
```

如果改了 config schema 或公开 Plugin SDK,还要重新生成 drift 哈希:

```bash
pnpm config:docs:gen         # config schema 变了
pnpm plugin-sdk:api:gen      # Plugin SDK 公开面变了
```

完整本地验证规范见
[Repository Guidelines](https://github.com/openclaw/openclaw/blob/main/CLAUDE.md)。

## 首次配置

不管走哪条路径,干净的 checkout **还没有 gateway 配置**。推荐先 onboard:

```bash
openclaw onboard            # 路径 B1 / B2
pnpm openclaw onboard       # 路径 A
```

Onboard 会写 `~/.openclaw/config.yaml`、装 gateway daemon,并带你走完 channel
和 provider auth。你也可以直接改 yaml,或者用 `openclaw config set ...`。

完整入门参见 [Getting started](/start/getting-started)。

## 常见坑

- **`node` 版本太老** —— `openclaw.mjs` 会 fail-fast 报错。升到
  [Node 24](/install/node)。
- **`pnpm openclaw` 第一次启动卡住** —— tsdown 在做初次编译,第二次之后走
  缓存就很快了。
- **`npm link` 指到了老版本** —— 用 `which -a openclaw` 看 shell 拿到哪个。
  多半是全局 npm 装过一份,跟 link 出来的冲突了。先
  `npm uninstall -g openclaw` 再 `npm link`。
- **运行时找不到某个 bundled plugin** —— 重跑 `pnpm install` 刷新 workspace 链接,
  如果在路径 B 上再跑一次 `pnpm build`。
- **改了 `dist/**` 不生效** —— 路径 A 根本不用 `dist/`,**不要**手改 `dist/**`;
  路径 B 必须 `pnpm build`。

## 相关

- [Install overview](/install)
- [Node.js](/install/node)
- [Bun](/install/bun)
- [Updating](/install/updating)
- [Development channels](/install/development-channels)
- [Pi development workflow](/pi-dev)
