import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { plural } from "../../src/core/index.ts";
import type { ScheduleRegistry } from "./registry.ts";

const STATUS_KEY = "@jpi-schedule/prompts";

// pi-internal(raw-sgr-status): jpi-status passes setStatus values through to
// the terminal unmodified, so the label carries its own truecolor SGR.
function colorize(label: string): string {
  return `\x1b[38;2;183;223;255m${label}\x1b[0m`;
}

export interface ScheduleStatusChip {
  /** Call from session_start. */
  start(ctx: ExtensionContext): void;
  /** Call from session_shutdown. */
  stop(ctx: ExtensionContext): void;
}

/**
 * Footer chip showing the scheduled-prompt count. Driven purely by
 * `registry.onChange` — the count only changes on create/stop/restore, so no
 * polling interval is needed.
 */
export function createStatusChip(registry: ScheduleRegistry): ScheduleStatusChip {
  let currentCtx: ExtensionContext | undefined;
  let lastText: string | undefined;

  function recompute(): void {
    const ctx = currentCtx;
    if (!ctx || !ctx.hasUI) return;
    const n = registry.list().length;
    const text = n > 0 ? colorize(`${n} scheduled ${plural(n, "prompt")}`) : undefined;
    if (text === lastText) return;
    lastText = text;
    ctx.ui.setStatus(STATUS_KEY, text);
  }

  // Subscribed once for the process lifetime; start()/stop() only toggle the
  // ctx used to render, so a session switch can't leak duplicate subscriptions.
  registry.onChange(recompute);

  return {
    start(ctx) {
      currentCtx = ctx;
      lastText = undefined;
      recompute();
    },
    stop(ctx) {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      lastText = undefined;
      currentCtx = undefined;
    },
  };
}
