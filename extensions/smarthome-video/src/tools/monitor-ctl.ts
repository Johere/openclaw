import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../api.js";
import type { PluginLogger, MonitorConfig } from "../types.js";
import type { MonitorStatusStore } from "../webhook.js";

function stringEnum<T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    description,
  });
}

const COMMANDS = ["status", "list"] as const;

const MonitorCtlToolSchema = Type.Object(
  {
    command: stringEnum(
      COMMANDS,
      "Command to execute: 'status' checks a specific monitor, 'list' shows all configured monitors.",
    ),
    source_id: Type.Optional(
      Type.String({ description: "Monitor source ID. Required for 'status'." }),
    ),
  },
  { additionalProperties: false },
);

type MonitorCtlParams = Static<typeof MonitorCtlToolSchema>;

export function createMonitorCtlTool(params: {
  monitors: Record<string, MonitorConfig>;
  logger: PluginLogger;
  statusStore: MonitorStatusStore;
}): AnyAgentTool {
  const { monitors, logger, statusStore } = params;

  return {
    name: "monitor_ctl",
    label: "Monitor Control",
    description:
      "List and check status of configured smart home video monitors.",
    parameters: MonitorCtlToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const p = rawParams as MonitorCtlParams;

      switch (p.command) {
        case "list": {
          const list = Object.entries(monitors).map(([id, cfg]) => {
            const s = statusStore.get(id);
            return {
              source_id: id,
              name: cfg.name,
              connectionStatus: s?.status ?? "unknown",
              dbPath: cfg.dbPath,
              vlmTask: cfg.vlmTask ?? "refrigerator_monitor",
              vlmServiceUrl: cfg.vlmServiceUrl ?? "http://localhost:8192",
            };
          });
          return {
            content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
          };
        }

        case "status": {
          if (!p.source_id) {
            return {
              content: [{ type: "text", text: "Parameter 'source_id' is required for status." }],
            };
          }
          const cfg = monitors[p.source_id];
          if (!cfg) {
            return {
              content: [{ type: "text", text: `Unknown source_id: ${p.source_id}` }],
            };
          }

          // Check VLM service health
          let vlmHealthy = false;
          const vlmUrl = cfg.vlmServiceUrl ?? "http://localhost:8192";
          try {
            const resp = await fetch(`${vlmUrl}/v1/health`, { signal: AbortSignal.timeout(5000) });
            vlmHealthy = resp.ok;
          } catch {
            vlmHealthy = false;
          }

          // Get live connection status from webhook status store
          const liveStatus = statusStore.get(p.source_id);

          const status = {
            source_id: p.source_id,
            name: cfg.name,
            connectionStatus: liveStatus?.status ?? "unknown",
            connectionMessage: liveStatus?.message ?? "No status received yet",
            statusUpdatedAt: liveStatus?.updatedAt ?? null,
            vlmServiceUrl: vlmUrl,
            vlmHealthy,
            dbPath: cfg.dbPath,
          };

          return {
            content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown command: ${p.command}` }],
          };
      }
    },
  };
}
