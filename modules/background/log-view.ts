import { open, stat } from "node:fs/promises";

import type {
  ExtensionCommandContext,
  RegisteredCommand,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type KeybindingsManager,
  matchesKey,
  truncateToWidth,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { errorMessage, splitDuration, truncateEnd } from "../../src/core/index.ts";
import { type MonitorManager, type MonitorSnapshot, resolveBackgroundItem } from "./monitor.ts";
import type { BackgroundTaskRegistry, BgTaskSnapshot } from "./registry.ts";

export type Snapshot = BgTaskSnapshot | MonitorSnapshot;

/** Bytes of on-disk output loaded as backlog when the view opens. */
export const SEED_TAIL_BYTES = 256 * 1024;

/**
 * Cap on lines kept in memory. A task's own output cap (20 MiB by default)
 * is far larger than what a scrollback view needs to hold, so the view
 * trims independently to bound render cost.
 */
export const MAX_BUFFER_LINES = 10_000;
const TRIM_MARGIN = 2_000;

const NAME_MAX_CHARS = 52;
const CHROME_LINES = 8;
const MIN_VIEWPORT = 3;

function truncate(text: string, max: number): string {
  return truncateEnd(text.trim(), max);
}

function isMonitorSnapshot(item: Snapshot): item is MonitorSnapshot {
  return item.kind === "monitor";
}

/** The picker's and header's idea of a row's display name: task name, or monitor description. */
function titleOf(item: Snapshot): string {
  return isMonitorSnapshot(item) ? item.description : item.name;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const { hours, minutes, seconds } = splitDuration(totalSeconds * 1000);
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function statusGlyph(status: Snapshot["status"]): string {
  switch (status) {
    case "running":
      return "●";
    case "completed":
    case "exited":
      return "✓";
    case "failed":
      return "✗";
    case "killed":
    case "cancelled":
      return "⏹";
    case "timeout":
      return "⏱";
    default:
      return "?";
  }
}

/** One row for the `/bg` picker. Deterministic and plain text — no ANSI, so it's safe for the select() list. */
export function formatPickerRow(item: Snapshot, now: number): string {
  const glyph = statusGlyph(item.status);
  const tag = isMonitorSnapshot(item) ? "[monitor] " : "";
  const title = truncate(titleOf(item), NAME_MAX_CHARS);
  const runtime = formatDuration((item.endTime ?? now) - item.startTime);
  return `${glyph} ${tag}${title}  ·  ${runtime}  ·  ${item.id}`;
}

function listAllItems(registry: BackgroundTaskRegistry, monitors: MonitorManager): Snapshot[] {
  const tasks = registry.list().filter((task) => !monitors.has(task.id));
  return [...tasks, ...monitors.list()];
}

async function readTailBytes(filePath: string, maxBytes: number): Promise<string> {
  try {
    const stats = await stat(filePath);
    const bytesToRead = Math.min(stats.size, maxBytes);
    if (bytesToRead === 0) return "";
    const file = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const position = Math.max(0, stats.size - bytesToRead);
      const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return "";
  }
}

export type OutputLineSource = "seed" | "stdout" | "stderr";

export interface OutputLine {
  readonly text: string;
  readonly source: OutputLineSource;
}

/**
 * Live-tailing line buffer: a plain seed backlog followed by source-tagged
 * chunks appended as they arrive. The output file records only bytes, not
 * which stream they came from, so only lines built from append() carry a
 * real stdout/stderr tag — seeded backlog is always "seed" (rendered plain).
 */
export class OutputBuffer {
  private lines: OutputLine[] = [];
  private pendingText = "";
  private pendingSource: OutputLineSource = "seed";
  /** Bumped on every mutation, so a caller can cache its own rendering of `getLines()`. */
  private version = 0;

  /** Load the on-disk backlog as untagged history. Call at most once, before any append(). */
  seed(text: string): void {
    if (text.length === 0) return;
    this.version++;
    const parts = text.split("\n");
    const trailing = parts.pop() ?? "";
    for (const part of parts) this.pushLine(part, "seed");
    this.pendingText = trailing;
    this.pendingSource = "seed";
  }

  append(chunk: string, source: "stdout" | "stderr"): void {
    if (chunk.length === 0) return;
    this.version++;
    const parts = chunk.split("\n");
    const first = parts.shift() ?? "";
    this.pendingText += first;
    this.pendingSource = source;
    if (parts.length === 0) return;

    this.pushLine(this.pendingText, this.pendingSource);
    for (let i = 0; i < parts.length - 1; i++) this.pushLine(parts[i]!, source);
    this.pendingText = parts[parts.length - 1] ?? "";
    this.pendingSource = source;
  }

  private pushLine(text: string, source: OutputLineSource): void {
    this.lines.push({ text, source });
    if (this.lines.length > MAX_BUFFER_LINES + TRIM_MARGIN) {
      this.lines.splice(0, this.lines.length - MAX_BUFFER_LINES);
    }
  }

  /** Every completed line, plus the in-progress tail (if any) as a final entry. */
  getLines(): OutputLine[] {
    if (this.pendingText.length === 0) return this.lines;
    return [...this.lines, { text: this.pendingText, source: this.pendingSource }];
  }

  /** Bumped by `seed()` and `append()` — the only two mutators — whenever `getLines()`'s result could change. */
  getVersion(): number {
    return this.version;
  }
}

/** SGR-dim + theme error color: the file records bytes, not stream source, so only live stderr chunks get this treatment. */
function tintStderr(theme: Theme, text: string): string {
  return `\x1b[2m${theme.fg("error", text)}\x1b[22m`;
}

function statusLabel(item: Snapshot): string {
  const parts = [isMonitorSnapshot(item) ? "[monitor] " : "", item.status];
  return parts.join("");
}

class LogViewer implements Component {
  private item: Snapshot;
  private readonly buffer = new OutputBuffer();
  private scrollOffset = 0;
  private autoScroll = true;
  private closed = false;
  private lastWidth = 80;
  private unsubscribeOutput: (() => void) | undefined;
  private unsubscribeChange: (() => void) | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  /** Cache for `buildBodyLines`, valid as long as the buffer hasn't mutated since. */
  private bodyLinesCache: { width: number; version: number; lines: string[] } | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: undefined) => void,
    private readonly registry: BackgroundTaskRegistry,
    private readonly monitors: MonitorManager,
    private readonly taskId: string,
    seedText: string,
    initial: Snapshot,
  ) {
    this.item = initial;
    this.buffer.seed(seedText);
    this.unsubscribeOutput = this.subscribeOutput();
    this.unsubscribeChange = this.registry.onChange(() => this.refresh());
    this.startTickIfRunning();
  }

  private subscribeOutput(): (() => void) | undefined {
    try {
      return this.registry.onOutput(this.taskId, (chunk, source) => {
        if (this.closed) return;
        this.buffer.append(chunk, source);
        this.tui.requestRender();
      });
    } catch {
      // The task already fell out of the registry's finished-task history;
      // the seeded backlog is all there is to show.
      return undefined;
    }
  }

  /** Refresh the header from the registry/monitor's latest snapshot. Runs on every registry change, not just this task's. */
  private refresh(): void {
    if (this.closed) return;
    let next: Snapshot;
    try {
      next = resolveBackgroundItem(this.registry, this.monitors, this.taskId);
    } catch {
      return;
    }
    const wasRunning = this.item.status === "running";
    this.item = next;
    if (wasRunning && next.status !== "running") this.stopTick();
    this.tui.requestRender();
  }

  private startTickIfRunning(): void {
    if (this.item.status !== "running") return;
    this.tickTimer = setInterval(() => {
      if (!this.closed) this.tui.requestRender();
    }, 1000);
    this.tickTimer.unref?.();
  }

  private stopTick(): void {
    if (this.tickTimer === undefined) return;
    clearInterval(this.tickTimer);
    this.tickTimer = undefined;
  }

  private viewportHeight(): number {
    return Math.max(MIN_VIEWPORT, this.tui.terminal.rows - CHROME_LINES);
  }

  private buildBodyLines(width: number): string[] {
    const version = this.buffer.getVersion();
    const cache = this.bodyLinesCache;
    if (cache && cache.width === width && cache.version === version) {
      return cache.lines;
    }

    const out: string[] = [];
    for (const entry of this.buffer.getLines()) {
      const wrapped = wrapTextWithAnsi(entry.text, width);
      const rendered =
        entry.source === "stderr" ? wrapped.map((l) => tintStderr(this.theme, l)) : wrapped;
      if (rendered.length === 0) out.push("");
      else out.push(...rendered);
    }
    this.bodyLinesCache = { width, version, lines: out };
    return out;
  }

  private scrollUp(data: string): boolean {
    return (
      this.keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, "up") ||
      matchesKey(data, "k")
    );
  }

  private scrollDown(data: string): boolean {
    return (
      this.keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, "down") ||
      matchesKey(data, "j")
    );
  }

  private pageUp(data: string): boolean {
    return this.keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, "pageUp");
  }

  private pageDown(data: string): boolean {
    return this.keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, "pageDown");
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.close();
      return;
    }

    const contentLines = this.buildBodyLines(this.lastWidth);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    } else {
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (width < 10) return [];
    const th = this.theme;
    this.lastWidth = width;
    const line = (content: string) => truncateToWidth(content, width, "...", true);
    const hr = th.fg("border", "─".repeat(width));
    const lines: string[] = [];

    const now = Date.now();
    const elapsed = (this.item.endTime ?? now) - this.item.startTime;
    const commandLine = (this.item.command.split("\n")[0] ?? this.item.command).trim();

    const metaParts = [
      `status: ${statusLabel(this.item)}`,
      `runtime: ${formatDuration(elapsed)}`,
      `id: ${this.item.id}`,
    ];
    if (this.item.exitCode !== undefined && this.item.exitCode !== null) {
      metaParts.push(`exit: ${this.item.exitCode}`);
    }

    lines.push(hr);
    lines.push(line(`${statusGlyph(this.item.status)} ${th.bold(commandLine)}`));
    lines.push(line(th.fg("dim", metaParts.join("  ·  "))));
    lines.push(line(th.fg("dim", `output: ${this.item.outputPath}`)));
    lines.push(hr);

    const contentLines = this.buildBodyLines(width);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (this.autoScroll) this.scrollOffset = maxScroll;
    const start = Math.min(this.scrollOffset, maxScroll);
    const visible =
      contentLines.length > 0
        ? contentLines.slice(start, start + viewportHeight)
        : ["(no output yet)"];
    for (let i = 0; i < viewportHeight; i++) lines.push(line(visible[i] ?? ""));

    lines.push(hr);
    const followLabel = this.autoScroll
      ? th.fg("accent", "● live")
      : th.fg("dim", "○ paused, End to resume");
    const hint = th.fg("dim", "↑↓ scroll · PgUp/PgDn · Home/End · Esc close");
    const gap = Math.max(1, width - visibleWidth(followLabel) - visibleWidth(hint));
    lines.push(line(followLabel + " ".repeat(gap) + hint));
    lines.push(hr);

    return lines;
  }

  invalidate(): void {
    this.bodyLinesCache = undefined;
  }

  private close(): void {
    this.dispose();
    this.done(undefined);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeOutput?.();
    this.unsubscribeChange?.();
    this.stopTick();
  }
}

