import type { OpenClawPluginApi } from "../api.js";
import { resolvePromptTracerConfig } from "./config.js";
import { handleTraceEnd, handleTraceStart, handleTraceStatus } from "./command.js";
import { createPromptTracerHttpHandler } from "./http.js";
import { TraceManager } from "./manager.js";
import { registerRecorderHooks } from "./recorder.js";
import { createWrapStreamFn } from "./stream-wrap.js";

export function registerPromptTracerPlugin(api: OpenClawPluginApi): void {
  const config = resolvePromptTracerConfig(api.pluginConfig);

  if (!config.enabled) {
    return;
  }

  const manager = new TraceManager(config);

  // Recover crashed partial files from a previous gateway run (best-effort).
  void TraceManager.recoverCrashed(config.tracesDir);

  // Register hook listeners.
  registerRecorderHooks(api, manager);

  // Wire provider stream wrapper for wire_body capture.
  if (config.captureWireBody) {
    const wrapFn = createWrapStreamFn(manager, config.maxBytesPerPrompt);
    api.on("before_prompt_build", (_event, context) => {
      // When a recording session receives a turn, ensure wrapStreamFn is in place.
      // The actual wrap is injected via the provider registration hook below.
      void context;
    });

    // Register a provider hook to inject our wire-body capture into the stream chain.
    api.registerProvider({
      id: "__prompt-tracer-wire-capture__",
      name: "Prompt Tracer Wire Capture",
      register: () => undefined,
      // wrapStreamFn is called by core when the active provider builds its request.
      wrapStreamFn: wrapFn,
    } as Parameters<OpenClawPluginApi["registerProvider"]>[0]);
  }

  // Auto-start for configured channels.
  if (config.autoStartChannels.length > 0) {
    api.on("before_prompt_build", (_event, context) => {
      const sessionKey = context?.sessionKey;
      const channelId = context?.channelId;
      if (!sessionKey || !channelId) { return; }
      if (config.autoStartChannels.includes(channelId) && !manager.isRecording(sessionKey)) {
        manager.start(sessionKey, channelId, context?.sessionId);
      }
    });
  }

  // Register commands.
  const cmdDeps = { manager };
  api.registerCommand({
    name: "trace_start",
    nativeNames: { default: "trace_start" },
    description: "Start capturing a full-chain prompt trace for this session.",
    handler: handleTraceStart(cmdDeps),
  });
  api.registerCommand({
    name: "trace_end",
    nativeNames: { default: "trace_end" },
    description: "Stop capturing and save the trace to XML + HTML viewer.",
    handler: handleTraceEnd(cmdDeps),
  });
  api.registerCommand({
    name: "trace_status",
    nativeNames: { default: "trace_status" },
    description: "Show the current trace recording status.",
    handler: handleTraceStatus(cmdDeps),
  });

  // Register HTTP routes for serving traces.
  api.registerHttpRoute({
    path: "/plugins/prompt-tracer",
    auth: "gateway",
    match: "prefix",
    handler: createPromptTracerHttpHandler({ manager, config }),
  });

  // Best-effort flush on shutdown.
  api.registerService({
    id: "prompt-tracer-cleanup",
    start: () => {
      const flush = () => {
        void manager.flushAll();
      };
      process.once("beforeExit", flush);
      process.once("SIGINT", flush);
      process.once("SIGTERM", flush);
    },
  });
}
