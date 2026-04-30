import crypto from "node:crypto";
import type { ObservedTool, PhaseRecord, TraceMeta, TraceSession, TurnRecord } from "./types.js";

// Escape `]]>` inside CDATA sections.
function escapeCdata(text: string): string {
  return text.replace(/]]>/g, "]]]]><![CDATA[>");
}

// Escape attribute values.
function escAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function attr(name: string, value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null) { return ""; }
  return ` ${name}="${escAttr(String(value))}"`;
}

export type XmlWriteOptions = {
  maxBytesPerPrompt: number;
};

function maybeTruncate(
  text: string,
  maxBytes: number,
): { value: string; truncated: boolean; originalBytes: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { value: text, truncated: false, originalBytes: bytes };
  }
  const truncated = Buffer.from(text, "utf8").slice(0, maxBytes).toString("utf8");
  return { value: truncated, truncated: true, originalBytes: bytes };
}

function sha256(text: string): string {
  return "sha256:" + crypto.createHash("sha256").update(text).digest("hex");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[non-serializable]";
  }
}

function writePhase(phase: PhaseRecord, opts: XmlWriteOptions): string {
  const lines: string[] = [];

  if (phase.kind === "before_prompt_build") {
    lines.push(`    <phase kind="before_prompt_build"${attr("at", phase.at)}>`);
    const promptT = maybeTruncate(phase.prompt, opts.maxBytesPerPrompt);
    const msgsText = safeJson(phase.messages);
    const msgsT = maybeTruncate(msgsText, opts.maxBytesPerPrompt);
    lines.push(
      `      <prompt${attr("truncated", promptT.truncated || undefined)}${attr("originalBytes", promptT.truncated ? promptT.originalBytes : undefined)}${attr("digest", sha256(phase.prompt))}><![CDATA[${escapeCdata(promptT.value)}]]></prompt>`,
    );
    lines.push(
      `      <messages count="${phase.messages.length}"${attr("truncated", msgsT.truncated || undefined)}${attr("originalBytes", msgsT.truncated ? msgsT.originalBytes : undefined)}><![CDATA[${escapeCdata(msgsT.value)}]]></messages>`,
    );
    lines.push(`    </phase>`);
  } else if (phase.kind === "llm_input") {
    lines.push(
      `    <phase kind="llm_input"${attr("at", phase.at)}${attr("runId", phase.runId)}${attr("provider", phase.provider)}${attr("model", phase.model)}${attr("imagesCount", phase.imagesCount)}>`,
    );
    if (phase.systemPrompt) {
      const sp = maybeTruncate(phase.systemPrompt, opts.maxBytesPerPrompt);
      lines.push(
        `      <systemPrompt${attr("truncated", sp.truncated || undefined)}${attr("originalBytes", sp.truncated ? sp.originalBytes : undefined)}${attr("digest", sha256(phase.systemPrompt))}><![CDATA[${escapeCdata(sp.value)}]]></systemPrompt>`,
      );
    }
    const pT = maybeTruncate(phase.prompt, opts.maxBytesPerPrompt);
    lines.push(
      `      <prompt${attr("truncated", pT.truncated || undefined)}${attr("originalBytes", pT.truncated ? pT.originalBytes : undefined)}${attr("digest", sha256(phase.prompt))}><![CDATA[${escapeCdata(pT.value)}]]></prompt>`,
    );
    const histText = safeJson(phase.historyMessages);
    const hT = maybeTruncate(histText, opts.maxBytesPerPrompt);
    lines.push(
      `      <history count="${phase.historyMessages.length}"${attr("truncated", hT.truncated || undefined)}${attr("originalBytes", hT.truncated ? hT.originalBytes : undefined)}><![CDATA[${escapeCdata(hT.value)}]]></history>`,
    );
    lines.push(`    </phase>`);
  } else if (phase.kind === "tool_call") {
    lines.push(
      `    <phase kind="tool_call"${attr("at", phase.at)}${attr("name", phase.toolName)}${attr("toolCallId", phase.toolCallId)}${attr("runId", phase.runId)}${attr("durationMs", phase.durationMs)}${attr("error", phase.error)}>`,
    );
    const paramsText = safeJson(phase.params);
    const pT = maybeTruncate(paramsText, opts.maxBytesPerPrompt);
    lines.push(
      `      <params${attr("truncated", pT.truncated || undefined)}><![CDATA[${escapeCdata(pT.value)}]]></params>`,
    );
    if (phase.result !== undefined) {
      const resText = safeJson(phase.result);
      const rT = maybeTruncate(resText, opts.maxBytesPerPrompt);
      lines.push(
        `      <result${attr("truncated", rT.truncated || undefined)}><![CDATA[${escapeCdata(rT.value)}]]></result>`,
      );
    }
    lines.push(`    </phase>`);
  } else if (phase.kind === "llm_output") {
    lines.push(
      `    <phase kind="llm_output"${attr("at", phase.at)}${attr("runId", phase.runId)}${attr("provider", phase.provider)}${attr("model", phase.model)}>`,
    );
    if (phase.usage) {
      const u = phase.usage;
      lines.push(
        `      <usage${attr("input", u.input)}${attr("output", u.output)}${attr("cacheRead", u.cacheRead)}${attr("cacheWrite", u.cacheWrite)}${attr("total", u.total)}/>`,
      );
    }
    for (const text of phase.assistantTexts) {
      const aT = maybeTruncate(text, opts.maxBytesPerPrompt);
      lines.push(
        `      <assistant${attr("truncated", aT.truncated || undefined)}><![CDATA[${escapeCdata(aT.value)}]]></assistant>`,
      );
    }
    lines.push(`    </phase>`);
  } else if (phase.kind === "message_write") {
    const previewT = maybeTruncate(phase.contentPreview, 512);
    lines.push(
      `    <phase kind="message_write"${attr("at", phase.at)}${attr("role", phase.role)}><![CDATA[${escapeCdata(previewT.value)}]]></phase>`,
    );
  }

  return lines.join("\n");
}

