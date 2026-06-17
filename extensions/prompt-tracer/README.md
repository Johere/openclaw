# Prompt Tracer

OpenClaw plugin: capture **full-chain LLM prompt traces** (system prompt, LLM input, wire body, tool calls, assistant reply) to an XML file with a self-contained HTML viewer.

## Slash commands

| Command | Effect |
|---|---|
| `/trace_start` | Start capturing the current session. Returns a `traceId`. |
| `/trace_end` | Stop capturing, write the XML + a self-contained HTML viewer, and return the file paths. |
| `/trace_status` | Show whether recording is active, how many turns / phases / bytes captured so far. |

By default traces land in `~/.openclaw/traces/`. Open the generated `*.html` file directly (XML is inlined by default).

## Configuration

Set under `plugins.entries.prompt-tracer.config` in `~/.openclaw/openclaw.json`:

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | bool | `true` | Master switch |
| `tracesDir` | string | `~/.openclaw/traces/` | Output directory; supports `~` expansion |
| `maxBytesPerPrompt` | int | `262144` (256 KB) | Per-phase cap; 1024–16777216 |
| `captureImages` | bool | `true` | Set `false` to drop image base64 payloads |
| `autoStartChannels` | string[] | `[]` | Channel IDs that auto-start without `/trace_start` |
| `viewer.theme` | `light` \| `dark` | `dark` | Default viewer theme |
| `viewer.inlineXml` | bool | `true` | Inline XML in the HTML viewer (so it opens via `file://` without fetch) |

Config changes hot-reload — no gateway restart needed.

## HTTP routes

The plugin registers `/plugins/prompt-tracer/*` on the gateway:

```
GET /plugins/prompt-tracer/traces/<trace_id>.xml
GET /plugins/prompt-tracer/traces/<trace_id>.html
```

Default gateway listener is `127.0.0.1:18789`. For remote access, use SSH tunnel; never expose the gateway directly.

---

# Building

This plugin can be built two ways. Use **monorepo build** when working inside `openclaw/`. Use **standalone build** when you've copied this directory out of the monorepo for local deployment.

## A. Monorepo build (default)

From the repo root:

```bash
pnpm install
pnpm build
```

The plugin's TypeScript is compiled as part of the workspace build via `tsconfig.json` (which extends the package-boundary base config). No further setup needed.

## B. Standalone build

For deploying this plugin on a machine that only has the **published `openclaw` npm package** installed (no monorepo checkout), copy the directory out and use `tsconfig.standalone.json`:

### 1. Copy the plugin to a standalone location

```bash
mkdir -p ~/.openclaw/plugins
cp -r <path-to-monorepo>/extensions/prompt-tracer ~/.openclaw/plugins/prompt-tracer
cd ~/.openclaw/plugins/prompt-tracer
```

> Don't try to install directly from the monorepo path with `--link` — the runtime will follow the monorepo's source layout looking for `openclaw/plugin-sdk/zod` etc. and fail to find `node_modules/zod` since the workspace deps may not be installed.

### 2. Bootstrap deps for the standalone config

`tsconfig.standalone.json` resolves the SDK types via `node_modules/openclaw/dist/plugin-sdk/*.d.ts`. Make that path exist:

```bash
# Inside the standalone plugin directory:
npm init -y                                       # if no package-lock yet
npm install --no-save openclaw@latest @types/node typescript
```

This drops the openclaw SDK's `.d.ts` files into the plugin's local `node_modules/`, which is what the `paths` mapping in `tsconfig.standalone.json` points at.

> Alternative: if you have openclaw installed globally (`npm install -g openclaw`), point `paths` at `$(npm root -g)/openclaw/dist/plugin-sdk/*.d.ts` instead. Edit `tsconfig.standalone.json`.

### 3. Compile

```bash
npx tsc -p tsconfig.standalone.json
```

Output lands in `dist/`:

```
dist/
├── index.js
├── api.js
└── src/
    ├── plugin.js
    ├── command.js
    ├── config.js
    ├── http.js
    ├── manager.js
    ├── paths.js
    ├── recorder.js
    ├── viewer-assets.js
    ├── viewer-client.js
    └── xml.js
```

### 4. Install into openclaw

```bash
openclaw plugins install .
systemctl --user restart openclaw-gateway
```

`openclaw plugins install` requires compiled JS at `./dist/index.js` (see step 3). It then copies the directory into `~/.openclaw/extensions/prompt-tracer/` and writes the entry into `openclaw.json`.

Verify:

```bash
openclaw plugins list   | grep prompt-tracer
openclaw plugins inspect prompt-tracer
openclaw plugins doctor
```

### 5. Iterating on standalone source

```bash
# edit src/*.ts
npx tsc -p tsconfig.standalone.json
openclaw plugins install . --force        # overwrite previous install
systemctl --user restart openclaw-gateway
```

Or use `--link` once the directory has a valid `dist/` so changes only need a recompile + gateway restart:

```bash
openclaw plugins uninstall prompt-tracer --force
openclaw plugins install . --link
# then: edit → tsc → systemctl restart
```

## Build artifacts and gitignore

The standalone build writes to `dist/`. If you keep the standalone copy under version control, add:

```
dist/
node_modules/
package-lock.json
```

The monorepo build's outputs are tracked separately by the workspace tooling and are not affected by this README.

---

# Known caveats (source drift to monitor)

The plugin source targets the openclaw SDK as of **2026.4**. When building against newer SDKs you may see type-only warnings (JS still emits successfully thanks to `skipLibCheck: true`):

1. `zod` v3 → v4: `.default({})` overload signatures shifted. Runtime is unaffected; consider migrating to v4 idiom when you touch `src/config.ts`.
2. `AgentMessage` union may have new variants (e.g. `CompactionSummaryMessage`); `src/recorder.ts` casts can become unsound.
3. If `lib`/`types` aren't set, `node:fs/promises` and `Array.prototype.toSorted` may report missing types — `tsconfig.standalone.json` already includes `"lib": ["ES2023"]` and `"types": ["node"]` to cover this.
