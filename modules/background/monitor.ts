import { logBestEffort } from "./log-best-effort.ts";
import { BACKGROUND_NOTIFICATION_TYPE } from "./notification-renderer.ts";
import { NOTIFICATION_PREAMBLE_LINES } from "./prompts.ts";
import {
  type BackgroundTaskRegistry,
  type BgTaskSnapshot,
  type CompletionNotificationSender,
  DEFAULT_MAX_RECENT_TASKS,
  type StartTaskOptions,
  type TaskRunContext,
} from "./registry.ts";

export const DEFAULT_MONITOR_TIMEOUT_SECONDS = 1800;
export const DEFAULT_MAX_EVENTS_PER_MINUTE = 30;
export const FLOOD_HARD_MULTIPLE = 2;
export const BATCH_WINDOW_MS = 200;
const EVENT_WINDOW_MS = 60_000;

export type MonitorTerminalStatus = "exited" | "timeout" | "cancelled" | "failed";
export type MonitorStatus = "running" | MonitorTerminalStatus;

export interface MonitorSnapshot {
  readonly kind: "monitor";
  readonly id: string;
  readonly description: string;
  readonly command: string;
  readonly status: MonitorStatus;
  readonly outputPath: string;
  readonly startTime: number;
  readonly endTime: number | undefined;
  readonly exitCode: number | null | undefined;
  readonly persistent: boolean;
  readonly eventCount: number;
  readonly error: string | undefined;
}

export interface StartMonitorOptions {
  readonly timeoutSeconds?: number;
  readonly persistent?: boolean;
}

export interface MonitorManagerOptions {
  readonly registry: BackgroundTaskRegistry;
  readonly sendNotification: CompletionNotificationSender;
  readonly publishTerminal?: (snapshot: MonitorSnapshot) => void;
  readonly now?: () => number;
  readonly defaultTimeoutSeconds?: number;
  readonly maxEventsPerMinute?: number;
  readonly batchWindowMs?: number;
  readonly maxRecentMonitors?: number;
  readonly logger?: Pick<Console, "error">;
}

interface MonitorState {
  id: string;
  description: string;
  command: string;
  persistent: boolean;
  startTime: number;
  status: MonitorStatus;
  endTime: number | undefined;
  exitCode: number | null | undefined;
  eventCount: number;
  error: string | undefined;
  floodStopped: boolean;
  suppressedNoticeSent: boolean;
  finalized: boolean;
  lineBuffer: string;
  batch: string[];
  batchTimer: NodeJS.Timeout | undefined;
  eventTimestamps: number[];
  outputPath: string;
  unsubscribeChange: (() => void) | undefined;
}

function noop(): void {
  return undefined;
}

function snapshot(monitor: MonitorState): MonitorSnapshot {
  return {
    kind: "monitor",
    id: monitor.id,
    description: monitor.description,
    command: monitor.command,
    status: monitor.status,
    outputPath: monitor.outputPath,
    startTime: monitor.startTime,
    endTime: monitor.endTime,
    exitCode: monitor.exitCode,
    persistent: monitor.persistent,
    eventCount: monitor.eventCount,
    error: monitor.error,
  };
}

function buildEventContent(monitor: MonitorState, text: string): string {
  return [
    ...NOTIFICATION_PREAMBLE_LINES,
    `monitor_id: ${monitor.id}`,
    `description: ${monitor.description}`,
    "event:",
    text,
  ].join("\n");
}

function buildTerminalContent(
  monitor: MonitorState,
  status: MonitorTerminalStatus,
  note: string,
): string {
  const lines = [
    ...NOTIFICATION_PREAMBLE_LINES,
    `monitor_id: ${monitor.id}`,
    `description: ${monitor.description}`,
    `status: ${status}`,
  ];
  if (monitor.exitCode !== undefined && monitor.exitCode !== null)
    lines.push(`exit_code: ${monitor.exitCode}`);
  lines.push(`output_path: ${monitor.outputPath}`, note, "Use bg_logs for the full output.");
  return lines.join("\n");
}

