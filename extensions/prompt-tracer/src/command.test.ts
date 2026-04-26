import { describe, expect, it, vi } from "vitest";
import type { PluginCommandContext } from "../api.js";
import { handleTraceEnd, handleTraceStart, handleTraceStatus } from "./command.js";
import type { TraceManager } from "./manager.js";

function makeCtx(overrides?: Partial<PluginCommandContext>): PluginCommandContext {
  return {
    channel: "feishu",
    channelId: "feishu" as Parameters<PluginCommandContext["requestConversationBinding"]>[0] extends infer _T ? never : never,
    isAuthorizedSender: true,
    commandBody: "/trace_start",
    sessionKey: "feishu:conv1",
    sessionId: "sess-001",
    config: {} as PluginCommandContext["config"],
    requestConversationBinding: vi.fn(),
    detachConversationBinding: vi.fn(),
    getCurrentConversationBinding: vi.fn(),
    ...overrides,
  } as unknown as PluginCommandContext;
}

function makeManager(overrides?: Partial<TraceManager>): TraceManager {
  return {
    isRecording: vi.fn().mockReturnValue(false),
    start: vi.fn().mockReturnValue("20260425-abc123"),
    stop: vi.fn().mockResolvedValue({ xmlPath: "/tmp/t.xml", viewerPath: "/tmp/t.viewer.html", turnCount: 3 }),
    getSession: vi.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as TraceManager;
}

describe("handleTraceStart", () => {
  it("starts recording and returns trace id", async () => {
    const mgr = makeManager();
    const handler = handleTraceStart({ manager: mgr });
    const result = await handler(makeCtx());
    expect(mgr.start).toHaveBeenCalledWith("feishu:conv1", "feishu", "sess-001");
    expect(result.text).toContain("20260425-abc123");
  });

  it("returns 'already recording' if session is active", async () => {
    const mgr = makeManager({
      isRecording: vi.fn().mockReturnValue(true),
      getSession: vi.fn().mockReturnValue({ traceId: "existing-id", status: "recording" }),
    });
    const handler = handleTraceStart({ manager: mgr });
    const result = await handler(makeCtx());
    expect(result.text).toContain("Already recording");
    expect(mgr.start).not.toHaveBeenCalled();
  });
});

describe("handleTraceEnd", () => {
  it("stops recording and returns file paths", async () => {
    const mgr = makeManager({ isRecording: vi.fn().mockReturnValue(true) });
    const handler = handleTraceEnd({ manager: mgr });
    const result = await handler(makeCtx());
    expect(result.text).toContain("/tmp/t.xml");
    expect(result.text).toContain("/tmp/t.viewer.html");
    expect(result.text).toContain("3 turn");
  });

  it("returns error when no trace is active", async () => {
    const mgr = makeManager();
    const handler = handleTraceEnd({ manager: mgr });
    const result = await handler(makeCtx());
    expect(result.text).toContain("No active trace");
  });
});

describe("handleTraceStatus", () => {
  it("shows recording stats", async () => {
    const session = {
      traceId: "20260425-abc123",
      status: "recording",
      channel: "feishu",
      startedAt: "2026-04-25T10:00:00Z",
      turns: [{ phases: [{}] }],
      activeTurn: { phases: [{}] },
      estimatedBytes: 1024 * 512,
    };
    const mgr = makeManager({
      getSession: vi.fn().mockReturnValue(session),
    });
    const handler = handleTraceStatus({ manager: mgr });
    const result = await handler(makeCtx());
    expect(result.text).toContain("20260425-abc123");
    expect(result.text).toContain("recording");
  });

  it("returns no-trace message when idle", async () => {
    const mgr = makeManager();
    const handler = handleTraceStatus({ manager: mgr });
    const result = await handler(makeCtx());
    expect(result.text).toContain("No active trace");
  });
});