function writeTurn(turn: TurnRecord, opts: XmlWriteOptions): string {
  const lines: string[] = [];
  lines.push(
    `  <turn index="${turn.index}"${attr("startedAt", turn.startedAt)}${attr("endedAt", turn.endedAt)}${attr("durationMs", turn.durationMs)}${attr("synthetic", turn.synthetic || undefined)}>`,
  );
  for (const phase of turn.phases) {
    lines.push(writePhase(phase, opts));
  }
  lines.push(`  </turn>`);
  return lines.join("\n");
}

function writeObservedTools(tools: Map<string, ObservedTool>): string {
  const lines: string[] = [];
  lines.push(`  <observedTools count="${tools.size}">`);
  lines.push(
    `    <notice><![CDATA[wire body unavailable, full tool schema list can not recoverable without wrapStreamFn]]></notice>`,
  );
  const sorted = Array.from(tools.values()).toSorted((a, b) => a.toolName.localeCompare(b.toolName));
  for (const t of sorted) {
    const paramKeys = t.paramKeys.toSorted().join(",");
    lines.push(
      `    <tool${attr("name", t.toolName)}${attr("callCount", t.callCount)}${attr("firstSeenAt", t.firstSeenAt)}${attr("lastSeenAt", t.lastSeenAt)}${attr("paramKeys", paramKeys)}/>`,
    );
  }
  lines.push(`  </observedTools>`);
  return lines.join("\n");
}

function writeMeta(meta: TraceMeta): string {
  const lines: string[] = [];
  lines.push(`  <meta>`);
  if (meta.provider) { lines.push(`    <provider>${escAttr(meta.provider)}</provider>`); }
  if (meta.model) { lines.push(`    <model>${escAttr(meta.model)}</model>`); }
  if (meta.channel) { lines.push(`    <channel>${escAttr(meta.channel)}</channel>`); }
  if (meta.openclawVersion) { lines.push(`    <openclawVersion>${escAttr(meta.openclawVersion)}</openclawVersion>`); }
  lines.push(`  </meta>`);
  return lines.join("\n");
}

export function serializeTraceToXml(session: TraceSession, opts: XmlWriteOptions): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<trace schema="1"${attr("traceId", session.traceId)}${attr("sessionKey", session.sessionKey)}${attr("sessionId", session.sessionId)}${attr("channel", session.channel)}${attr("startedAt", session.startedAt)}${attr("endedAt", session.endedAt)}>`,
  );
  lines.push(writeMeta(session.meta));
  lines.push(writeObservedTools(session.observedTools));
  lines.push(`  <turns>`);

  const allTurns = [...session.turns];
  if (session.activeTurn && session.activeTurn.phases.length > 0) {
    allTurns.push(session.activeTurn);
  }
  for (const turn of allTurns) {
    lines.push(writeTurn(turn, opts));
  }

  lines.push(`  </turns>`);
  lines.push(`</trace>`);
  return lines.join("\n");
}
