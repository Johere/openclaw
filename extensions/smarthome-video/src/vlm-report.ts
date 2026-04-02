/**
 * VLM Report generation helpers for on-demand daily reports.
 *
 * Ports the Python-side logic (event_timeline_builder.py + vlm_client.py)
 * to TypeScript so the daily-report Plugin tool can call VLM Service
 * directly in caption-only mode.
 */

import type { EventRow, TaskRow } from "./db.js";
import type { PluginLogger } from "./types.js";

// ---------------------------------------------------------------------------
// SRT Timeline Builder
// ---------------------------------------------------------------------------

function formatSrtTimestamp(isoTime: string): string {
  const dt = new Date(isoTime);
  const hh = String(dt.getHours()).padStart(2, "0");
  const mm = String(dt.getMinutes()).padStart(2, "0");
  const ss = String(dt.getSeconds()).padStart(2, "0");
  const ms = String(dt.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss},${ms}`;
}

/**
 * Build SRT-formatted timeline from events + completed task summaries.
 *
 * Uses real clock-time timestamps (HH:MM:SS,mmm) so the VLM can detect
 * late-night anomalies like 23:00-06:00 refrigerator access.
 */
export function buildSrtTimeline(
  events: EventRow[],
  summariesMap: Map<number, string>,
): string {
  if (events.length === 0) return "";

  const blocks: string[] = [];
  let blockId = 1;

  for (const event of events) {
    const startTs = formatSrtTimestamp(event.start_time);

    let endTs: string;
    if (event.end_time) {
      endTs = formatSrtTimestamp(event.end_time);
    } else {
      const dur = event.duration_seconds ?? 60;
      const endDt = new Date(new Date(event.start_time).getTime() + dur * 1000);
      endTs = formatSrtTimestamp(endDt.toISOString());
    }

    let subtitleText: string;
    if (event.event_type === "static") {
      subtitleText = "冰箱门保持关闭，无活动";
    } else {
      const summary = summariesMap.get(event.id);
      subtitleText = summary ?? "检测到运动事件";
    }

    blocks.push(`${blockId}\n${startTs} --> ${endTs}\n${subtitleText}\n`);
    blockId++;
  }

  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// Token Estimation & Level Planning (ported from vlm_client.py)
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  let chineseChars = 0;
  for (const c of text) {
    const code = c.codePointAt(0)!;
    if (code >= 0x4e00 && code <= 0x9fff) chineseChars++;
  }
  const otherChars = text.length - chineseChars;
  return Math.floor(chineseChars / 1.5 + otherChars / 4);
}

function estimateTokensPerEvent(subtitleText: string, numEvents: number): number {
  if (numEvents <= 0) return 0;
  return estimateTokens(subtitleText) / numEvents;
}

/**
 * Plan multilevel hierarchy based on token budget.
 * Ensures no single LLM call exceeds modelContext.
 */
export function planLevels(
  subtitleText: string,
  numEvents: number | null,
  modelContext = 32768,
): { levels: number; levelSizes: number[] } {
  const PROMPT_OVERHEAD = 800;
  const OUTPUT_RESERVE = 2000;
  const SAFETY_MARGIN = 2000;
  const SEPARATOR_TOKENS = 5;
  const MAX_GROUP_SIZE = 30;

  const safeBudget = modelContext - PROMPT_OVERHEAD - OUTPUT_RESERVE - SAFETY_MARGIN;

  if (numEvents == null || numEvents <= 0) {
    return { levels: 2, levelSizes: [1, -1] };
  }

  const avgTokens = estimateTokensPerEvent(subtitleText, numEvents);
  const tokensPerEvent = Math.max(100, avgTokens) + SEPARATOR_TOKENS;
  const budgetLimit = Math.max(1, Math.floor(safeBudget / tokensPerEvent));
  const maxMacroGroup = Math.min(budgetLimit, MAX_GROUP_SIZE);

  if (numEvents <= maxMacroGroup) {
    return { levels: 2, levelSizes: [1, -1] };
  }

  // Need macro grouping
  const macroGroupSize = maxMacroGroup;
  const numMacroGroups = Math.ceil(numEvents / macroGroupSize);

  const MACRO_SUMMARY_TOKENS = 600;
  const globalInput = numMacroGroups * (MACRO_SUMMARY_TOKENS + SEPARATOR_TOKENS);
  const GLOBAL_OUTPUT_RESERVE = 4000;
  const globalBudget = modelContext - PROMPT_OVERHEAD - GLOBAL_OUTPUT_RESERVE - SAFETY_MARGIN;

  if (globalInput <= globalBudget) {
    return { levels: 3, levelSizes: [1, macroGroupSize, -1] };
  }

  // Need a second macro level
  const tokensPerMacroSummary = MACRO_SUMMARY_TOKENS + SEPARATOR_TOKENS;
  const maxLevel2Group = Math.min(
    Math.max(1, Math.floor(globalBudget / tokensPerMacroSummary)),
    MAX_GROUP_SIZE,
  );
  const level2GroupSize = Math.min(maxLevel2Group, numMacroGroups);

  return { levels: 4, levelSizes: [1, macroGroupSize, level2GroupSize, -1] };
}

// ---------------------------------------------------------------------------
// VLM Service HTTP Call (caption-only mode)
// ---------------------------------------------------------------------------

export interface VlmReportResult {
  status: string;
  summary: string | null;
  message?: string;
}

/**
 * Call VLM Service in caption-only mode to generate a daily report.
 *
 * Sends `video: "none"` with `video_subtitles` containing the SRT timeline.
 * VLM performs multilevel text-only reasoning to produce the report.
 */
export async function callVlmDailyReport(params: {
  vlmServiceUrl: string;
  subtitleText: string;
  numEvents: number;
  userPrompt?: string;
  timeout?: number;
  logger: PluginLogger;
}): Promise<VlmReportResult> {
  const { vlmServiceUrl, subtitleText, numEvents, userPrompt, logger } = params;
  const timeout = params.timeout ?? 600_000; // 600s default

  const { levels, levelSizes } = planLevels(subtitleText, numEvents);
  logger.info(
    `[vlm-report] Using ${levels} levels with grouping [${levelSizes.join(",")}] for ${numEvents} events`,
  );

  const payload: Record<string, unknown> = {
    video: "none",
    video_subtitles: { text: subtitleText },
    task: "daily_report",
    method: "USE_ALL_T-1",
    processor_kwargs: {
      levels,
      level_sizes: levelSizes,
      process_fps: 0,
    },
  };

  if (userPrompt) {
    payload.prompt = userPrompt;
  }

  const url = `${vlmServiceUrl}/v1/summary`;
  logger.info(`[vlm-report] Requesting daily report from VLM (${subtitleText.length} chars)`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!resp.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await resp.json());
      } catch {
        detail = (await resp.text()).slice(0, 500);
      }
      logger.error(`[vlm-report] VLM request failed [${resp.status}]: ${detail}`);
      return { status: "FAILED", summary: null, message: `HTTP ${resp.status}: ${detail}` };
    }

    const result = (await resp.json()) as Record<string, unknown>;
    logger.info(
      `[vlm-report] Daily report received (status: ${result.status}, duration: ${result.video_duration ?? 0}s)`,
    );
    return {
      status: String(result.status ?? "OK"),
      summary: (result.summary as string) ?? null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[vlm-report] VLM request failed: ${msg}`);
    return { status: "FAILED", summary: null, message: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Convenience: build summaries map from completed tasks
// ---------------------------------------------------------------------------

export function buildSummariesMap(tasks: TaskRow[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const t of tasks) {
    if (t.summary_text) {
      map.set(t.event_id, t.summary_text);
    }
  }
  return map;
}
