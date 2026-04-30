import { describe, expect, it, vi } from "vitest";
import type { PromptTracerConfig } from "./config.js";
import { TraceManager } from "./manager.js";

// Stub out filesystem operations so tests stay in-memory.
vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue("<xml/>"),
    readdir: vi.fn().mockResolvedValue([]),
  },
}));

// Stub viewer builder so it doesn't depend on template.
vi.mock("./viewer-assets.js", () => ({
  buildViewerHtml: vi.fn().mockReturnValue("<html></html>"),
}));

const TEST_CONFIG: PromptTracerConfig = {
  enabled: true,
  tracesDir: "/tmp/traces",
  maxBytesPerPrompt: 262_144,
  captureImages: true,
  autoStartChannels: [],
  viewer: { theme: "dark", inlineXml: true },
};

describe("TraceManager", () => {
  it("starts recording a session", () => {
    const mgr = new TraceManager(TEST_CONFIG);
    const traceId = mgr.start("feishu:conv1", "feishu", "sess-001");
    expect(traceId).toMatch(/^\d{8}-[a-f0-9]+$/);
    expect(mgr.isRecording("feishu:conv1")).toBe(true);
  });

  it("returns existing traceId on duplicate start", () => {
    const mgr = new TraceManager(TEST_CONFIG);
    const id1 = mgr.start("feishu:conv1", "feishu");
    const id2 = mgr.start("feishu:conv1", "feishu");
    expect(id1).toBe(id2);
  });

  it("appendPhase adds to active turn", () => {
    const mgr = new TraceManager(TEST_CONFIG);
    mgr.start("feishu:conv1", "feishu");
    mgr.appendPhase("feishu:conv1", {
      kind: "before_prompt_build",
      at: new Date().toISOString(),
      prompt: "hello",
      messages: [],
    });
    const session = mgr.getSession("feishu:conv1");
    expect(session?.activeTurn?.phases.length).toBe(1);
  });

  it("stop flushes and removes session", async () => {
    const mgr = new TraceManager(TEST_CONFIG);
    mgr.start("feishu:conv1", "feishu");
    mgr.appendPhase("feishu:conv1", {
      kind: "llm_output",
      at: new Date().toISOString(),
      runId: "r1",
      sessionId: "s1",
      provider: "anthropic",
      model: "claude-opus-4-7",
      assistantTexts: ["Hi"],
    });

    const result = await mgr.stop("feishu:conv1");
    expect(result).not.toBeNull();
    expect(result?.xmlPath).toContain(".xml");
    expect(result?.viewerPath).toContain(".viewer.html");
    expect(mgr.isRecording("feishu:conv1")).toBe(false);
  });

  it("stop returns null for non-recording session", async () => {
    const mgr = new TraceManager(TEST_CONFIG);
    const result = await mgr.stop("feishu:nonexistent");
    expect(result).toBeNull();
  });

  it("concurrent sessions are independent", () => {
    const mgr = new TraceManager(TEST_CONFIG);
    const id1 = mgr.start("feishu:conv1", "feishu");
    const id2 = mgr.start("feishu:conv2", "feishu");
    expect(id1).not.toBe(id2);
    expect(mgr.isRecording("feishu:conv1")).toBe(true);
    expect(mgr.isRecording("feishu:conv2")).toBe(true);
  });

  it("updateMeta persists provider/model", () => {
    const mgr = new TraceManager(TEST_CONFIG);
    mgr.start("feishu:conv1", "feishu");
    mgr.updateMeta("feishu:conv1", { provider: "openai", model: "gpt-5.4" });
    const session = mgr.getSession("feishu:conv1");
    expect(session?.meta.provider).toBe("openai");
    expect(session?.meta.model).toBe("gpt-5.4");
  });

  it("openTurn closes previous active turn", () => {
    const mgr = new TraceManager(TEST_CONFIG);
    mgr.start("feishu:conv1", "feishu");
    mgr.appendPhase("feishu:conv1", {
      kind: "before_prompt_build",
      at: new Date().toISOString(),
      prompt: "turn 0",
      messages: [],
    });
    // Open a second turn
    mgr.openTurn("feishu:conv1");
    const session = mgr.getSession("feishu:conv1");
    expect(session?.turns.length).toBe(1);
    expect(session?.activeTurn?.index).toBe(1);
  });

  it("recordToolObservation accumulates callCount and merges paramKeys", () => {
    const mgr = new TraceManager(TEST_CONFIG);
    mgr.start("feishu:conv1", "feishu");
    mgr.recordToolObservation("feishu:conv1", "memory_search", { query: "x" }, "2026-04-26T10:00:00.000Z");
    mgr.recordToolObservation("feishu:conv1", "memory_search", { query: "y", top_k: 3 }, "2026-04-26T10:00:05.000Z");
    const session = mgr.getSession("feishu:conv1");
    const observed = session?.observedTools.get("memory_search");
    expect(observed?.callCount).toBe(2);
    expect(observed?.firstSeenAt).toBe("2026-04-26T10:00:00.000Z");
    expect(observed?.lastSeenAt).toBe("2026-04-26T10:00:05.000Z");
    expect(observed?.paramKeys.toSorted()).toEqual(["query", "top_k"]);
  });

  it("recordToolObservation ignores non-recording sessions", () => {
    const mgr = new TraceManager(TEST_CONFIG);
    mgr.recordToolObservation("feishu:none", "x", {}, "2026-04-26T10:00:00.000Z");
    expect(mgr.getSession("feishu:none")).toBeUndefined();
  });
});
