import path from "node:path";
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { SmartHomeDb } from "./src/db.js";
import { createWebhookHandler, type MonitorStatusStore } from "./src/webhook.js";
import { createVideoDbTool } from "./src/tools/video-db.js";
import { createMonitorCtlTool } from "./src/tools/monitor-ctl.js";
import { createDailyReportTool } from "./src/tools/daily-report.js";
import { buildSmartHomeGuidance } from "./src/prompt-guidance.js";
import { ProcessManager } from "./src/process-manager.js";
import type { MonitorConfig } from "./src/types.js";

export default definePluginEntry({
  id: "smarthome-video",
  name: "SmartHome Video",
  description: "Smart home video monitoring with motion detection, VLM summarization, and daily reports.",
  register(api: OpenClawPluginApi) {
    const pluginConfig = api.pluginConfig as { monitors?: Record<string, MonitorConfig> } | undefined;
    const monitors: Record<string, MonitorConfig> = pluginConfig?.monitors ?? {};

    if (Object.keys(monitors).length === 0) {
      api.logger.warn("[smarthome-video] No monitors configured. Plugin will be inactive.");
      return;
    }

    // Initialize DB connections per monitor
    const dbInstances = new Map<string, SmartHomeDb>();

    function getDb(sourceId: string): SmartHomeDb | undefined {
      if (dbInstances.has(sourceId)) {
        return dbInstances.get(sourceId)!;
      }
      const cfg = monitors[sourceId];
      if (!cfg) {
        return undefined;
      }
      const db = new SmartHomeDb(cfg.dbPath);
      dbInstances.set(sourceId, db);
      return db;
    }

    // Pre-initialize all configured DBs
    for (const sourceId of Object.keys(monitors)) {
      getDb(sourceId);
      api.logger.info(`[smarthome-video] Initialized DB for monitor: ${sourceId}`);
    }

    // In-memory status store for monitor connection state (populated by status webhooks)
    const statusStore: MonitorStatusStore = new Map();

    // --- Register webhook route for Stream Monitor events ---
    api.registerHttpRoute({
      path: "/webhook/smarthome/event",
      auth: "none",
      match: "exact",
      handler: createWebhookHandler({ getDb, logger: api.logger, statusStore }),
    });

    // --- Register tools ---
    api.registerTool(() => createVideoDbTool({ getDb, logger: api.logger }), {
      name: "video_db",
    });

    api.registerTool(
      () => createMonitorCtlTool({ monitors, logger: api.logger, statusStore }),
      { name: "monitor_ctl" },
    );

    api.registerTool(() => createDailyReportTool({ getDb, logger: api.logger }), {
      name: "daily_report",
    });

    // --- Inject agent guidance ---
    const monitorList = Object.entries(monitors).map(([id, cfg]) => ({
      sourceId: id,
      name: cfg.name,
    }));

    api.on("before_prompt_build", async () => ({
      prependSystemContext: buildSmartHomeGuidance(monitorList),
    }));

    // --- Start Python services (Stream Monitor + Worker per monitor) ---
    const processManager = new ProcessManager(api.logger);

    api.registerService({
      id: "smarthome-video",
      start: () => {
        for (const [sourceId, cfg] of Object.entries(monitors)) {
          const svc = cfg.services;
          if (!svc) {
            continue;
          }

          const python = svc.python ?? "python";
          const configPath = svc.configPath;
          const basePath = svc.basePath;

          // Start Stream Monitor
          if (svc.startStreamMonitor !== false) {
            processManager.start(`stream-monitor-${sourceId}`, {
              script: path.join(basePath, "stream_monitor", "main.py"),
              configPath,
              python,
              cwd: path.join(basePath, "stream_monitor"),
            });
          }

          // Start Worker
          if (svc.startWorker !== false) {
            processManager.start(`worker-${sourceId}`, {
              script: path.join(basePath, "worker", "main.py"),
              configPath,
              python,
              cwd: path.join(basePath, "worker"),
            });
          }
        }

        api.logger.info("[smarthome-video] Service started.");
      },
      stop: () => {
        // Stop all Python subprocesses
        processManager.stopAll();

        // Close DB connections
        for (const [sourceId, db] of dbInstances) {
          db.close();
          api.logger.info(`[smarthome-video] Closed DB for: ${sourceId}`);
        }
        dbInstances.clear();
      },
    });
  },
});
