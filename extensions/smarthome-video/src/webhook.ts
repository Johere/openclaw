import type { IncomingMessage, ServerResponse } from "node:http";
import type { SmartHomeDb } from "./db.js";
import type { MonitorStatus, PluginLogger, StatusPayload } from "./types.js";

interface RecordingPayload {
  source_id: string;
  event_type: "recording";
  file_path: string;
  start_time: string;
  end_time: string;
  duration_seconds?: number;
  file_size_bytes?: number;
}

interface MotionPayload {
  source_id: string;
  event_type: "motion";
  start_time: string;
  end_time: string;
  duration_seconds?: number;
}

interface StatusWebhookPayload {
  source_id: string;
  event_type: "status";
  status: string;
  message: string;
}

type WebhookPayload = RecordingPayload | MotionPayload | StatusWebhookPayload;

function isRecordingPayload(payload: WebhookPayload): payload is RecordingPayload {
  return payload.event_type === "recording";
}

function isMotionPayload(payload: WebhookPayload): payload is MotionPayload {
  return payload.event_type === "motion";
}

function isStatusPayload(payload: WebhookPayload): payload is StatusWebhookPayload {
  return payload.event_type === "status";
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export interface MonitorStatusEntry {
  status: MonitorStatus;
  message: string;
  updatedAt: string;
}

/** In-memory store of latest monitor status per source_id */
export type MonitorStatusStore = Map<string, MonitorStatusEntry>;

export function createWebhookHandler(params: {
  getDb: (sourceId: string) => SmartHomeDb | undefined;
  logger: PluginLogger;
  statusStore: MonitorStatusStore;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { getDb, logger, statusStore } = params;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return true;
    }

    let payload: WebhookPayload;
    try {
      payload = (await readJsonBody(req)) as WebhookPayload;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return true;
    }

    if (!payload.source_id || !payload.event_type) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing source_id or event_type" }));
      return true;
    }

    // Status events don't require DB — handle before DB lookup
    if (isStatusPayload(payload)) {
      statusStore.set(payload.source_id, {
        status: payload.status as MonitorStatus,
        message: payload.message,
        updatedAt: new Date().toISOString(),
      });
      logger.info(
        `[smarthome] Status update: source=${payload.source_id} status=${payload.status} msg=${payload.message}`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }

    const db = getDb(payload.source_id);
    if (!db) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown source_id: ${payload.source_id}` }));
      return true;
    }

    try {
      if (isRecordingPayload(payload)) {
        const recordingId = db.insertRecording({
          source_id: payload.source_id,
          file_path: payload.file_path,
          start_time: payload.start_time,
          end_time: payload.end_time,
          duration_seconds: payload.duration_seconds,
          file_size_bytes: payload.file_size_bytes,
        });
        logger.info(`[smarthome] Recording inserted: id=${recordingId} source=${payload.source_id}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, recording_id: recordingId }));
      } else if (isMotionPayload(payload)) {
        const eventId = db.insertEvent({
          source_id: payload.source_id,
          event_type: "motion",
          start_time: payload.start_time,
          end_time: payload.end_time,
          duration_seconds: payload.duration_seconds,
        });

        const taskId = db.insertTask({
          source_id: payload.source_id,
          event_id: eventId,
          clip_start_time: payload.start_time,
          clip_end_time: payload.end_time,
          clip_duration: payload.duration_seconds,
        });

        logger.info(
          `[smarthome] Motion event: event_id=${eventId} task_id=${taskId} source=${payload.source_id}`,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, event_id: eventId, task_id: taskId }));
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown event_type: ${(payload as WebhookPayload).event_type}` }));
      }
    } catch (err) {
      logger.error(`[smarthome] Webhook handler error: ${err}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }

    return true;
  };
}
