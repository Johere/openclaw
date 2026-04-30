import type { OpenClawPluginApi } from "../api.js";
import type { TraceManager } from "./manager.js";
import type {
  PhaseBeforePromptBuild,
  PhaseLlmInput,
  PhaseLlmOutput,
  PhaseMessageWrite,
  PhaseToolCall,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

/** Extract a short content preview from an agent message for message_write phase. */
function contentPreview(message: unknown): string {
  if (!message || typeof message !== "object") { return ""; }
  const m = message as Record<string, unknown>;
  if (typeof m.content === "string") { return m.content.slice(0, 200); }
  if (Array.isArray(m.content)) {
    const texts = m.content
      .filter((c): c is { type: string; text: string } => typeof (c as Record<string, unknown>).text === "string")
      .map((c) => c.text)
      .join(" ");
    return texts.slice(0, 200);
  }
  return "";
}

/**
 * Wire all plugin hooks to the TraceManager.
 * All handlers are pure side-effects on the manager — no return values modify agent behavior.
 */
export function registerRecorderHooks(api: OpenClawPluginApi, manager: TraceManager): void {
  // before_prompt_build: open a new turn + capture prompt/messages
  api.on("before_prompt_build", (event, context) => {
    const sessionKey = context?.sessionKey;
    if (!sessionKey || !manager.isRecording(sessionKey)) { return; }

    manager.openTurn(sessionKey);

    const phase: PhaseBeforePromptBuild = {
      kind: "before_prompt_build",
      at: nowIso(),
      prompt: event.prompt,
      messages: event.messages as unknown[],
    };
    manager.appendPhase(sessionKey, phase);
  });

  // llm_input: capture final assembled prompt heading to LLM
  api.on("llm_input", (event, context) => {
    const sessionKey = context?.sessionKey;
    if (!sessionKey || !manager.isRecording(sessionKey)) { return; }

    manager.updateMeta(sessionKey, {
      provider: event.provider,
      model: event.model,
    });

    const phase: PhaseLlmInput = {
      kind: "llm_input",
      at: nowIso(),
      runId: event.runId,
      sessionId: event.sessionId,
      provider: event.provider,
      model: event.model,
      systemPrompt: event.systemPrompt,
      prompt: event.prompt,
      historyMessages: event.historyMessages as unknown[],
      imagesCount: event.imagesCount,
    };
    manager.appendPhase(sessionKey, phase);
  });

  // before_tool_call: start a tool_call phase (result appended in after_tool_call)
  api.on("before_tool_call", (event, context) => {
    const sessionKey = context?.sessionKey;
    if (!sessionKey || !manager.isRecording(sessionKey)) { return; }

    const at = nowIso();
    const phase: PhaseToolCall = {
      kind: "tool_call",
      at,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      runId: event.runId,
      params: event.params,
    };
    manager.appendPhase(sessionKey, phase);
    manager.recordToolObservation(sessionKey, event.toolName, event.params, at);
  });

  // after_tool_call: backfill result/error/duration into matching tool_call phase
  api.on("after_tool_call", (event, context) => {
    const sessionKey = context?.sessionKey;
    if (!sessionKey || !manager.isRecording(sessionKey)) { return; }

    const session = manager.getSession(sessionKey);
    if (!session) { return; }

    const target = session.activeTurn?.phases ?? (session.turns[session.turns.length - 1]?.phases ?? []);
    // Backfill the most recent tool_call phase matching toolName + toolCallId.
    for (let i = target.length - 1; i >= 0; i--) {
      const p = target[i];
      if (
        p.kind === "tool_call" &&
        p.toolName === event.toolName &&
        p.toolCallId === event.toolCallId
      ) {
        p.result = event.result;
        p.error = event.error;
        p.durationMs = event.durationMs;
        break;
      }
    }
  });

  // llm_output: capture final assistant response + token usage
  api.on("llm_output", (event, context) => {
    const sessionKey = context?.sessionKey;
    if (!sessionKey || !manager.isRecording(sessionKey)) { return; }

    const phase: PhaseLlmOutput = {
      kind: "llm_output",
      at: nowIso(),
      runId: event.runId,
      sessionId: event.sessionId,
      provider: event.provider,
      model: event.model,
      assistantTexts: event.assistantTexts,
      usage: event.usage,
    };
    manager.appendPhase(sessionKey, phase);
  });

  // before_message_write: synchronous — push only, no async
  api.on("before_message_write", (event, context) => {
    const sessionKey = context?.sessionKey ?? event.sessionKey;
    if (!sessionKey || !manager.isRecording(sessionKey)) { return; }

    const msg = event.message as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const phase: PhaseMessageWrite = {
      kind: "message_write",
      at: nowIso(),
      role,
      contentPreview: contentPreview(event.message),
    };
    manager.appendPhase(sessionKey, phase);
  });

  // session_end: best-effort flush active trace when session ends
  api.on("session_end", async (_event, context) => {
    const sessionKey = context?.sessionKey;
    if (!sessionKey || !manager.isRecording(sessionKey)) { return; }
    await manager.checkpoint(sessionKey).catch(() => undefined);
  });
}
