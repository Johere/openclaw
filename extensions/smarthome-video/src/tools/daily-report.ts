import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../api.js";
import type { SmartHomeDb } from "../db.js";
import type { PluginLogger } from "../types.js";

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
          "Final report text to save. If omitted, returns raw summaries for the agent to compose a report.",
      }),
    ),
  },
  { additionalProperties: false },
);

type DailyReportParams = Static<typeof DailyReportToolSchema>;

export function createDailyReportTool(params: {
  getDb: (sourceId: string) => SmartHomeDb | undefined;
  logger: PluginLogger;
}): AnyAgentTool {
  const { getDb, logger } = params;

  return {
    name: "daily_report",
    label: "Daily Report",
    description:
      "Generate or save a daily monitoring report. When called without report_text, " +
      "returns all completed task summaries for the given date so the agent can compose a report. " +
      "When called with report_text, saves the final report to the database.",
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

      try {
        if (p.report_text) {
          // Save the composed report
          const events = db.getMotionEventsByDateRange(p.source_id, date, date + "T23:59:59");
          const tasks = db.getCompletedTasksByDate(p.source_id, date);
          const existing = db.getReport(p.source_id, date);

          if (existing) {
            db.updateReport(existing.id, p.report_text, events.length, tasks.length);
            logger.info(`[daily_report] Updated report for ${p.source_id} on ${date}`);
          } else {
            db.insertReport({
              source_id: p.source_id,
              report_date: date,
              report_text: p.report_text,
              event_count: events.length,
              motion_count: tasks.length,
              status: "completed",
            });
            logger.info(`[daily_report] Created report for ${p.source_id} on ${date}`);
          }

          return {
            content: [
              {
                type: "text",
                text: `Report saved for ${p.source_id} on ${date}. Events: ${events.length}, Summaries: ${tasks.length}.`,
              },
            ],
          };
        }

        // Gather raw data for agent to compose
        const events = db.getMotionEventsByDateRange(p.source_id, date, date + "T23:59:59");
        const tasks = db.getCompletedTasksByDate(p.source_id, date);

        const summaries = tasks
          .filter((t) => t.summary_text)
          .map((t) => ({
            time: t.clip_start_time,
            duration: t.clip_duration,
            summary: t.summary_text,
          }));

        const data = {
          source_id: p.source_id,
          date,
          motion_event_count: events.length,
          completed_summaries: summaries.length,
          summaries,
        };

        return {
          content: [
            {
              type: "text",
              text:
                `Daily data for ${p.source_id} on ${date}:\n` +
                JSON.stringify(data, null, 2) +
                "\n\nPlease compose a concise daily monitoring report based on the above summaries.",
            },
          ],
        };
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