/**
 * Layers streaming, line-batched events and flood control on top of plain
 * registry tasks. A monitor is a registry task underneath (same detached
 * spawn, kill escalation, and shutdown handling); this class only watches
 * its stdout and terminal state and reports its own richer status.
 */
export class MonitorManager {
  private readonly registry: BackgroundTaskRegistry;
  private readonly sendNotification: CompletionNotificationSender;
  private readonly publishTerminalFn: (snapshot: MonitorSnapshot) => void;
  private readonly now: () => number;
  private readonly batchWindowMs: number;
  private readonly logger: Pick<Console, "error">;
  private readonly monitors = new Map<string, MonitorState>();
  private readonly maxRecentMonitors: number;
  private shuttingDown = false;
  private defaultTimeoutSeconds: number;
  private maxEventsPerMinute: number;

  constructor(options: MonitorManagerOptions) {
    this.registry = options.registry;
    this.sendNotification = options.sendNotification;
    this.publishTerminalFn = options.publishTerminal ?? noop;
    this.now = options.now ?? Date.now;
    this.batchWindowMs = options.batchWindowMs ?? BATCH_WINDOW_MS;
    this.logger = options.logger ?? console;
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds ?? DEFAULT_MONITOR_TIMEOUT_SECONDS;
    this.maxEventsPerMinute = options.maxEventsPerMinute ?? DEFAULT_MAX_EVENTS_PER_MINUTE;
    this.maxRecentMonitors = options.maxRecentMonitors ?? DEFAULT_MAX_RECENT_TASKS;
  }

  configure(options: { defaultTimeoutSeconds?: number; maxEventsPerMinute?: number }): void {
    if (options.defaultTimeoutSeconds !== undefined)
      this.defaultTimeoutSeconds = options.defaultTimeoutSeconds;
    if (options.maxEventsPerMinute !== undefined)
      this.maxEventsPerMinute = options.maxEventsPerMinute;
  }

