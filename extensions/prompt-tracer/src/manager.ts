import fs from "node:fs/promises";
import path from "node:path";
import type { PromptTracerConfig } from "./config.js";
import {
  buildTraceId,
  resolveTracePartialPath,
  resolveTraceViewerPath,
  resolveTraceXmlPath,
} from "./paths.js";
import type { PhaseRecord, TraceSession } from "./types.js";
import { buildViewerHtml } from "./viewer-assets.js";
import { serializeTraceToXml } from "./xml.js";

/** Checkpoint after this many accumulated bytes to avoid memory explosion. */
const CHECKPOINT_BYTES = 50 * 1024 * 1024; // 50 MB

export type FlushResult = {
  xmlPath: string;
  viewerPath: string;
  turnCount: number;
};

function estimateBytes(phase: PhaseRecord): number {
  try {
    return Buffer.byteLength(JSON.stringify(phase), "utf8");
  } catch {
    return 512;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export class TraceManager {
  private sessions = new Map<string, TraceSession>();
  private config: PromptTracerConfig;

  constructor(config: PromptTracerConfig) {
    this.config = config;
  }

  updateConfig(config: PromptTracerConfig): void {
    this.config = config;
  }

  start(sessionKey: string, channel?: string, sessionId?: string): string {
    const existing = this.sessions.get(sessionKey);
    if (existing && existing.status === "recording") {
      return existing.traceId;
    }

    const startedAt = nowIso();
    const traceId = buildTraceId(sessionKey, startedAt);
    const session: TraceSession = {
      status: "recording",
      traceId,
      sessionKey,
      sessionId,
      channel,
      startedAt,
      turns: [],
      meta: { channel },
      estimatedBytes: 0,
      activeTurn: null,
    };
    this.sessions.set(sessionKey, session);
    return traceId;
  }

  isRecording(sessionKey: string): boolean {
    const s = this.sessions.get(sessionKey);
    return s?.status === "recording";
  }

  getSession(sessionKey: string): TraceSession | undefined {
    return this.sessions.get(sessionKey);
  }

  getAll(): TraceSession[] {
    return Array.from(this.sessions.values());
  }

  /** Open a new turn for the session (closes any lingering active turn first). */
  openTurn(sessionKey: string): void {
    const s = this.sessions.get(sessionKey);
    if (!s || s.status !== "recording") { return; }
    if (s.activeTurn && s.activeTurn.phases.length > 0) {
      this.closeTurn(s);
    }
    s.activeTurn = {
      index: s.turns.length,
      startedAt: nowIso(),
      phases: [],
    };
  }

  /** Close the active turn and push it to completed turns. */
  private closeTurn(session: TraceSession): void {
    if (!session.activeTurn) { return; }
    const t = session.activeTurn;
    t.endedAt = nowIso();
    if (t.startedAt) {
      t.durationMs = new Date(t.endedAt).getTime() - new Date(t.startedAt).getTime();
    }
    session.turns.push(t);
    session.activeTurn = null;
  }

  appendPhase(sessionKey: string, phase: PhaseRecord): void {
    const s = this.sessions.get(sessionKey);
    if (!s || s.status !== "recording") { return; }
    if (!s.activeTurn) {
      s.activeTurn = {
        index: s.turns.length,
        startedAt: nowIso(),
        phases: [],
      };
    }
    s.activeTurn.phases.push(phase);
    s.estimatedBytes += estimateBytes(phase);

    // Checkpoint if memory is getting large.
    if (s.estimatedBytes >= CHECKPOINT_BYTES) {
      void this.checkpoint(sessionKey);
    }
  }

  /** Update session metadata (provider/model discovered from hooks). */
  updateMeta(sessionKey: string, meta: Partial<TraceSession["meta"]>): void {
    const s = this.sessions.get(sessionKey);
    if (!s) { return; }
    Object.assign(s.meta, meta);
  }

  /** Write a .partial.xml checkpoint without stopping recording. */
  async checkpoint(sessionKey: string): Promise<void> {
    const s = this.sessions.get(sessionKey);
    if (!s) { return; }
    const tracesDir = this.config.tracesDir;
    await fs.mkdir(tracesDir, { recursive: true, mode: 0o700 });
    const xml = serializeTraceToXml(s, { maxBytesPerPrompt: this.config.maxBytesPerPrompt });
    const partialPath = resolveTracePartialPath(tracesDir, s.traceId);
    await fs.writeFile(partialPath, xml, "utf8");
    s.estimatedBytes = 0;
  }

  /** Stop recording, flush to .xml + viewer HTML, return paths. */
  async stop(sessionKey: string): Promise<FlushResult | null> {
    const s = this.sessions.get(sessionKey);
    if (!s || s.status !== "recording") { return null; }
    s.status = "flushing";
    if (s.activeTurn && s.activeTurn.phases.length > 0) {
      this.closeTurn(s);
    }
    s.endedAt = nowIso();

    const tracesDir = this.config.tracesDir;
    await fs.mkdir(tracesDir, { recursive: true, mode: 0o700 });

    const xml = serializeTraceToXml(s, { maxBytesPerPrompt: this.config.maxBytesPerPrompt });
    const xmlPath = resolveTraceXmlPath(tracesDir, s.traceId);
    await fs.writeFile(xmlPath, xml, "utf8");

    const viewerHtml = buildViewerHtml({
      xml: this.config.viewer.inlineXml ? xml : undefined,
      xmlPath: this.config.viewer.inlineXml ? undefined : xmlPath,
      theme: this.config.viewer.theme,
      traceId: s.traceId,
    });
    const viewerPath = resolveTraceViewerPath(tracesDir, s.traceId);
    await fs.writeFile(viewerPath, viewerHtml, "utf8");

    // Clean up partial checkpoint if it exists.
    const partialPath = resolveTracePartialPath(tracesDir, s.traceId);
    await fs.rm(partialPath, { force: true });

    s.status = "idle";
    this.sessions.delete(sessionKey);

    return {
      xmlPath,
      viewerPath,
      turnCount: s.turns.length,
    };
  }

  /** Read XML from disk for a finished trace by traceId. */
  async readXml(traceId: string): Promise<string | null> {
    const xmlPath = resolveTraceXmlPath(this.config.tracesDir, traceId);
    try {
      return await fs.readFile(xmlPath, "utf8");
    } catch {
      return null;
    }
  }

  /** Best-effort flush all active sessions (used on process exit). */
  async flushAll(): Promise<void> {
    const keys = Array.from(this.sessions.keys());
    await Promise.allSettled(keys.map((k) => this.checkpoint(k)));
  }

  /** Rename any leftover .partial.xml files from a previous crashed run. */
  static async recoverCrashed(tracesDir: string): Promise<void> {
    try {
      const entries = await fs.readdir(tracesDir);
      for (const name of entries) {
        if (name.endsWith(".partial.xml")) {
          const from = path.join(tracesDir, name);
          const to = path.join(tracesDir, name.replace(".partial.xml", ".crashed.xml"));
          await fs.rename(from, to).catch(() => undefined);
        }
      }
    } catch {
      // Directory may not exist yet.
    }
  }
}
