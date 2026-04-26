import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTraceId, isSafeTraceId, resolveTracesDir } from "./paths.js";

describe("resolveTracesDir", () => {
  it("returns ~/.openclaw/traces when no config", () => {
    const result = resolveTracesDir(undefined);
    expect(result).toBe(path.join(os.homedir(), ".openclaw", "traces"));
  });

  it("expands ~ prefix", () => {
    const result = resolveTracesDir("~/my-traces");
    expect(result).toBe(path.join(os.homedir(), "my-traces"));
  });

  it("returns absolute path unchanged if already absolute", () => {
    const result = resolveTracesDir("/tmp/traces");
    expect(result).toBe("/tmp/traces");
  });
});

describe("buildTraceId", () => {
  it("starts with date part", () => {
    const id = buildTraceId("feishu:conv1", "2026-04-25T10:00:00Z");
    expect(id).toMatch(/^20260425-/);
  });

  it("is deterministic for same inputs", () => {
    const id1 = buildTraceId("feishu:conv1", "2026-04-25T10:00:00Z");
    const id2 = buildTraceId("feishu:conv1", "2026-04-25T10:00:00Z");
    expect(id1).toBe(id2);
  });

  it("differs for different session keys", () => {
    const id1 = buildTraceId("feishu:conv1", "2026-04-25T10:00:00Z");
    const id2 = buildTraceId("feishu:conv2", "2026-04-25T10:00:00Z");
    expect(id1).not.toBe(id2);
  });
});

describe("isSafeTraceId", () => {
  it("accepts normal trace ids", () => {
    expect(isSafeTraceId("20260425-abc123def456")).toBe(true);
  });

  it("rejects path traversal", () => {
    expect(isSafeTraceId("../etc/passwd")).toBe(false);
    expect(isSafeTraceId("../../secret")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSafeTraceId("")).toBe(false);
  });

  it("rejects strings with slashes", () => {
    expect(isSafeTraceId("a/b")).toBe(false);
    expect(isSafeTraceId("a\\b")).toBe(false);
  });
});
