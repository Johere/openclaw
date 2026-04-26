import type { PluginCommandContext } from "../api.js";
import type { TraceManager } from "./manager.js";

export type CommandDeps = {
  manager: TraceManager;
};

function sessionKeyFromCtx(ctx: PluginCommandContext): string {
  if (ctx.sessionKey) { return ctx.sessionKey; }
  // Fallback: synthesize from channel + conversationId.
  const conversationId =
    (ctx as Record<string, unknown>).conversationId ?? ctx.from ?? "unknown";
  return `${ctx.channel}:${conversationId}`;
}

export function handleTraceStart(deps: CommandDeps) {
  return async (ctx: PluginCommandContext) => {
    const sessionKey = sessionKeyFromCtx(ctx);
    if (deps.manager.isRecording(sessionKey)) {
      const session = deps.manager.getSession(sessionKey);
      return {
        text: `Already recording trace \`${session?.traceId}\`. Send \`/trace_end\` to finish.`,
      };
    }

    const traceId = deps.manager.start(
      sessionKey,
      ctx.channel,
      ctx.sessionId,
    );
    return {
      text: `Prompt trace started. Trace ID: \`${traceId}\`\nCapturing all subsequent turns in this session. Send \`/trace_end\` when done.`,
    };
  };
}

export function handleTraceEnd(deps: CommandDeps) {
  return async (ctx: PluginCommandContext) => {
    const sessionKey = sessionKeyFromCtx(ctx);
    if (!deps.manager.isRecording(sessionKey)) {
      return {
        text: `No active trace for this session. Start one with \`/trace_start\`.`,
      };
    }

    const result = await deps.manager.stop(sessionKey);
    if (!result) {
      return {
        text: `Failed to flush trace. Please check gateway logs.`,
        isError: true,
      };
    }

    const lines = [
      `Trace complete — ${result.turnCount} turn(s) captured.`,
      ``,
      `**XML trace:** \`${result.xmlPath}\``,
      `**Viewer HTML:** \`${result.viewerPath}\``,
      ``,
      `Open the viewer HTML in a browser (double-click on the gateway machine) to explore the trace.`,
    ];
    return { text: lines.join("\n") };
  };
}

export function handleTraceStatus(deps: CommandDeps) {
  return async (ctx: PluginCommandContext) => {
    const sessionKey = sessionKeyFromCtx(ctx);
    const session = deps.manager.getSession(sessionKey);
    if (!session || session.status !== "recording") {
      return { text: `No active trace. Use \`/trace_start\` to begin capturing.` };
    }

    const turnCount = session.turns.length + (session.activeTurn ? 1 : 0);
    const phaseCount =
      session.turns.reduce((sum, t) => sum + t.phases.length, 0) +
      (session.activeTurn?.phases.length ?? 0);
    const mb = (session.estimatedBytes / 1024 / 1024).toFixed(1);

    const lines = [
      `Trace \`${session.traceId}\` is recording.`,
      `Channel: ${session.channel ?? "unknown"}`,
      `Started: ${session.startedAt}`,
      `Turns: ${turnCount}, Phases: ${phaseCount}`,
      `Estimated size: ${mb} MB`,
    ];
    return { text: lines.join("\n") };
  };
}
