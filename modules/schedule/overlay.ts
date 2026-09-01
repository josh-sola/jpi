import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";

import { BorderBox, plural, truncateEnd } from "../../src/core/index.ts";
import { computeOverlayMaxHeightRows } from "../../src/pi/index.ts";
import type { ScheduleRegistry, ScheduleSnapshot } from "./registry.ts";

/**
 * Overlay maxHeight, as a percentage of terminal rows. Exported so the
 * `overlayOptions.maxHeight` passed to `ctx.ui.custom()` and this
 * component's own viewport math read the same number and never drift apart.
 */
export const SCHEDULE_OVERLAY_MAX_HEIGHT_PCT = 80;

/** Top border + header + divider + footer + bottom border. */
const CHROME_LINES = 5;
const MIN_VIEWPORT = 3;

/** Defers rendering to a callback so BorderBox's children stay simple, width-fed adapters. */
class CallbackLines implements Component {
  constructor(private readonly build: (width: number) => string[]) {}

  invalidate(): void {
    // No-op: the callback reads ScheduleOverlay's live state on every render() call.
  }

  render(width: number): string[] {
    return this.build(width);
  }
}

/** `in 5m` / `in 2h` / `due` — coarse relative time for a next-run column. */
function relativeTime(ms: number | undefined, now: number): string {
  if (ms === undefined) return "—";
  const diff = ms - now;
  if (diff <= 0) return "due";
  const seconds = Math.round(diff / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

/**
 * The right-side `/schedule` panel: one row per scheduled prompt, live off
 * `registry.list()` — every render reads the registry directly, so a firing
 * or a tool-driven stop shows up without any external `setState` call.
 */
export class ScheduleOverlay implements Component {
  private selected = 0;
  private readonly border: BorderBox;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly registry: ScheduleRegistry,
    private readonly done: (result: undefined) => void,
  ) {
    this.border = new BorderBox(
      theme,
      [
        new CallbackLines((width) => [this.buildHeader(width)]),
        new CallbackLines((width) => this.buildRows(width)),
        new CallbackLines((width) => [this.buildFooter(width)]),
      ],
      0,
      "schedule",
    );
    this.unsubscribe = this.registry.onChange(() => {
      this.clampSelection();
      this.tui.requestRender();
    });
  }

  render(width: number): string[] {
    return this.border.render(width);
  }

  invalidate(): void {
    this.border.invalidate();
  }

  // pi disposes a closed overlay's component; never reuse one after this fires.
  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }

    const rows = this.registry.list();

    if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
      this.selected = rows.length === 0 ? 0 : Math.min(rows.length - 1, this.selected + 1);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
      this.selected = Math.max(0, this.selected - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "x") || matchesKey(data, "d")) {
      const target = rows[this.selected];
      if (target) {
        try {
          this.registry.stop(target.id);
        } catch {
          // Best effort: a race with the schedule firing or being stopped
          // elsewhere (e.g. the tool) is not fatal — the next onChange/render
          // reflects whatever state won.
        }
        this.clampSelection();
        this.tui.requestRender();
      }
    }
  }

  private clampSelection(): void {
    const max = this.registry.list().length - 1;
    if (this.selected > max) this.selected = Math.max(0, max);
    if (this.selected < 0) this.selected = 0;
  }

  private buildHeader(width: number): string {
    const n = this.registry.list().length;
    const text = `${n} scheduled ${plural(n, "prompt")}`;
    return truncateToWidth(this.theme.fg("muted", text), width, "…", true);
  }

  private buildRows(width: number): string[] {
    const rows = this.registry.list();
    if (rows.length === 0) {
      return [truncateToWidth(this.theme.fg("dim", "No scheduled prompts."), width, "…", true)];
    }

    const now = Date.now();
    const viewport = this.viewportHeight();
    const visible = Math.min(viewport, rows.length);
    const start =
      this.selected < visible ? 0 : Math.min(rows.length - visible, this.selected - visible + 1);
    const hiddenBelow = rows.length - (start + visible);

    const lines: string[] = [];
    if (start > 0)
      lines.push(truncateToWidth(this.theme.fg("dim", `↑ ${start} more`), width, "…", true));
    for (let index = start; index < start + visible; index++) {
      lines.push(this.renderRow(rows[index]!, index, width, now));
    }
    if (hiddenBelow > 0) {
      lines.push(truncateToWidth(this.theme.fg("dim", `↓ ${hiddenBelow} more`), width, "…", true));
    }
    return lines;
  }

  private renderRow(row: ScheduleSnapshot, index: number, width: number, now: number): string {
    const marker =
      index === this.selected ? this.theme.fg("accent", "●") : this.theme.fg("dim", "○");
    const next = relativeTime(row.nextRun, now);
    const prompt = truncateEnd(row.prompt, Math.max(0, width - 30));
    const line = `${marker} ${row.id}  ${row.cronExpression}  ${next}  ${prompt}`;
    return truncateToWidth(line, width, "…", true);
  }

  private buildFooter(width: number): string {
    return truncateToWidth(
      this.theme.fg("dim", "↑↓/jk select · x/d stop · esc close"),
      width,
      "…",
      true,
    );
  }

  /** Mirrors the overlay's own `maxHeight` percentage, minus the fixed chrome around the rows. */
  private viewportHeight(): number {
    const maxRows = computeOverlayMaxHeightRows(
      this.tui.terminal.rows,
      SCHEDULE_OVERLAY_MAX_HEIGHT_PCT,
    );
    return Math.max(MIN_VIEWPORT, maxRows - CHROME_LINES);
  }
}
