import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const DEFAULT_TRACES_DIR = path.join(os.homedir(), ".openclaw", "traces");

/** Expand ~ and make the path absolute. */
export function resolveTracesDir(configured?: string): string {
  if (!configured) {
    return DEFAULT_TRACES_DIR;
  }
  if (configured.startsWith("~/") || configured === "~") {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

/** Generate a stable trace id from a sessionKey + ISO start timestamp. */
export function buildTraceId(sessionKey: string, startedAt: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(`${sessionKey}\x00${startedAt}`)
    .digest("hex")
    .slice(0, 12);
  const datePart = startedAt.slice(0, 10).replace(/-/g, "");
  return `${datePart}-${hash}`;
}

/** Resolve the XML output path for a trace. */
export function resolveTraceXmlPath(tracesDir: string, traceId: string): string {
  return path.join(tracesDir, `${traceId}.xml`);
}

/** Resolve the HTML viewer path for a trace. */
export function resolveTraceViewerPath(tracesDir: string, traceId: string): string {
  return path.join(tracesDir, `${traceId}.viewer.html`);
}

/** Resolve the partial/in-progress XML path (used during checkpointing). */
export function resolveTracePartialPath(tracesDir: string, traceId: string): string {
  return path.join(tracesDir, `${traceId}.partial.xml`);
}

const SAFE_PATH_RE = /^[a-zA-Z0-9_\-.]+$/;

/** Guard against path traversal in user-supplied trace IDs. */
export function isSafeTraceId(id: string): boolean {
  return SAFE_PATH_RE.test(id) && !id.includes("..") && id.length > 0 && id.length <= 80;
}
