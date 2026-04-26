import { VIEWER_CLIENT_SCRIPT } from "./viewer-client.js";

export type BuildViewerHtmlParams = {
  xml?: string;
  xmlPath?: string;
  theme: "light" | "dark";
  traceId: string;
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeScriptContent(str: string): string {
  // Prevent </script> from closing the tag early.
  return str.replace(/<\/(script)/gi, "<\\/$1");
}

export function buildViewerHtml(params: BuildViewerHtmlParams): string {
  const { xml, xmlPath, theme, traceId } = params;

  const isDark = theme === "dark";
  const bg = isDark ? "#0d1117" : "#ffffff";
  const surfaceBg = isDark ? "#0f172a" : "#f8fafc";
  const panelBg = isDark ? "#1e293b" : "#f1f5f9";
  const textColor = isDark ? "#e2e8f0" : "#1e293b";
  const mutedColor = isDark ? "#64748b" : "#94a3b8";
  const drawerBg = isDark ? "#111827" : "#ffffff";
  const drawerBorder = isDark ? "#1f2937" : "#e2e8f0";
  const codeBg = isDark ? "#0d1117" : "#f8fafc";
  const codeBorder = isDark ? "#21262d" : "#d1d5db";

  const xmlDataSection = xml
    ? `<script id="pt-xml-data" type="application/xml">${escapeScriptContent(xml)}</script>`
    : "";

  const xmlUrlAttr = xmlPath ? ` data-xml-url="/plugins/prompt-tracer/traces/${encodeURIComponent(traceId)}.xml"` : "";

  const css = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: ${bg}; color: ${textColor}; font-family: 'Segoe UI', system-ui, sans-serif; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
    #pt-topbar { background: ${panelBg}; border-bottom: 1px solid ${isDark ? "#1e293b" : "#e2e8f0"}; padding: 10px 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
    #pt-topbar h1 { font-size: 14px; font-weight: 600; color: ${textColor}; }
    #pt-header-info { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; font-size: 12px; color: ${mutedColor}; }
    #pt-body { display: flex; flex: 1; overflow: hidden; }
    #pt-sidebar { width: 120px; flex-shrink: 0; overflow-y: auto; background: ${surfaceBg}; border-right: 1px solid ${isDark ? "#1e293b" : "#e2e8f0"}; padding: 10px 6px; }
    #pt-main { flex: 1; overflow: auto; padding: 20px 24px; }
    #pt-canvas { display: flex; flex-direction: column; gap: 4px; }
    .pt-turn { display: flex; align-items: center; }
    .pt-node { position: relative; }

    /* Drawer overlay */
    #pt-drawer-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100; }
    #pt-drawer { display: none; position: fixed; right: 0; top: 0; bottom: 0; width: min(600px, 90vw); background: ${drawerBg}; border-left: 1px solid ${drawerBorder}; flex-direction: column; z-index: 101; box-shadow: -8px 0 32px rgba(0,0,0,0.5); }
    #pt-drawer-header { padding: 14px 16px; border-bottom: 1px solid ${drawerBorder}; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
    #pt-drawer-title { font-size: 13px; font-weight: 600; }
    #pt-drawer-close { background: none; border: none; color: ${mutedColor}; cursor: pointer; font-size: 18px; padding: 2px 6px; border-radius: 4px; }
    #pt-drawer-close:hover { background: ${isDark ? "#1f2937" : "#f1f5f9"}; }
    #pt-drawer-scroll { flex: 1; overflow-y: auto; padding: 14px 16px; }
    #pt-drawer-body { font-family: 'Fira Code', 'Cascadia Code', 'SF Mono', monospace; font-size: 12px; white-space: pre-wrap; word-break: break-all; background: ${codeBg}; border: 1px solid ${codeBorder}; border-radius: 8px; padding: 14px; color: ${textColor}; line-height: 1.6; min-height: 100%; }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prompt Trace — ${escapeHtml(traceId)}</title>
<style>${css}</style>
</head>
<body>
<div id="pt-root" data-theme="${theme}"${xmlUrlAttr}>
  <div id="pt-topbar">
    <h1>Prompt Tracer</h1>
    <div id="pt-header-info"></div>
  </div>
  <div id="pt-body">
    <div id="pt-sidebar"></div>
    <div id="pt-main">
      <div id="pt-canvas">Loading trace…</div>
    </div>
  </div>
</div>

<div id="pt-drawer-overlay"></div>
<div id="pt-drawer" role="dialog" aria-modal="true">
  <div id="pt-drawer-header">
    <span id="pt-drawer-title"></span>
    <button id="pt-drawer-close" title="Close (Esc)">✕</button>
  </div>
  <div id="pt-drawer-scroll">
    <pre id="pt-drawer-body"></pre>
  </div>
</div>

${xmlDataSection}
<script>${escapeScriptContent(VIEWER_CLIENT_SCRIPT)}</script>
</body>
</html>`;
}
