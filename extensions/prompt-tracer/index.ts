import { definePluginEntry } from "./api.js";
import { promptTracerPluginConfigSchema } from "./src/config.js";
import { registerPromptTracerPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "prompt-tracer",
  name: "Prompt Tracer",
  description:
    "Capture full-chain LLM prompt traces (system prompt, LLM input, wire body, tool calls, assistant reply) to XML and view them in a self-contained HTML viewer.",
  configSchema: promptTracerPluginConfigSchema,
  register: registerPromptTracerPlugin,
});
