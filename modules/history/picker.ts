import { basename } from "node:path";

import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { PromptEntry } from "./store.ts";

const MAX_VISIBLE = 12;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

export function formatRelativeTime(timestamp: string, now: number = Date.now()): string {
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return "";

  const diff = Math.max(0, now - then);
  if (diff < MINUTE_MS) return "just now";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h ago`;
  if (diff < MONTH_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
  if (diff < YEAR_MS) return `${Math.floor(diff / MONTH_MS)}mo ago`;
  return `${Math.floor(diff / YEAR_MS)}y ago`;
}

export interface PromptRow {
  /** First line of the prompt, trimmed, not truncated — truncation is width-aware at render time. */
  primary: string;
  time: string;
  project: string;
}

export function formatPromptRow(entry: PromptEntry, now: number = Date.now()): PromptRow {
  const firstLine = entry.text.split("\n", 1)[0]?.trim() ?? "";
  const project = entry.cwd ? basename(entry.cwd) : "unknown";
  return { primary: firstLine, time: formatRelativeTime(entry.timestamp, now), project };
}

/** Entries are assumed newest first; an empty query keeps that order. */
export function rankPrompts(entries: readonly PromptEntry[], query: string): PromptEntry[] {
  const trimmed = query.trim();
  if (!trimmed) return [...entries];
  return fuzzyFilter([...entries], trimmed, (entry) => entry.text);
}

/**
 * Greedy in-order case-insensitive character walk, mirroring pi-tui's
 * fuzzyMatch loop (minus its letter/digit-swap fallback). Tokens are
 * whitespace/slash separated, same as fuzzyFilter; a token that doesn't
 * fully match contributes no indices.
 */
export function matchIndices(query: string, text: string): Set<number> {
  const indices = new Set<number>();
  const trimmed = query.trim();
  if (!trimmed) return indices;

  const textLower = text.toLowerCase();
  const tokens = trimmed.split(/[\s/]+/).filter((token) => token.length > 0);

  for (const token of tokens) {
    const tokenLower = token.toLowerCase();
    const tokenIndices: number[] = [];
    let tokenIndex = 0;
    for (let i = 0; i < textLower.length && tokenIndex < tokenLower.length; i++) {
      if (textLower[i] === tokenLower[tokenIndex]) {
        tokenIndices.push(i);
        tokenIndex++;
      }
    }
    if (tokenIndex === tokenLower.length) {
      for (const index of tokenIndices) indices.add(index);
    }
  }

  return indices;
}

export interface RowMeta {
  time: string;
  project: string;
}

const ROW_PREFIX = "  ";
const ROW_META_GAP = 2;
const MIN_PRIMARY_WITH_META = 20;

/** How much width the primary column gets, and the plain meta text (or undefined if it's too tight to show). */
function layoutRowBudget(
  width: number,
  meta: RowMeta | undefined,
): { primaryWidth: number; metaText: string | undefined } {
  const available = Math.max(0, width - visibleWidth(ROW_PREFIX));
  if (!meta) return { primaryWidth: available, metaText: undefined };

  const metaText = `${meta.time} · ${meta.project}`;
  const primaryWidth = available - visibleWidth(metaText) - ROW_META_GAP;
  if (primaryWidth < MIN_PRIMARY_WITH_META) {
    return { primaryWidth: available, metaText: undefined };
  }
  return { primaryWidth, metaText };
}

function styleMatchedRuns(text: string, matched: ReadonlySet<number>, theme: Theme): string {
  if (matched.size === 0) return text;

  let out = "";
  let i = 0;
  while (i < text.length) {
    let j = i;
    if (matched.has(i)) {
      while (j < text.length && matched.has(j)) j++;
      // Bold matters here: searchMatchText falls back to the plain text
      // color on themes that don't define it, and bold is the only signal
      // left to mark a match on those themes.
      out += theme.bold(theme.fg("searchMatchText", text.slice(i, j)));
    } else {
      while (j < text.length && !matched.has(j)) j++;
      out += text.slice(i, j);
    }
    i = j;
  }
  return out;
}

function styleMeta(meta: RowMeta, theme: Theme): string {
  return `${theme.fg("dim", meta.time)}${theme.fg("muted", ` · ${meta.project}`)}`;
}

/**
 * Assembles one already-styled, already-truncated row line at exactly
 * `width` columns (when meta is shown, or when selected — an unselected row
 * with no meta is left its natural, unpadded length).
 */
export function renderPromptRow(
  width: number,
  primary: string,
  meta: RowMeta | undefined,
  selected: boolean,
  matched: ReadonlySet<number>,
  theme: Theme,
): string {
  const safeWidth = Math.max(0, width);
  const { primaryWidth, metaText } = layoutRowBudget(safeWidth, meta);
  const truncateWidth = Math.max(0, primaryWidth);
  const truncated = truncateToWidth(primary, truncateWidth, "…");
  const hasEllipsis = truncated.endsWith("…") && truncated !== primary;
  const visiblePrimary = hasEllipsis ? truncated.slice(0, -1) : truncated;
  const styledPrimary = styleMatchedRuns(visiblePrimary, matched, theme) + (hasEllipsis ? "…" : "");

  const prefixWidth = visibleWidth(ROW_PREFIX);
  let plainWidth = prefixWidth + visibleWidth(truncated);
  let line = `${ROW_PREFIX}${styledPrimary}`;

  if (metaText !== undefined && meta) {
    const metaWidth = visibleWidth(metaText);
    const gap = Math.max(ROW_META_GAP, safeWidth - plainWidth - metaWidth);
    line += " ".repeat(gap) + styleMeta(meta, theme);
    plainWidth += gap + metaWidth;
  }

  if (!selected) return line;

  const padCount = Math.max(0, safeWidth - plainWidth);
  return theme.bg("selectedBg", `${line}${" ".repeat(padCount)}`);
}

/**
 * Width-aware list of prompt rows. PromptPicker mutates `entries`,
 * `selectedIndex`, and `query` directly and calls invalidate() on itself —
 * this view has no independent redraw scheduling of its own.
 */
export class PromptListView implements Component {
  entries: readonly PromptEntry[] = [];
  selectedIndex = 0;
  query = "";

  constructor(private readonly theme: Theme) {}

  invalidate(): void {
    // No-op: the picker rebuilds this view's state on every keystroke and
    // calls invalidate() on itself, which is what actually schedules a redraw.
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);

    if (this.entries.length === 0) {
      return [this.theme.fg("muted", "  No matching prompts")];
    }

    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.entries.length - MAX_VISIBLE),
    );
    const end = Math.min(start + MAX_VISIBLE, this.entries.length);
    const trimmedQuery = this.query.trim();

    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const entry = this.entries[i];
      if (!entry) continue;
      const row = formatPromptRow(entry);
      const meta: RowMeta = { time: row.time, project: row.project };

      const { primaryWidth } = layoutRowBudget(safeWidth, meta);
      const truncateWidth = Math.max(0, primaryWidth);
      const truncated = truncateToWidth(row.primary, truncateWidth, "…");
      const hasEllipsis = truncated.endsWith("…") && truncated !== row.primary;
      const visiblePrimary = hasEllipsis ? truncated.slice(0, -1) : truncated;
      const matched = trimmedQuery ? matchIndices(trimmedQuery, visiblePrimary) : new Set<number>();

      lines.push(
        renderPromptRow(
          safeWidth,
          row.primary,
          meta,
          i === this.selectedIndex,
          matched,
          this.theme,
        ),
      );
    }

    return lines;
  }
}

const INPUT_GLYPH_WIDTH = 2;

/** Prefixes an accent glyph onto the Input's first (only) rendered line. Purely visual — focus is forwarded to the Input directly by PromptPicker, not through this wrapper. */
class InputLine implements Component {
  constructor(
    private readonly input: Input,
    private readonly glyph: string,
  ) {}

  invalidate(): void {
    // No-op: PromptPicker invalidates itself on every keystroke.
  }

  render(width: number): string[] {
    const [first = "", ...rest] = this.input.render(Math.max(0, width - INPUT_GLYPH_WIDTH));
    return [`${this.glyph}${first}`, ...rest];
  }
}

const BORDER_SIDE_WIDTH = 2; // "│ " / " │"
const BORDER_TOTAL_WIDTH = BORDER_SIDE_WIDTH * 2;

/**
 * Hand-drawn rounded border around the whole panel: neither OverlayOptions
 * nor Box supports one. Renders children at `width - 4` (border column plus
 * one padding space per side) and pads every inner line flush to that width
 * before closing the right edge, so the panel stays opaque over whatever the
 * overlay covers.
 */
export class BorderBox implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly children: readonly Component[],
    private readonly dividerAfterIndex?: number,
  ) {}

  invalidate(): void {
    for (const child of this.children) child.invalidate?.();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const innerWidth = Math.max(0, safeWidth - BORDER_TOTAL_WIDTH);
    const horizontal = "─".repeat(Math.max(0, safeWidth - 2));

    const lines: string[] = [this.theme.fg("border", `╭${horizontal}╮`)];

    this.children.forEach((child, index) => {
      for (const line of child.render(innerWidth)) {
        lines.push(this.wrapInnerLine(line, innerWidth));
      }
      if (index === this.dividerAfterIndex) {
        lines.push(this.theme.fg("border", `├${horizontal}┤`));
      }
    });

    lines.push(this.theme.fg("border", `╰${horizontal}╯`));
    return lines;
  }

  private wrapInnerLine(line: string, innerWidth: number): string {
    const padCount = Math.max(0, innerWidth - visibleWidth(line));
    const padded = padCount > 0 ? `${line}${" ".repeat(padCount)}` : line;
    return `${this.theme.fg("border", "│ ")}${padded}${this.theme.fg("border", " │")}`;
  }
}

export class PromptPicker extends Container implements Focusable {
  private readonly input = new Input();
  private readonly header = new Text("");
  private readonly footer: Text;
  private readonly inputLine: InputLine;
  private readonly listView: PromptListView;
  private readonly border: BorderBox;
  private filtered: PromptEntry[];
  private selectedIndex = 0;
  private _focused = false;

  constructor(
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly entries: readonly PromptEntry[],
    private readonly done: (text: string | undefined) => void,
  ) {
    super();
    this.filtered = rankPrompts(this.entries, "");

    this.footer = new Text(this.theme.fg("dim", "↑↓ navigate · enter use · esc cancel"));
    this.inputLine = new InputLine(this.input, this.theme.fg("accent", "❯ "));
    this.listView = new PromptListView(this.theme);
    // Divider (index 1) sits right after the input line, before the list.
    this.border = new BorderBox(
      this.theme,
      [this.header, this.inputLine, this.listView, this.footer],
      1,
    );

    this.addChild(this.border);
    this.updateList();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) return this.move(-1);
    if (this.keybindings.matches(data, "tui.select.down")) return this.move(1);
    if (this.keybindings.matches(data, "tui.select.confirm")) return this.select();
    if (this.keybindings.matches(data, "tui.select.cancel")) return this.cancel();

    this.input.handleInput(data);
    this.filtered = rankPrompts(this.entries, this.input.getValue());
    this.selectedIndex = 0;
    this.updateList();
  }

  private move(delta: number): void {
    if (this.filtered.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.filtered.length) % this.filtered.length;
    this.updateList();
  }

  private select(): void {
    this.done(this.filtered[this.selectedIndex]?.text);
  }

  private cancel(): void {
    this.done(undefined);
  }

  private updateList(): void {
    this.listView.entries = this.filtered;
    this.listView.selectedIndex = this.selectedIndex;
    this.listView.query = this.input.getValue();

    this.header.setText(
      `${this.theme.fg("text", "Prompt history")}  ${this.theme.fg(
        "muted",
        `${this.filtered.length}/${this.entries.length}`,
      )}`,
    );

    this.invalidate();
  }
}
