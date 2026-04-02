export interface MonitorConfig {
  name: string;
  dbPath: string;
  vlmTask?: string;
  vlmServiceUrl?: string;
  fileServerBase?: string;
  recordingsDir?: string;

  /** Python services configuration (for auto-starting Stream Monitor & Worker) */
  services?: {
    /** Path to smarthome-monitor directory (contains stream_monitor/ and worker/) */
    basePath: string;
    /** Path to config.yaml for this monitor */
    configPath: string;
    /** Python executable (default: "python") */
    python?: string;
    /** Auto-start stream monitor on plugin load (default: true) */
    startStreamMonitor?: boolean;
    /** Auto-start worker on plugin load (default: true) */
    startWorker?: boolean;
  };
}

export type MonitorStatus = "connecting" | "online" | "disconnected" | "stopped";

export interface StatusPayload {
  source_id: string;
  event_type: "status";
  status: MonitorStatus;
  message: string;
}

export interface PluginLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
}
