import { describe, expect, it } from "vitest";
import type { TraceSession } from "./types.js";
import { serializeTraceToXml } from "./xml.js";

const OPTS = { maxBytesPerPrompt: 1024 };

function makeSession(overrides?: Partial<TraceSession>): TraceSession {
  return {
    status: "idle",
    traceId: "20260425-abc123def456",
    sessionKey: "feishu:conv1",
    sessionId: "sess-001",
    channel: "feishu",
    startedAt: "2026-04-25T10:00:00Z",
    endedAt: "2026-04-25T10:05:00Z",
    turns: [],
    meta: { provider: "anthropic", model: "claude-opus-4-7", channel: "feishu" },
    estimatedBytes: 0,
    activeTurn: null,
    observedTools: new Map(),
    ...overrides,
  };
}

describe("serializeTraceToXml", () => {
  it("produces valid XML declaration + root element", () => {
    const xml = serializeTraceToXml(makeSession(), OPTS);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<trace schema="1"');
    expect(xml).toContain('</trace>');
  });

  it("includes session attributes", () => {
    const xml = serializeTraceToXml(makeSession(), OPTS);
    expect(xml).toContain('traceId="20260425-abc123def456"');
    expect(xml).toContain('channel="feishu"');
    expect(xml).toContain('startedAt="2026-04-25T10:00:00Z"');
  });

  it("serializes a before_prompt_build phase", () => {
    const session = makeSession({
      turns: [
        {
          index: 0,
          startedAt: "2026-04-25T10:00:01Z",
          phases: [
            {
              kind: "before_prompt_build",
              at: "2026-04-25T10:00:01Z",
              prompt: "hi there",
              messages: [{ role: "user", content: "hi" }],
            },
          ],
        },
      ],
    });
    const xml = serializeTraceToXml(session, OPTS);
    expect(xml).toContain('kind="before_prompt_build"');
    expect(xml).toContain("<prompt");
    expect(xml).toContain("hi there");
    expect(xml).toContain("<messages");
  });

  it("serializes a tool_call phase with result", () => {
    const session = makeSession({
      turns: [
        {
          index: 0,
          startedAt: "2026-04-25T10:00:01Z",
          phases: [
            {
              kind: "tool_call",
              at: "2026-04-25T10:00:02Z",
              toolName: "memory_search",
              toolCallId: "tc-001",
              params: { query: "previous project" },
              result: [{ snippet: "...result..." }],
              durationMs: 412,
            },
          ],
        },
      ],
    });
    const xml = serializeTraceToXml(session, OPTS);
    expect(xml).toContain('kind="tool_call"');
    expect(xml).toContain('name="memory_search"');
    expect(xml).toContain("memory_search");
    expect(xml).toContain("<params>");
    expect(xml).toContain("<result>");
    expect(xml).toContain("412");
  });

  it("escapes CDATA delimiters inside content", () => {
    const session = makeSession({
      turns: [
        {
          index: 0,
          startedAt: "2026-04-25T10:00:01Z",
          phases: [
            {
              kind: "before_prompt_build",
              at: "2026-04-25T10:00:01Z",
              prompt: "test ]]> end",
              messages: [],
            },
          ],
        },
      ],
    });
    const xml = serializeTraceToXml(session, OPTS);
    // The raw ]]> sequence should not appear unescaped inside a CDATA section.
    // The correct escape splits it: ]]]]><![CDATA[>
    expect(xml).toContain("]]]]><![CDATA[>");
    // After escaping, the raw CDATA-closing-then-opening sequence shouldn't appear directly.
    expect(xml).not.toMatch(/\]\]>[^<]/);
  });

  it("truncates oversized prompts and marks truncated=true", () => {
    const hugePrompt = "x".repeat(2000);
    const session = makeSession({
      turns: [
        {
          index: 0,
          startedAt: "2026-04-25T10:00:01Z",
          phases: [
            {
              kind: "before_prompt_build",
              at: "2026-04-25T10:00:01Z",
              prompt: hugePrompt,
              messages: [],
            },
          ],
        },
      ],
    });
    const xml = serializeTraceToXml(session, { maxBytesPerPrompt: 100 });
    expect(xml).toContain('truncated="true"');
    expect(xml).toContain('originalBytes="2000"');
  });

  it("attribute ordering is deterministic across multiple calls", () => {
    const session = makeSession();
    const xml1 = serializeTraceToXml(session, OPTS);
    const xml2 = serializeTraceToXml(session, OPTS);
    expect(xml1).toBe(xml2);
  });

  it("serializes observedTools with notice and sorted tools", () => {
    const observedTools = new Map([
      [
        "zed_tool",
        {
          toolName: "zed_tool",
          callCount: 1,
          firstSeenAt: "2026-04-25T10:00:02Z",
          lastSeenAt: "2026-04-25T10:00:02Z",
          paramKeys: ["b", "a"],
        },
      ],
      [
        "memory_search",
        {
          toolName: "memory_search",
          callCount: 3,
          firstSeenAt: "2026-04-25T10:00:01Z",
          lastSeenAt: "2026-04-25T10:00:04Z",
          paramKeys: ["query"],
        },
      ],
    ]);
    const session = makeSession({ observedTools });
    const xml = serializeTraceToXml(session, OPTS);
    expect(xml).toContain('<observedTools count="2">');
    expect(xml).toContain("wire body unavailable");
    expect(xml).toContain('without wrapStreamFn');
    // memory_search sorts before zed_tool
    const memIdx = xml.indexOf('name="memory_search"');
    const zedIdx = xml.indexOf('name="zed_tool"');
    expect(memIdx).toBeGreaterThan(-1);
    expect(zedIdx).toBeGreaterThan(memIdx);
    // paramKeys are sorted
    expect(xml).toContain('paramKeys="a,b"');
    expect(xml).toContain('callCount="3"');
  });

  it("emits observedTools element even when empty", () => {
    const xml = serializeTraceToXml(makeSession(), OPTS);
    expect(xml).toContain('<observedTools count="0">');
    expect(xml).toContain("wire body unavailable");
  });

  it("includes activeTurn phases when present", () => {
    const session = makeSession({
      activeTurn: {
        index: 0,
        startedAt: "2026-04-25T10:00:01Z",
        phases: [
          {
            kind: "llm_output",
            at: "2026-04-25T10:00:03Z",
            runId: "run-001",
            sessionId: "sess-001",
            provider: "anthropic",
            model: "claude-opus-4-7",
            assistantTexts: ["Hello!"],
            usage: { input: 100, output: 20 },
          },
        ],
      },
    });
    const xml = serializeTraceToXml(session, OPTS);
    expect(xml).toContain('kind="llm_output"');
    expect(xml).toContain("Hello!");
  });
});