  /** Mirrors registry.reset(): clears the shutdown flag for a fresh session in the same process. */
  reset(): void {
    this.shuttingDown = false;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  has(id: string): boolean {
    return this.monitors.has(id);
  }

  get(id: string): MonitorSnapshot | undefined {
    const monitor = this.monitors.get(id);
    return monitor ? snapshot(monitor) : undefined;
  }

  /** Exact id or unambiguous prefix within monitors only; undefined (not a throw) when none match. */
  resolve(idOrPrefix: string): MonitorSnapshot | undefined {
    const id = idOrPrefix.trim();
    if (!id) return undefined;
    const exact = this.monitors.get(id);
    if (exact) return snapshot(exact);
    const matches = [...this.monitors.values()].filter((monitor) => monitor.id.startsWith(id));
    if (matches.length === 1) return snapshot(matches[0]!);
    if (matches.length > 1) {
      throw new Error(
        `Task id "${id}" is ambiguous: matches ${matches.map((monitor) => monitor.id).join(", ")}`,
      );
    }
    return undefined;
  }

  list(): MonitorSnapshot[] {
    return [...this.monitors.values()].map(snapshot);
  }

  async start(
    ctx: TaskRunContext,
    command: string,
    description: string,
    options: StartMonitorOptions = {},
  ): Promise<MonitorSnapshot> {
    const persistent = options.persistent ?? false;
    const timeoutSeconds = persistent
      ? undefined
      : (options.timeoutSeconds ?? this.defaultTimeoutSeconds);

    // Built before start() is even called: the child can write and this
    // registers a listener for it synchronously at spawn time, so no stdout
    // chunk arriving during start()'s own async work is ever missed.
    const monitor: MonitorState = {
      id: "",
      description,
      command,
      persistent,
      startTime: this.now(),
      status: "running",
      endTime: undefined,
      exitCode: undefined,
      eventCount: 0,
      error: undefined,
      floodStopped: false,
      suppressedNoticeSent: false,
      finalized: false,
      lineBuffer: "",
      batch: [],
      batchTimer: undefined,
      eventTimestamps: [],
      outputPath: "",
      unsubscribeChange: undefined,
    };

    const taskOptions: StartTaskOptions = {
      name: description,
      wakeOnCompletion: false,
      onOutput: (chunk, source) => {
        if (source === "stdout") this.handleStdout(monitor, chunk);
      },
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    };

    const task = await this.registry.start(ctx, command, taskOptions);
    monitor.id = task.id;
    monitor.command = task.command;
    monitor.startTime = task.startTime;
    monitor.outputPath = task.outputPath;
    this.monitors.set(monitor.id, monitor);

    monitor.unsubscribeChange = this.registry.onChange(() => {
      if (monitor.status !== "running") return;
      let current: BgTaskSnapshot;
      try {
        current = this.registry.get(monitor.id);
      } catch {
        return;
      }
      if (current.status !== "running") this.finalize(monitor, current);
    });

    return snapshot(monitor);
  }

  private handleStdout(monitor: MonitorState, chunk: string): void {
    if (monitor.status !== "running") return;
    monitor.lineBuffer += chunk;
    const parts = monitor.lineBuffer.split("\n");
    monitor.lineBuffer = parts.pop() ?? "";
    if (parts.length === 0) return;
    for (const line of parts) {
      if (line.length === 0) continue;
      monitor.batch.push(line);
    }
    if (monitor.batch.length === 0) return;
    if (monitor.batchTimer === undefined) {
      monitor.batchTimer = setTimeout(() => this.flushBatch(monitor), this.batchWindowMs);
      monitor.batchTimer.unref?.();
    }
  }

  private flushBatch(monitor: MonitorState): void {
    monitor.batchTimer = undefined;
    if (monitor.batch.length === 0) return;
    const text = monitor.batch.join("\n");
    monitor.batch = [];
    this.recordEvent(monitor, text);
  }

  private recordEvent(monitor: MonitorState, text: string): void {
    if (monitor.status !== "running" || monitor.floodStopped) return;
    const nowMs = this.now();
    monitor.eventTimestamps.push(nowMs);
    monitor.eventTimestamps = monitor.eventTimestamps.filter((ts) => nowMs - ts <= EVENT_WINDOW_MS);
    monitor.eventCount += 1;
    const recentCount = monitor.eventTimestamps.length;

    if (recentCount > this.maxEventsPerMinute * FLOOD_HARD_MULTIPLE) {
      monitor.floodStopped = true;
      monitor.error = `Monitor produced more than ${this.maxEventsPerMinute * FLOOD_HARD_MULTIPLE} events in one minute; stopped. Restart with a tighter filter.`;
      void logBestEffort(this.logger, `flood-stop failed for monitor ${monitor.id}`, () =>
        this.registry.stop(monitor.id),
      );
      return;
    }

    if (recentCount > this.maxEventsPerMinute) {
      if (!monitor.suppressedNoticeSent) {
        monitor.suppressedNoticeSent = true;
        this.sendEvent(
          monitor,
          `Further events are suppressed: this monitor exceeds ${this.maxEventsPerMinute} events per minute. Narrow the filter.`,
        );
      }
      return;
    }

    this.sendEvent(monitor, text);
  }

  private sendEvent(monitor: MonitorState, text: string): void {
    if (this.shuttingDown) return;
    void logBestEffort(this.logger, `monitor event notification failed for ${monitor.id}`, () =>
      this.sendNotification(
        {
          customType: BACKGROUND_NOTIFICATION_TYPE,
          content: buildEventContent(monitor, text),
          display: true,
          details: snapshot(monitor),
        },
        { deliverAs: "followUp", triggerTurn: true },
      ),
    );
  }

  private finalize(monitor: MonitorState, task: BgTaskSnapshot): void {
    if (monitor.finalized) return;
    monitor.finalized = true;
    monitor.unsubscribeChange?.();
    if (monitor.batchTimer !== undefined) {
      clearTimeout(monitor.batchTimer);
      monitor.batchTimer = undefined;
    }
    // A final line with no trailing newline never reaches handleStdout's
    // split; carry it into the batch so it isn't silently dropped.
    const remainder = monitor.lineBuffer.trim();
    monitor.lineBuffer = "";
    if (remainder.length > 0) monitor.batch.push(remainder);
    // Flush a trailing partial batch as one last event so no line is silently dropped.
    if (monitor.batch.length > 0 && !monitor.floodStopped) {
      const text = monitor.batch.join("\n");
      monitor.batch = [];
      this.recordEvent(monitor, text);
    }

    monitor.endTime = task.endTime ?? this.now();
    monitor.exitCode = task.exitCode;

    const { status, note } = this.computeTerminalStatus(monitor, task);
    monitor.status = status;
    if (status === "failed" && !monitor.error) monitor.error = note;

    const finalSnapshot = snapshot(monitor);
    void logBestEffort(this.logger, `monitor terminal publish failed for ${monitor.id}`, () =>
      this.publishTerminalFn(finalSnapshot),
    );

    if (!this.shuttingDown) {
      void logBestEffort(
        this.logger,
        `monitor terminal notification failed for ${monitor.id}`,
        () =>
          this.sendNotification(
            {
              customType: BACKGROUND_NOTIFICATION_TYPE,
              content: buildTerminalContent(monitor, status, note),
              display: true,
              details: finalSnapshot,
            },
            { deliverAs: "followUp", triggerTurn: true },
          ),
      );
    }

    this.pruneOldMonitors();
  }

  private pruneOldMonitors(): void {
    if (this.monitors.size <= this.maxRecentMonitors) return;
    const finished = [...this.monitors.values()]
      .filter((monitor) => monitor.status !== "running")
      .sort((a, b) => (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime));
    while (this.monitors.size > this.maxRecentMonitors && finished.length > 0) {
      const monitor = finished.shift();
      if (monitor) this.monitors.delete(monitor.id);
    }
  }

  private computeTerminalStatus(
    monitor: MonitorState,
    task: BgTaskSnapshot,
  ): { status: MonitorTerminalStatus; note: string } {
    if (monitor.floodStopped) {
      return { status: "failed", note: monitor.error ?? "Monitor stopped: too many events." };
    }
    if (task.killKind === "timeout") {
      return { status: "timeout", note: `Monitor timed out after ${task.timeoutSeconds ?? 0}s.` };
    }
    if (task.killKind === "user" || task.killKind === "shutdown") {
      return { status: "cancelled", note: "Monitor cancelled." };
    }
    if (task.killKind === "output_cap" || task.killKind === "write_error") {
      return { status: "failed", note: task.error ?? "Monitor output failed." };
    }
    const code = task.exitCode ?? null;
    return {
      status: "exited",
      note: `Monitor script exited with code ${code === null ? "null" : code}.`,
    };
  }
}

/**
 * Single-id status lookup shared by bg_status and the bus's "status" op.
 * The registry and MonitorManager prune independently, so a monitor's
 * backing task can disappear from one before the other; this resolves
 * against whichever still has it instead of failing on the wrong one.
 */
export function resolveBackgroundItem(
  registry: BackgroundTaskRegistry,
  monitors: MonitorManager,
  idOrPrefix: string,
): BgTaskSnapshot | MonitorSnapshot {
  try {
    const task = registry.get(idOrPrefix);
    return monitors.get(task.id) ?? task;
  } catch (error) {
    const monitorMatch = monitors.resolve(idOrPrefix);
    if (monitorMatch) return monitorMatch;
    throw error;
  }
}
