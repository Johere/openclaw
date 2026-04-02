import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../api.js";
import type { SmartHomeDb } from "../db.js";
import type { PluginLogger } from "../types.js";

function stringEnum<T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    description,
  });
}

const ACTIONS = [
  "query",
  "stats",
  "recent_events",
  "recent_tasks",
  "tasks_by_date",
  "report",
] as const;

const VideoDbToolSchema = Type.Object(
  {
    source_id: Type.String({ description: "Monitor source ID (e.g. 'cam_fridge')." }),
    action: stringEnum(
      ACTIONS,
      "Action to perform: 'query' runs custom SQL, 'stats' returns overview, " +
        "'recent_events' lists events, 'recent_tasks' lists tasks, " +
        "'tasks_by_date' filters completed tasks by date, 'report' fetches a daily report.",
    ),
    sql: Type.Optional(
      Type.String({
        description: "SQL query for action='query'. Only SELECT/WITH allowed.",
      }),
    ),
    date: Type.Optional(
      Type.String({
        description: "Date string (YYYY-MM-DD) for action='tasks_by_date' or action='report'.",
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: "Max rows to return for list actions. Default: 20.",
        minimum: 1,
        maximum: 200,
      }),
    ),
  },
  { additionalProperties: false },
);

type VideoDbToolParams = Static<typeof VideoDbToolSchema>;

export function createVideoDbTool(params: {
  getDb: (sourceId: string) => SmartHomeDb | undefined;
  logger: PluginLogger;
}): AnyAgentTool {
  const { getDb, logger } = params;

  return {
    name: "video_db",
    label: "Video DB",
    description:
      "Query the smart home video monitoring database. Supports listing events, tasks, " +
      "summaries, statistics, and custom SQL queries for a given monitor source.",
    parameters: VideoDbToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const p = rawParams as VideoDbToolParams;
      const db = getDb(p.source_id);
      if (!db) {
        return {
          content: [{ type: "text", text: `Unknown source_id: ${p.source_id}` }],
        };
      }

      try {
        let result: unknown;

        switch (p.action) {
          case "stats":
            result = db.getStats(p.source_id);
            break;

          case "recent_events":
            result = db.getEventsBySource(p.source_id, p.limit ?? 20);
            break;

          case "recent_tasks":
            result = db.getTasksBySource(p.source_id, p.limit ?? 20);
            break;

          case "tasks_by_date": {
            if (!p.date) {
              return {
                content: [{ type: "text", text: "Parameter 'date' is required for tasks_by_date." }],
              };
            }
            result = db.getCompletedTasksByDate(p.source_id, p.date);
            break;
          }

          case "report": {
            if (!p.date) {
              return {
                content: [{ type: "text", text: "Parameter 'date' is required for report." }],
              };
            }
            result = db.getReport(p.source_id, p.date);
            if (!result) {
              return {
                content: [{ type: "text", text: `No report found for ${p.source_id} on ${p.date}.` }],
              };
            }
            break;
          }

          case "query": {
            if (!p.sql) {
              return {
                content: [{ type: "text", text: "Parameter 'sql' is required for query action." }],
              };
            }
            result = db.queryReadOnly(p.sql);
            break;
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown action: ${p.action}` }],
            };
        }

        const text = JSON.stringify(result, null, 2);
        return {
          content: [{ type: "text", text }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[video_db] Error: ${msg}`);
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
        };
      }
    },
  };
}
