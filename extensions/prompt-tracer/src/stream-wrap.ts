import crypto from "node:crypto";
import type { ProviderWrapStreamFnContext } from "../api.js";
import type { TraceManager } from "./manager.js";
import type { PhaseWireBody } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[non-serializable]";
  }
}

function sha256(text: string): string {
  return "sha256:" + crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Returns a wrapStreamFn handler to pass to api.registerProvider.
 * Intercepts onPayload to capture the wire body for any session that is recording.
 *
 * Usage:
 *   api.on("before_prompt_build", ...) to know which sessionKey is active, then
 *   the provider that calls wrapStreamFn passes us the context including sessionKey.
 *
 * Note: wrapStreamFn runs at the provider level; context.workspaceDir or the
 * sessionKey may not always be available depending on the provider plugin.
 * We fall back to capturing all recording sessions when sessionKey is absent.
 */
export function createWrapStreamFn(manager: TraceManager, maxBytesPerPrompt: number) {
  return (ctx: ProviderWrapStreamFnContext) => {
    const underlying = ctx.streamFn;
    if (!underlying) { return undefined; }

    return (
      model: Parameters<typeof underlying>[0],
      context: Parameters<typeof underlying>[1],
      options: Parameters<typeof underlying>[2],
    ) => {
      const originalOnPayload = options?.onPayload;

      // Try to find a recording session to attach this wire body to.
      // Prefer workspaceDir or sessionKey from context if available.
      const ctxAny = context as Record<string, unknown> | undefined;
      const sessionKey =
        typeof ctxAny?.sessionKey === "string"
          ? ctxAny.sessionKey
          : undefined;

      return underlying(model, context, {
        ...options,
        onPayload: (payload: unknown, m?: unknown) => {
          const targetKeys = sessionKey
            ? [sessionKey]
            : manager.getAll().filter((s) => s.status === "recording").map((s) => s.sessionKey);

          for (const key of targetKeys) {
            if (!manager.isRecording(key)) { continue; }
            const bodyText = safeJson(payload);
            const bytes = Buffer.byteLength(bodyText, "utf8");
            const truncated = bytes > maxBytesPerPrompt;
            const displayBody = truncated
              ? Buffer.from(bodyText, "utf8").slice(0, maxBytesPerPrompt).toString("utf8")
              : bodyText;

            const phase: PhaseWireBody = {
              kind: "wire_body",
              at: nowIso(),
              body: displayBody,
              truncated,
              originalBytes: truncated ? bytes : undefined,
              digest: sha256(bodyText),
            };
            manager.appendPhase(key, phase);
          }

          return originalOnPayload?.(payload, m as Parameters<typeof underlying>[0]);
        },
      });
    };
  };
}
