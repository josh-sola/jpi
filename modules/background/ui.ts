import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { MonitorManager } from "./monitor.ts";
import type { BackgroundTaskRegistry } from "./registry.ts";

const TASKS_STATUS_KEY = "@jpi-background/tasks";
const MONITORS_STATUS_KEY = "@jpi-background/monitors";
const REFRESH_INTERVAL_MS = 1000;

function colorize(label: string): string {
  return `\x1b[38;2;183;223;255m${label}\x1b[0m`;
}

export interface StatusChip {
  /** Call from session_start. */
  start(ctx: ExtensionContext): void;
  /** Call from session_shutdown. */
  stop(ctx: ExtensionContext): void;
}

export interface StatusChipOptions {
  readonly refreshIntervalMs?: number;
}

/**
 * Footer chips showing running-task and running-monitor counts under
 * separate status keys, refreshed on every registry change plus a 1s tick
 * while anything is running. Each chip hides when its count is zero.
 */
export function createStatusChip(
  registry: BackgroundTaskRegistry,
  monitors: MonitorManager,
  options: StatusChipOptions = {},
): StatusChip {
  const refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  let currentCtx: ExtensionContext | undefined;
  let interval: NodeJS.Timeout | undefined;

  function anyRunning(): boolean {
    return (
      registry.list().some((task) => task.status === "running") ||
      monitors.list().some((monitor) => monitor.status === "running")
    );
  }

  function manageInterval(): void {
    if (anyRunning()) {
      if (interval === undefined) {
        interval = setInterval(recompute, refreshIntervalMs);
        interval.unref?.();
      }
    } else if (interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
  }

  function recompute(): void {
    manageInterval();
    const ctx = currentCtx;
    if (!ctx || !ctx.hasUI) return;

    const tasks = registry.list().filter((task) => !monitors.has(task.id));
    const runningTasks = tasks.filter((task) => task.status === "running").length;
    const runningMonitors = monitors
      .list()
      .filter((monitor) => monitor.status === "running").length;

    ctx.ui.setStatus(
      TASKS_STATUS_KEY,
      runningTasks > 0
        ? colorize(`${runningTasks} ${runningTasks === 1 ? "task" : "tasks"}`)
        : undefined,
    );
    ctx.ui.setStatus(
      MONITORS_STATUS_KEY,
      runningMonitors > 0
        ? colorize(`${runningMonitors} ${runningMonitors === 1 ? "monitor" : "monitors"}`)
        : undefined,
    );
  }

  // Subscribed once for the process lifetime; start()/stop() only toggle the
  // interval and the ctx used to render, so a session switch can't leak
  // duplicate subscriptions.
  registry.onChange(recompute);

  return {
    start(ctx) {
      currentCtx = ctx;
      recompute();
    },
    stop(ctx) {
      if (interval !== undefined) {
        clearInterval(interval);
        interval = undefined;
      }
      if (ctx.hasUI) {
        ctx.ui.setStatus(TASKS_STATUS_KEY, undefined);
        ctx.ui.setStatus(MONITORS_STATUS_KEY, undefined);
      }
      currentCtx = undefined;
    },
  };
}
