---
title: "Prompt Tracer"
sidebarTitle: "Prompt Tracer"
summary: "Capture full-chain LLM prompt traces (system prompt, LLM input, wire body, tool calls, assistant reply) to XML with a self-contained HTML viewer"
read_when:
  - You want to record the full prompt chain of a session for review or debugging
  - You need to share a reproducible trace of what was sent to and received from the model
  - You are investigating prompt construction, tool calling, or provider wire-level behavior
---

# Prompt Tracer

`prompt-tracer` is a local OpenClaw plugin that records, per session, the full prompt chain — system prompt, LLM input, provider wire body, tool calls, and assistant reply — to a single XML file, alongside a self-contained HTML viewer for browsing the trace offline.

## Deployment

Copy the extension into the OpenClaw state directory and install its dependencies:

```bash
mkdir -p ~/.openclaw/extensions
cp -rf ~/projects/openclaw/extensions/prompt-tracer ~/.openclaw/extensions/
cd ~/.openclaw/extensions/prompt-tracer
npm install
```

Then enable the plugin in `~/.openclaw/openclaw.json` by adding `"prompt-tracer"` to `plugins.allow`:

```json
{
  "plugins": {
    "allow": [
      "prompt-tracer"
    ]
  }
}
```

Validate the config and restart the gateway so the plugin loads:

```bash
openclaw config validate
```

### package.json note

If `npm install` fails with:

```
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

open the plugin's `package.json` and remove the `devDependencies` block that declares `"@openclaw/plugin-sdk": "workspace:*"`. That dependency is a pnpm-workspace reference used during in-repo development. A deployed plugin imports everything through `openclaw/plugin-sdk/<subpath>`, which is resolved against the `openclaw` runtime the user already has installed — no separate SDK package is needed.

## Commands

The plugin registers three slash commands, usable from any connected chat channel:

| Command         | What it does                                                                          |
| --------------- | ------------------------------------------------------------------------------------- |
| `/trace_start`  | Begin capturing the full prompt chain for the current session. Returns a `trace id`. |
| `/trace_status` | Show current recording state: turns captured, phases captured, estimated size.        |
| `/trace_end`    | Stop capturing, flush to disk, return the paths of the XML file and HTML viewer.      |

## Typical workflow

1. In the channel, send `/trace_start`. Every subsequent turn in that session is recorded until you stop it.
2. Have the conversation you want to trace.
3. Send `/trace_end`. You will get a reply like:

   ```
   Trace complete — 5 turn(s) captured.

   **XML trace:** /home/botuser/.openclaw/traces/20260430-abc123def456.xml
   **Viewer HTML:** /home/botuser/.openclaw/traces/20260430-abc123def456.viewer.html
   ```

4. Open the `.viewer.html` file in any browser on the gateway machine (double-click or use a `file://` URL). With the default `viewer.inlineXml: true`, the XML is embedded inside the HTML, so the viewer works without any fetch — you can copy both files anywhere and the viewer still renders.

Use `/trace_status` at any point to check that capture is still active and to see how large the trace has grown.

## Output location

Traces are written to `~/.openclaw/traces/` by default. Each trace produces two files in that directory:

- `<traceId>.xml` — the trace data
- `<traceId>.viewer.html` — a self-contained HTML viewer

If the gateway crashes mid-trace, a `<traceId>.partial.xml` file is left behind and recovered automatically on the next gateway start.

## Configuration

All options have defaults; you only need to set the ones you want to change. Add an entry under `plugins.entries` in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["prompt-tracer"],
    "entries": {
      "prompt-tracer": {
        "enabled": true,
        "config": {
          "tracesDir": "~/.openclaw/traces",
          "maxBytesPerPrompt": 262144,
          "captureImages": true,
          "autoStartChannels": [],
          "viewer": {
            "theme": "dark",
            "inlineXml": true
          }
        }
      }
    }
  }
}
```

| Field               | Type       | Default                 | Purpose                                                                                                   |
| ------------------- | ---------- | ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `enabled`           | boolean    | `true`                  | Master switch. When `false`, commands and hooks are not registered.                                       |
| `tracesDir`         | string     | `~/.openclaw/traces`    | Output directory. Supports `~` expansion.                                                                 |
| `maxBytesPerPrompt` | integer    | `262144` (256 KiB)      | Per-phase byte cap. Larger payloads are replaced with a digest + truncation marker. Range: 1 KiB – 16 MiB. |
| `captureImages`     | boolean    | `true`                  | If `false`, image base64 payloads are omitted, yielding much smaller traces.                              |
| `autoStartChannels` | string[]   | `[]`                    | Channel IDs that begin capturing automatically without requiring `/trace_start`.                         |
| `viewer.theme`      | `"light" \| "dark"` | `"dark"`       | Default theme used by the HTML viewer.                                                                    |
| `viewer.inlineXml`  | boolean    | `true`                  | Embed the XML inside the viewer HTML so it opens via `file://` without fetch.                             |

### Auto-start on specific channels

To avoid typing `/trace_start` every time for a given channel, list its channel id in `autoStartChannels`:

```json
"autoStartChannels": ["telegram:my-debug-channel"]
```

The plugin hooks `before_prompt_build`, and if the session for that channel is not already recording, it starts a trace automatically.

## HTTP surface

The plugin also registers a gateway HTTP prefix at `/plugins/prompt-tracer` (auth: `gateway`). It is used by any future dashboard / control-UI panel that wants to list or stream traces. For CLI and file-system workflows, reading files directly from `tracesDir` is sufficient.

## Troubleshooting

- **`No active trace for this session` when calling `/trace_end`** — the session key is derived from channel + conversation id; switching channels loses the recording handle. Start a new trace in the same channel/session.
- **Trace files look truncated** — individual phases over `maxBytesPerPrompt` are intentionally replaced with a digest. Raise the cap if you need the full payload.
- **Viewer shows "no data"** — if you explicitly set `viewer.inlineXml: false`, the viewer will try to `fetch()` the sibling `.xml`, which browsers block for `file://` origins. Either set `inlineXml` back to `true` or serve the files from a local web server.
- **Partial files on disk** — `*.partial.xml` files are recovered and finalized automatically when the plugin loads; you can also delete them manually if you no longer need that trace.
