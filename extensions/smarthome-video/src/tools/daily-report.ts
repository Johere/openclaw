import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../api.js";
import type { SmartHomeDb } from "../db.js";
import type { MonitorConfig, PluginLogger } from "../types.js";
import { buildSrtTimeline, buildSummariesMap, callVlmDailyReport } from "../vlm-report.js";

const DailyReportToolSchema = Type.Object(
  {
    source_id: Type.String({ description: "Monitor source ID (e.g. 'cam_fridge')." }),
    date: Type.Optional(
      Type.String({
        description: "Report date (YYYY-MM-DD). Defaults to today.",
      }),
    ),
    report_text: Type.Optional(
      Type.String({
        description:
          "Override report text to save directly. If omitted, generates report via VLM Service.",
      }),
    ),
  },
  { additionalProperties: false },
);

type DailyReportParams = Static<typeof DailyReportToolSchema>;

export function createDailyReportTool(params: {
  getDb: (sourceId: string) => SmartHomeDb | undefined;
  monitors: Record<string, MonitorConfig>;
  logger: PluginLogger;
}): AnyAgentTool {
  const { getDb, monitors, logger } = params;

  return {
    name: "daily_report",
    label: "Daily Report",
    description:
      "Generate or save a daily monitoring report. " +
      "When called without report_text, gathers today's events and task summaries, " +
      "builds an SRT timeline, and calls VLM Service (caption-only multilevel reasoning) " +
      "to generate the report automatically. " +
      "When called with report_text, saves/overrides the report directly.",
    parameters: DailyReportToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const p = rawParams as DailyReportParams;
      const db = getDb(p.source_id);
      if (!db) {
        return {
          content: [{ type: "text", text: `Unknown source_id: ${p.source_id}` }],
        };
      }

      const date = p.date ?? new Date().toISOString().slice(0, 10);
      const dateStart = date;
      const dateEnd = date + "T23:59:59";

      try {
        if (p.report_text) {
          // --- Save/override mode: store provided report text directly ---
          return saveReport(db, p.source_id, date, dateStart, dateEnd, p.report_text, logger);
        }

        // --- On-demand generation: build SRT → call VLM → save ---
        return await generateReport(db, p.source_id, date, dateStart, dateEnd, monitors, logger);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[daily_report] Error: ${msg}`);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
        };
      }
    },
  };
}

function saveReport(
  db: SmartHomeDb,
  sourceId: string,
  date: string,
  dateStart: string,
  dateEnd: string,
  reportText: string,
  logger: PluginLogger,
) {
  const events = db.getMotionEventsByDateRange(sourceId, dateStart, dateEnd);
  const tasks = db.getCompletedTasksByDate(sourceId, date);
  const existing = db.getReport(sourceId, date);

  if (existing) {
    db.updateReport(existing.id, reportText, events.length, tasks.length);
    logger.info(`[daily_report] Updated report for ${sourceId} on ${date}`);
  } else {
    db.insertReport({
      source_id: sourceId,
      report_date: date,
      report_text: reportText,
      event_count: events.length,
      motion_count: tasks.length,
      status: "completed",
    });
    logger.info(`[daily_report] Created report for ${sourceId} on ${date}`);
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Report saved for ${sourceId} on ${date}. Events: ${events.length}, Summaries: ${tasks.length}.`,
      },
    ],
  };
}

async function generateReport(
  db: SmartHomeDb,
  sourceId: string,
  date: string,
  dateStart: string,
  dateEnd: string,
  monitors: Record<string, MonitorConfig>,
  logger: PluginLogger,
) {
  const cfg = monitors[sourceId];
  const vlmServiceUrl = cfg?.vlmServiceUrl ?? "http://localhost:8192";

  // 1. Query events + completed task summaries for the date
  const events = db.getMotionEventsByDateRange(sourceId, dateStart, dateEnd);
  const tasks = db.getCompletedTasksByDate(sourceId, date);

  if (events.length === 0 && tasks.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No events or completed tasks found for ${sourceId} on ${date}. Nothing to report.`,
        },
      ],
    };
  }

  // 2. Build SRT timeline
  const summariesMap = buildSummariesMap(tasks);
  const srtText = buildSrtTimeline(events, summariesMap);

  if (!srtText) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No timeline data available for ${sourceId} on ${date}.`,
        },
      ],
    };
  }

  logger.info(
    `[daily_report] Built SRT timeline: ${events.length} events, ${tasks.length} summaries, ${srtText.length} chars`,
  );

  // 3. Call VLM Service caption-only mode
  const vlmResult = await callVlmDailyReport({
    vlmServiceUrl,
    subtitleText: srtText,
    numEvents: events.length,
    logger,
  });

  if (vlmResult.status === "FAILED" || !vlmResult.summary) {
    return {
      content: [
        {
          type: "text" as const,
          text: `VLM report generation failed for ${sourceId} on ${date}: ${vlmResult.message ?? "empty summary"}`,
        },
      ],
    };
  }

  // 4. Save report to DB
  const existing = db.getReport(sourceId, date);
  if (existing) {
    db.updateReport(existing.id, vlmResult.summary, events.length, tasks.length);
    logger.info(`[daily_report] Updated VLM-generated report for ${sourceId} on ${date}`);
  } else {
    db.insertReport({
      source_id: sourceId,
      report_date: date,
      report_text: vlmResult.summary,
      event_count: events.length,
      motion_count: tasks.length,
      status: "completed",
    });
    logger.info(`[daily_report] Created VLM-generated report for ${sourceId} on ${date}`);
  }

  // 5. Return report to agent
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Daily report for ${sourceId} on ${date} (${events.length} events, ${tasks.length} summaries):\n\n` +
          vlmResult.summary,
      },
    ],
  };
}
