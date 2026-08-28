import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type KeyId } from "@earendil-works/pi-tui";

import { getAgentDirectory, Store, type Config, type WithEnabled } from "../../src/core/index.ts";
import { createBackgroundBus } from "./bus.ts";
import { backgroundSchema } from "./config.ts";
import { DetachRegistry } from "./detach.ts";
import { resolveKeyId } from "./key-id.ts";
import { createBgCommand } from "./log-view.ts";
import { MonitorManager } from "./monitor.ts";
import {
  BACKGROUND_NOTIFICATION_TYPE,
  renderBackgroundNotification,
} from "./notification-renderer.ts";
import {
  BackgroundTaskRegistry,
  type BackgroundSpawnFn,
  type BgTaskSnapshot,
  type CompletionNotificationSender,
  type TaskRunContext,
} from "./registry.ts";
import type { InstallRunner } from "./runner.ts";
import { sweepStaleSessions } from "./sweep.ts";
import { createBackgroundTools, createRunTool } from "./tools.ts";
import { createStatusChip } from "./ui.ts";

const DEFAULT_RUN_SHORTCUT = "ctrl+b";

export type BackgroundExtensionOptions = {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  now?: () => number;
  makeTaskId?: () => string;
  spawn?: BackgroundSpawnFn;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sendNotification?: CompletionNotificationSender;
  /** Injectable for tests; the run tool's default stage id generator otherwise. */
  makeStageId?: () => string;
  /** Injectable for tests; runs `pnpm install` for a typescript stage otherwise. */
  runInstall?: InstallRunner;
};

export interface RegisteredBackground {
  readonly registry: BackgroundTaskRegistry;
  readonly monitors: MonitorManager;
}

/** Wires the registry, monitors, bus, footer chip, and tools into Pi's lifecycle. */
export function registerBackground(
  pi: ExtensionAPI,
  config: Config<WithEnabled<typeof backgroundSchema>>,
  opts: BackgroundExtensionOptions = {},
): RegisteredBackground {
  const store = new Store("background", opts.env, opts.homeDirectory);
  const backgroundRoot = join(getAgentDirectory(opts.env, opts.homeDirectory), "jpi", "background");
  const sendNotification: CompletionNotificationSender =
    opts.sendNotification ??
    ((notificationMessage, options) => pi.sendMessage(notificationMessage, options));
  const bus = createBackgroundBus(pi.events);

  // `monitors` is assigned right after construction, before any task can
  // start or finish, so this callback never sees it undefined in practice.
  let monitors: MonitorManager | undefined;
  const registry = new BackgroundTaskRegistry({
    store,
    sendNotification,
    publishTerminal: (task) => {
      if (monitors?.has(task.id)) return; // the monitor's own richer snapshot publishes instead
      bus.publishTerminal(task);
    },
    ...(opts.spawn ? { spawn: opts.spawn } : {}),
    ...(opts.killProcess ? { killProcess: opts.killProcess } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.makeTaskId ? { makeTaskId: opts.makeTaskId } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  monitors = new MonitorManager({
    registry,
    sendNotification,
    publishTerminal: (monitor) => bus.publishTerminal(monitor),
    ...(opts.now ? { now: opts.now } : {}),
  });

  let currentCtx: TaskRunContext | undefined;
  bus.attach(registry, monitors, () => currentCtx);

  const chip = createStatusChip(registry, monitors);
  const detach = new DetachRegistry();
  let terminalInputUnsub: (() => void) | undefined;

  for (const tool of createBackgroundTools({ registry, monitors })) pi.registerTool(tool);
  pi.registerCommand("bg", createBgCommand({ registry, monitors }));
  pi.registerMessageRenderer(BACKGROUND_NOTIFICATION_TYPE, renderBackgroundNotification);

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
    registry.reset();
    monitors?.reset();
    const { value } = await config.load();
    registry.configure({
      maxOutputBytes: value.maxOutputBytes,
      defaultTimeoutSeconds: value.defaultTimeoutSeconds,
    });
    monitors?.configure({
      defaultTimeoutSeconds: value.monitorTimeoutSeconds,
      maxEventsPerMinute: value.maxMonitorEventsPerMinute,
    });
    chip.start(ctx);

    if (value.runEnabled) {
      pi.registerTool(
        createRunTool({
          registry,
          detach,
          defaultTimeoutSeconds:
            value.runDefaultTimeoutSeconds > 0 ? value.runDefaultTimeoutSeconds : undefined,
          ...(opts.makeStageId ? { makeStageId: opts.makeStageId } : {}),
          ...(opts.runInstall ? { runInstall: opts.runInstall } : {}),
        }),
      );
    }

    // Re-registered on every session_start (reload/new/resume/fork) so a
    // config change to the shortcut takes effect without leaking listeners.
    terminalInputUnsub?.();
    terminalInputUnsub = undefined;
    if (ctx.hasUI) {
      const shortcut = resolveKeyId(value.runBackgroundShortcut, DEFAULT_RUN_SHORTCUT) as KeyId;
      terminalInputUnsub = ctx.ui.onTerminalInput((data) => {
        if (isKeyRelease(data)) return undefined;
        if (!matchesKey(data, shortcut)) return undefined;
        // Only consumed while a foreground `run` is actually awaiting, so an
        // idle ctrl+b falls through — this is also what keeps it from
        // colliding with jpi-subagents' own ctrl+b, whose handler likewise
        // only acts while a subagent is blocking.
        if (!detach.hasActive()) return undefined;
        detach.detachAll();
        return { consume: true };
      });
    }

    const now = opts.now ?? Date.now;
    await sweepStaleSessions(
      backgroundRoot,
      value.ttlDays,
      now(),
      registry.sessionDirPath(currentCtx),
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    monitors?.beginShutdown();
    chip.stop(ctx);
    terminalInputUnsub?.();
    terminalInputUnsub = undefined;
    await registry.shutdown();
  });

  return { registry, monitors };
}

export type { BgTaskSnapshot };
