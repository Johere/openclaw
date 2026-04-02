/**
 * Manages Python subprocess lifecycle for Stream Monitor and Worker.
 *
 * Each monitor gets its own Stream Monitor process.
 * Each monitor gets its own Worker process.
 * All processes are killed on plugin shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { PluginLogger } from "./types.js";

export interface ProcessConfig {
  /** Absolute path to the Python script (e.g., stream_monitor/main.py) */
  script: string;
  /** Absolute path to config.yaml */
  configPath: string;
  /** Python executable (default: "python") */
  python?: string;
  /** Working directory for the process */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Auto-restart on non-zero exit (default: true) */
  autoRestart?: boolean;
  /** Max restart attempts before giving up (default: 10) */
  maxRestarts?: number;
  /** Delay between restarts in ms (default: 5000) */
  restartDelay?: number;
}

interface ManagedProcess {
  id: string;
  child: ChildProcess;
  config: ProcessConfig;
  restartCount: number;
  stopping: boolean;
}

export class ProcessManager {
  private processes: Map<string, ManagedProcess> = new Map();
  private restartTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private logger: PluginLogger;

  constructor(logger: PluginLogger) {
    this.logger = logger;
  }

  /**
   * Spawn a managed Python subprocess.
   */
  start(id: string, config: ProcessConfig): boolean {
    return this._spawnProcess(id, config, 0);
  }

  private _spawnProcess(id: string, config: ProcessConfig, restartCount: number): boolean {
    if (this.processes.has(id)) {
      this.logger.warn(`[ProcessManager] Process already running: ${id}`);
      return false;
    }

    const python = config.python ?? "python";
    const args = [config.script, config.configPath];

    this.logger.info(`[ProcessManager] Starting: ${id} → ${python} ${args.join(" ")}`);

    const child = spawn(python, args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Forward stdout/stderr to plugin logger
    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        this.logger.info(`[${id}] ${line}`);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        this.logger.error(`[${id}] ${line}`);
      }
    });

    child.on("exit", (code, signal) => {
      this.logger.info(
        `[ProcessManager] Process exited: ${id} (code=${code}, signal=${signal})`,
      );

      const managed = this.processes.get(id);
      if (!managed) return;

      // If we're intentionally stopping, don't restart
      if (managed.stopping) {
        this.processes.delete(id);
        return;
      }

      const autoRestart = config.autoRestart !== false;
      const maxRestarts = config.maxRestarts ?? 10;
      const restartDelay = config.restartDelay ?? 5000;

      // Non-zero exit + autoRestart enabled → schedule restart
      if (code !== 0 && autoRestart && managed.restartCount < maxRestarts) {
        managed.restartCount++;
        this.logger.warn(
          `[ProcessManager] Scheduling restart for ${id} in ${restartDelay}ms ` +
            `(attempt ${managed.restartCount}/${maxRestarts})`,
        );
        this.processes.delete(id);

        const timer = setTimeout(() => {
          this.restartTimers.delete(id);
          this.logger.info(`[ProcessManager] Restarting: ${id}`);
          this._spawnProcess(id, config, managed.restartCount);
        }, restartDelay);
        this.restartTimers.set(id, timer);
      } else if (code !== 0 && autoRestart && managed.restartCount >= maxRestarts) {
        this.logger.error(
          `[ProcessManager] Max restarts (${maxRestarts}) reached for ${id}, giving up`,
        );
        this.processes.delete(id);
      } else {
        this.processes.delete(id);
      }
    });

    child.on("error", (err) => {
      this.logger.error(`[ProcessManager] Process error: ${id} → ${err.message}`);
      this.processes.delete(id);
    });

    this.processes.set(id, { id, child, config, restartCount, stopping: false });
    this.logger.info(`[ProcessManager] Started: ${id} (pid=${child.pid})`);
    return true;
  }

  /**
   * Stop a managed subprocess.
   */
  stop(id: string): void {
    // Cancel any pending restart timer
    const timer = this.restartTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.restartTimers.delete(id);
    }

    const managed = this.processes.get(id);
    if (!managed) {
      return;
    }

    // Mark as intentionally stopping so exit handler won't auto-restart
    managed.stopping = true;

    this.logger.info(`[ProcessManager] Stopping: ${id} (pid=${managed.child.pid})`);

    managed.child.kill("SIGTERM");

    // Force kill after 5 seconds if still alive
    const forceKillTimer = setTimeout(() => {
      if (!managed.child.killed) {
        this.logger.warn(`[ProcessManager] Force killing: ${id}`);
        managed.child.kill("SIGKILL");
      }
    }, 5000);

    managed.child.on("exit", () => {
      clearTimeout(forceKillTimer);
    });

    this.processes.delete(id);
  }

  /**
   * Stop all managed subprocesses and cancel pending restarts.
   */
  stopAll(): void {
    this.logger.info(
      `[ProcessManager] Stopping all processes (${this.processes.size} running, ${this.restartTimers.size} pending restart)`,
    );

    // Cancel all pending restart timers first
    for (const [id, timer] of this.restartTimers) {
      clearTimeout(timer);
    }
    this.restartTimers.clear();

    for (const id of [...this.processes.keys()]) {
      this.stop(id);
    }
  }

  /**
   * Check if a process is running.
   */
  isRunning(id: string): boolean {
    const managed = this.processes.get(id);
    if (!managed) {
      return false;
    }
    return !managed.child.killed;
  }

  /**
   * Get status of all managed processes.
   */
  getStatus(): Record<string, { pid: number | undefined; running: boolean; restartCount: number }> {
    const status: Record<string, { pid: number | undefined; running: boolean; restartCount: number }> = {};
    for (const [id, managed] of this.processes) {
      status[id] = {
        pid: managed.child.pid,
        running: !managed.child.killed,
        restartCount: managed.restartCount,
      };
    }
    return status;
  }
}
