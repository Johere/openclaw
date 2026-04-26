import type { IncomingMessage, ServerResponse } from "node:http";
import type { TraceManager } from "./manager.js";
import { buildViewerHtml } from "./viewer-assets.js";
import { isSafeTraceId, resolveTraceXmlPath } from "./paths.js";
import type { PromptTracerConfig } from "./config.js";

const ROUTE_PREFIX = "/plugins/prompt-tracer";
const XML_PREFIX = `${ROUTE_PREFIX}/traces/`;
const VIEWER_PREFIX = `${ROUTE_PREFIX}/viewer/`;

function respondText(res: ServerResponse, status: number, body: string): boolean {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
  return true;
}

function respondXml(res: ServerResponse, body: string): boolean {
  res.statusCode = 200;
  res.setHeader("content-type", "application/xml; charset=utf-8");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
  return true;
}

function respondHtml(res: ServerResponse, body: string): boolean {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader(
    "content-security-policy",
    [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data:",
      "connect-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
  res.end(body);
  return true;
}

export function createPromptTracerHttpHandler(params: {
  manager: TraceManager;
  config: PromptTracerConfig;
}) {
  const { manager, config } = params;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = req.url ?? "";
    const pathname = url.split("?")[0] ?? "";

    if (!pathname.startsWith(ROUTE_PREFIX)) {
      return false;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return respondText(res, 405, "Method Not Allowed");
    }

    // GET /plugins/prompt-tracer/traces/:id.xml
    if (pathname.startsWith(XML_PREFIX)) {
      const rest = pathname.slice(XML_PREFIX.length);
      const traceId = rest.endsWith(".xml") ? rest.slice(0, -4) : rest;
      if (!isSafeTraceId(traceId)) {
        return respondText(res, 404, "Trace not found");
      }
      const xml = await manager.readXml(traceId);
      if (!xml) {
        return respondText(res, 404, "Trace not found");
      }
      return respondXml(res, xml);
    }

    // GET /plugins/prompt-tracer/viewer/:id
    if (pathname.startsWith(VIEWER_PREFIX)) {
      const traceId = pathname.slice(VIEWER_PREFIX.length);
      if (!isSafeTraceId(traceId)) {
        return respondText(res, 404, "Trace not found");
      }
      const xml = await manager.readXml(traceId);
      if (!xml) {
        return respondText(res, 404, "Trace not found");
      }
      const html = buildViewerHtml({
        xml: config.viewer.inlineXml ? xml : undefined,
        xmlPath: config.viewer.inlineXml
          ? undefined
          : resolveTraceXmlPath(config.tracesDir, traceId),
        theme: config.viewer.theme,
        traceId,
      });
      return respondHtml(res, html);
    }

    return false;
  };
}
