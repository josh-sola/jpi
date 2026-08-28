import type { SpawnOptions } from "node:child_process";

import { errorMessage } from "../../../src/core/index.ts";
import type {
  BackgroundChildProcess,
  BackgroundSpawnFn,
  KillKind,
  TaskStatus,
} from "../registry.ts";
import { appendError, type BgTask } from "./task.ts";

export const DEFAULT_KILL_GRACE_MS = 3000;
export const DEFAULT_STOP_WAIT_MS = 4500;

export interface TaskProcessLifecycleOptions {
  readonly spawn: BackgroundSpawnFn;
  readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  readonly killGraceMs: number;
  readonly stopWaitMs: number;
}

/**
 * Owns spawning a task's child process and every way it can end: signal
 * escalation, the cancellation wait, and mapping a `close` event to a
 * terminal status. POSIX process-group semantics only.
 */
export class TaskProcessLifecycle {
  private readonly spawnFn: BackgroundSpawnFn;
  private readonly killProcessFn: (pid: number, signal: NodeJS.Signals) => void;
  private readonly killGraceMs: number;
  private readonly stopWaitMs: number;

  constructor(options: TaskProcessLifecycleOptions) {
    this.spawnFn = options.spawn;
    this.killProcessFn = options.killProcess;
    this.killGraceMs = options.killGraceMs;
    this.stopWaitMs = options.stopWaitMs;
  }

  spawn(command: string, args: string[], options: SpawnOptions): BackgroundChildProcess {
    return this.spawnFn(command, args, options);
  }

  resolveCloseOutcome(
    task: BgTask,
    code: number | null,
    signalName: NodeJS.Signals | null,
  ): { status: TaskStatus; error: string | undefined } {
    if (task.killKind === "user" || task.killKind === "shutdown") {
      return { status: "killed", error: undefined };
    }
    if (
      task.killKind === "timeout" ||
      task.killKind === "output_cap" ||
      task.killKind === "write_error"
    ) {
      return { status: "failed", error: undefined };
    }
    if ((code ?? 0) === 0) return { status: "completed", error: undefined };
    return {
      status: "failed",
      error: `Exited with code ${code === null ? "null" : code}${signalName ? ` (${signalName})` : ""}`,
    };
  }

  requestKill(task: BgTask, signal: NodeJS.Signals): void {
    if (task.status !== "running")
      throw new Error(`Task ${task.id} is ${task.status}, not running`);
    if (!task.child || task.pid === undefined)
      throw new Error(`Task ${task.id} has no process to kill`);
    if (task.killSignalSent && signal === "SIGTERM") return;

    const errors: string[] = [];
    let killed = false;
    try {
      this.killProcessFn(-task.pid, signal);
      killed = true;
    } catch (error) {
      errors.push(`process group kill failed: ${errorMessage(error)}`);
    }
    if (!killed) {
      try {
        task.child.kill(signal);
        killed = true;
      } catch (error) {
        errors.push(`child kill failed: ${errorMessage(error)}`);
      }
    }
    if (!killed) throw new Error(`Could not kill task ${task.id}: ${errors.join("; ")}`);

    task.killSignalSent = true;
    // SIGKILL is the terminal escalation; it must never schedule a further one.
    if (signal === "SIGKILL") return;
    // Only one escalation timer may be outstanding, so concurrent stop
    // requests on the same task never arm a second one.
    if (task.killEscalationTimer !== undefined) return;
    task.killEscalationTimer = setTimeout(() => {
      task.killEscalationTimer = undefined;
      if (task.status !== "running") return;
      try {
        this.requestKill(task, "SIGKILL");
      } catch (error) {
        task.error = appendError(task.error, `SIGKILL failed: ${errorMessage(error)}`);
      }
    }, this.killGraceMs);
    task.killEscalationTimer.unref?.();
  }

  async stopTask(task: BgTask, kind: KillKind, reason?: string): Promise<BgTask> {
    if (task.status !== "running")
      throw new Error(`Task ${task.id} is ${task.status}, not running`);
    task.killKind = kind;
    if (reason) task.error = reason;
    this.requestKill(task, "SIGTERM");
    const stopped = await this.waitForEnd(task, this.stopWaitMs);
    if (!stopped)
      throw new Error(
        `Task ${task.id} did not exit within ${this.stopWaitMs}ms after cancellation`,
      );
    return task;
  }

  waitForEnd(task: BgTask, timeoutMs: number): Promise<boolean> {
    if (task.status !== "running") return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = task.waiters.indexOf(done);
        if (index >= 0) task.waiters.splice(index, 1);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      task.waiters.push(done);
    });
  }
}
