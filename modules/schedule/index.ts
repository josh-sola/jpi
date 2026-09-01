import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  SCHEDULES_CHANNEL,
  SCHEDULES_SCHEMA,
  Store,
  type Config,
  type WithEnabled,
} from "../../src/core/index.ts";
import { getAgentDirectory } from "../../src/pi/index.ts";
import type { scheduleSchema } from "./config.ts";
import { SCHEDULE_NOTIFICATION_TYPE, renderScheduleNotification } from "./notification-renderer.ts";
import { ScheduleOverlay, SCHEDULE_OVERLAY_MAX_HEIGHT_PCT } from "./overlay.ts";
import { ScheduleRegistry, type CronFactory, type ScheduleNotificationSender } from "./registry.ts";
import { loadScheduleFile, scheduleFileName, sweepStaleScheduleFiles } from "./store.ts";
import { createScheduleTools } from "./tools.ts";
import { createStatusChip } from "./ui.ts";

/** Stale per-session schedule files older than this are swept on startup. */
const SWEEP_TTL_DAYS = 30;

export type ScheduleExtensionOptions = {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  now?: () => number;
  makeId?: () => string;
  sendNotification?: ScheduleNotificationSender;
  createCron?: CronFactory;
};

export interface RegisteredSchedule {
  readonly registry: ScheduleRegistry;
}

/** Wires the registry, tools, status chip, and /schedule overlay into Pi's lifecycle. */
export function registerSchedule(
  pi: ExtensionAPI,
  config: Config<WithEnabled<typeof scheduleSchema>>,
  opts: ScheduleExtensionOptions = {},
): RegisteredSchedule {
  const store = new Store("schedule", opts.env, opts.homeDirectory);
  const scheduleRoot = join(getAgentDirectory(opts.env, opts.homeDirectory), "jpi", "schedule");
  const sendNotification: ScheduleNotificationSender =
    opts.sendNotification ??
    ((notificationMessage, options) => pi.sendMessage(notificationMessage, options));

  const registry = new ScheduleRegistry({
    store,
    sendNotification,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.makeId ? { makeId: opts.makeId } : {}),
    ...(opts.createCron ? { createCron: opts.createCron } : {}),
  });

  const chip = createStatusChip(registry);
  let component: ScheduleOverlay | undefined;

  function emitSchedules(): void {
    pi.events.emit(SCHEDULES_CHANNEL, {
      schema: SCHEDULES_SCHEMA,
      schedules: registry.list().map((schedule) => ({ id: schedule.id })),
    });
  }

  // Subscribed once for the process lifetime, same as the status chip.
  registry.onChange(emitSchedules);

  for (const tool of createScheduleTools({ registry })) pi.registerTool(tool);
  pi.registerMessageRenderer(SCHEDULE_NOTIFICATION_TYPE, renderScheduleNotification);

  pi.registerCommand("schedule", {
    description: "List scheduled prompts and stop them",
    handler: (_args, cmdCtx) => {
      // Single-instance reuse: a second /schedule while one is already open
      // is a no-op — the panel already renders live off the registry.
      if (!component && cmdCtx.hasUI) {
        void cmdCtx.ui
          .custom<undefined>(
            (tui, theme, keybindings, done) => {
              const overlay = new ScheduleOverlay(tui, theme, keybindings, registry, (result) => {
                component = undefined;
                done(result);
              });
              component = overlay;
              return overlay;
            },
            {
              overlay: true,
              overlayOptions: {
                anchor: "right-center",
                width: "38%",
                minWidth: 44,
                maxHeight: `${SCHEDULE_OVERLAY_MAX_HEIGHT_PCT}%`,
                margin: { right: 1, top: 1, bottom: 1 },
                visible: (width) => width >= 100,
              },
            },
          )
          .catch(() => {});
      }
      // Pi awaits command handlers on the TUI submit path, so this must
      // return without awaiting the overlay's close promise.
      return Promise.resolve();
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    registry.reset();
    const sessionId = ctx.sessionManager.getSessionId();
    registry.setSession(sessionId);

    const { value } = await config.load();
    registry.configure({ maxSchedules: value.maxSchedules });

    const persisted = await loadScheduleFile(store, sessionId);
    registry.restore(persisted);

    // restore()'s onChange fire can race a subscriber that hasn't wired up
    // yet (jpi-title subscribes during its own session_start handler), so
    // re-emit once more on the next turn to guarantee it sees the set.
    setTimeout(emitSchedules, 0);

    chip.start(ctx);

    const now = opts.now ?? Date.now;
    await sweepStaleScheduleFiles(
      scheduleRoot,
      SWEEP_TTL_DAYS,
      now(),
      store.path(scheduleFileName(sessionId)),
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    chip.stop(ctx);
    registry.reset();
  });

  return { registry };
}