async function openLogView(
  ctx: ExtensionCommandContext,
  registry: BackgroundTaskRegistry,
  monitors: MonitorManager,
  item: Snapshot,
): Promise<void> {
  await ctx.ui.custom<undefined>(
    async (tui, theme, keybindings, done) => {
      const seedText = await readTailBytes(item.outputPath, SEED_TAIL_BYTES);
      return new LogViewer(
        tui,
        theme,
        keybindings,
        done,
        registry,
        monitors,
        item.id,
        seedText,
        item,
      );
    },
    {
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
    },
  );
}

export interface BgCommandDeps {
  readonly registry: BackgroundTaskRegistry;
  readonly monitors: MonitorManager;
}

/** `/bg` command: pick a background task or monitor (or resolve an id prefix directly) and open its live log view. */
export function createBgCommand(
  deps: BgCommandDeps,
): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  const { registry, monitors } = deps;
  return {
    description: "Open a live view of a background task's or monitor's output",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        ctx.ui.notify("/bg needs the interactive TUI.", "info");
        return;
      }

      const prefix = args.trim();
      if (prefix) {
        let item: Snapshot;
        try {
          item = resolveBackgroundItem(registry, monitors, prefix);
        } catch (error) {
          ctx.ui.notify(errorMessage(error), "error");
          return;
        }
        await openLogView(ctx, registry, monitors, item);
        return;
      }

      const items = listAllItems(registry, monitors);
      if (items.length === 0) {
        ctx.ui.notify("No background tasks", "info");
        return;
      }

      const now = Date.now();
      const rowsByLabel = new Map<string, Snapshot>();
      const rows: string[] = [];
      for (const item of items) {
        const row = formatPickerRow(item, now);
        rowsByLabel.set(row, item);
        rows.push(row);
      }

      const choice = await ctx.ui.select("Background tasks", rows);
      if (!choice) return;
      const picked = rowsByLabel.get(choice);
      if (!picked) return;

      await openLogView(ctx, registry, monitors, picked);
    },
  };
}
