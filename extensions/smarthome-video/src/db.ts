import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    duration_seconds REAL,
    file_size_bytes INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT,
    duration_seconds REAL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    event_id INTEGER NOT NULL,
    clip_start_time TEXT NOT NULL,
    clip_end_time TEXT NOT NULL,
    clip_duration REAL,
    summary_text TEXT,
    status TEXT DEFAULT 'pending',
    error_message TEXT,
    latency_seconds REAL,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    report_date TEXT NOT NULL,
    report_text TEXT,
    event_count INTEGER,
    motion_count INTEGER,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_recordings_source_time ON recordings(source_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_events_source_type ON events(source_id, event_type);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source_id);
CREATE INDEX IF NOT EXISTS idx_reports_source_date ON reports(source_id, report_date);
`;

export interface RecordingRow {
  id: number;
  source_id: string;
  file_path: string;
  start_time: string;
  end_time: string;
  duration_seconds: number | null;
  file_size_bytes: number | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  source_id: string;
  event_type: string;
  start_time: string;
  end_time: string | null;
  duration_seconds: number | null;
  created_at: string;
}

export interface TaskRow {
  id: number;
  source_id: string;
  event_id: number;
  clip_start_time: string;
  clip_end_time: string;
  clip_duration: number | null;
  summary_text: string | null;
  status: string;
  error_message: string | null;
  latency_seconds: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface ReportRow {
  id: number;
  source_id: string;
  report_date: string;
  report_text: string | null;
  event_count: number | null;
  motion_count: number | null;
  status: string;
  created_at: string;
}

export class SmartHomeDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
  }

  // --- Recordings ---

  insertRecording(params: {
    source_id: string;
    file_path: string;
    start_time: string;
    end_time: string;
    duration_seconds?: number;
    file_size_bytes?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO recordings (source_id, file_path, start_time, end_time, duration_seconds, file_size_bytes)
      VALUES (@source_id, @file_path, @start_time, @end_time, @duration_seconds, @file_size_bytes)
    `);
    const result = stmt.run({
      source_id: params.source_id,
      file_path: params.file_path,
      start_time: params.start_time,
      end_time: params.end_time,
      duration_seconds: params.duration_seconds ?? null,
      file_size_bytes: params.file_size_bytes ?? null,
    });
    return result.lastInsertRowid as number;
  }

  findRecordingsInRange(sourceId: string, startTime: string, endTime: string): RecordingRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM recordings
      WHERE source_id = ? AND start_time < ? AND end_time > ?
      ORDER BY start_time ASC
    `);
    return stmt.all(sourceId, endTime, startTime) as RecordingRow[];
  }

  // --- Events ---

  insertEvent(params: {
    source_id: string;
    event_type: string;
    start_time: string;
    end_time?: string;
    duration_seconds?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO events (source_id, event_type, start_time, end_time, duration_seconds)
      VALUES (@source_id, @event_type, @start_time, @end_time, @duration_seconds)
    `);
    const result = stmt.run({
      source_id: params.source_id,
      event_type: params.event_type,
      start_time: params.start_time,
      end_time: params.end_time ?? null,
      duration_seconds: params.duration_seconds ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getEventsBySource(sourceId: string, limit = 50): EventRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events WHERE source_id = ? ORDER BY id DESC LIMIT ?
    `);
    return stmt.all(sourceId, limit) as EventRow[];
  }

  getMotionEventsByDateRange(sourceId: string, startDate: string, endDate: string): EventRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM events
      WHERE source_id = ? AND event_type = 'motion'
        AND start_time >= ? AND start_time < ?
      ORDER BY start_time ASC
    `);
    return stmt.all(sourceId, startDate, endDate) as EventRow[];
  }

  // --- Tasks ---

  insertTask(params: {
    source_id: string;
    event_id: number;
    clip_start_time: string;
    clip_end_time: string;
    clip_duration?: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (source_id, event_id, clip_start_time, clip_end_time, clip_duration)
      VALUES (@source_id, @event_id, @clip_start_time, @clip_end_time, @clip_duration)
    `);
    const result = stmt.run({
      source_id: params.source_id,
      event_id: params.event_id,
      clip_start_time: params.clip_start_time,
      clip_end_time: params.clip_end_time,
      clip_duration: params.clip_duration ?? null,
    });
    return result.lastInsertRowid as number;
  }

  getPendingTasks(limit = 10): TaskRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks WHERE status = 'pending' ORDER BY id ASC LIMIT ?
    `);
    return stmt.all(limit) as TaskRow[];
  }

  updateTaskStatus(
    taskId: number,
    status: string,
    extra?: { summary_text?: string; error_message?: string; latency_seconds?: number },
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE tasks SET
        status = @status,
        summary_text = COALESCE(@summary_text, summary_text),
        error_message = COALESCE(@error_message, error_message),
        latency_seconds = COALESCE(@latency_seconds, latency_seconds),
        started_at = CASE WHEN @status = 'processing' THEN @now ELSE started_at END,
        completed_at = CASE WHEN @status IN ('completed', 'failed') THEN @now ELSE completed_at END
      WHERE id = @id
    `);
    stmt.run({
      id: taskId,
      status,
      summary_text: extra?.summary_text ?? null,
      error_message: extra?.error_message ?? null,
      latency_seconds: extra?.latency_seconds ?? null,
      now,
    });
  }

  getTasksBySource(sourceId: string, limit = 50): TaskRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks WHERE source_id = ? ORDER BY id DESC LIMIT ?
    `);
    return stmt.all(sourceId, limit) as TaskRow[];
  }

  getCompletedTasksByDate(sourceId: string, date: string): TaskRow[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks
      WHERE source_id = ? AND status = 'completed'
        AND clip_start_time >= ? AND clip_start_time < date(?, '+1 day')
      ORDER BY clip_start_time ASC
    `);
    return stmt.all(sourceId, date, date) as TaskRow[];
  }

  // --- Reports ---

  insertReport(params: {
    source_id: string;
    report_date: string;
    report_text?: string;
    event_count?: number;
    motion_count?: number;
    status?: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO reports (source_id, report_date, report_text, event_count, motion_count, status)
      VALUES (@source_id, @report_date, @report_text, @event_count, @motion_count, @status)
    `);
    const result = stmt.run({
      source_id: params.source_id,
      report_date: params.report_date,
      report_text: params.report_text ?? null,
      event_count: params.event_count ?? null,
      motion_count: params.motion_count ?? null,
      status: params.status ?? "pending",
    });
    return result.lastInsertRowid as number;
  }

  getReport(sourceId: string, date: string): ReportRow | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM reports WHERE source_id = ? AND report_date = ?
    `);
    return stmt.get(sourceId, date) as ReportRow | undefined;
  }

  updateReport(reportId: number, reportText: string, eventCount: number, motionCount: number): void {
    const stmt = this.db.prepare(`
      UPDATE reports SET report_text = ?, event_count = ?, motion_count = ?, status = 'completed'
      WHERE id = ?
    `);
    stmt.run(reportText, eventCount, motionCount, reportId);
  }

  // --- Stats (for agent queries) ---

  getStats(sourceId: string): {
    total_events: number;
    total_motion: number;
    total_tasks: number;
    completed_tasks: number;
    failed_tasks: number;
    total_reports: number;
  } {
    const stmt = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM events WHERE source_id = ?) as total_events,
        (SELECT COUNT(*) FROM events WHERE source_id = ? AND event_type = 'motion') as total_motion,
        (SELECT COUNT(*) FROM tasks WHERE source_id = ?) as total_tasks,
        (SELECT COUNT(*) FROM tasks WHERE source_id = ? AND status = 'completed') as completed_tasks,
        (SELECT COUNT(*) FROM tasks WHERE source_id = ? AND status = 'failed') as failed_tasks,
        (SELECT COUNT(*) FROM reports WHERE source_id = ?) as total_reports
    `);
    return stmt.get(sourceId, sourceId, sourceId, sourceId, sourceId, sourceId) as {
      total_events: number;
      total_motion: number;
      total_tasks: number;
      completed_tasks: number;
      failed_tasks: number;
      total_reports: number;
    };
  }

  /**
   * Run an arbitrary read-only SQL query. Used by the video_db tool
   * to let the agent answer user questions via SQL.
   */
  queryReadOnly(sql: string): unknown[] {
    const trimmed = sql.trim().toUpperCase();
    if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
      throw new Error("Only SELECT / WITH queries are allowed.");
    }
    const stmt = this.db.prepare(sql);
    return stmt.all();
  }

  close(): void {
    this.db.close();
  }
}
