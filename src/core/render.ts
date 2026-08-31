/**
 * Shared tool-call rendering kit: generic display helpers and width-safe
 * Components used by any module that re-styles a tool's transcript output.
 *
 * Dependency-light on purpose: only pi-tui, pi-coding-agent's root barrel,
 * and node builtins. No module- or tool-specific formatting belongs here.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type BulletState = "pending" | "running" | "success" | "error";

export function bulletState(ctx: {
  executionStarted: boolean;
  isPartial: boolean;
  isError: boolean;
}): BulletState {
  if (!ctx.executionStarted) return "pending";
  if (ctx.isPartial) return "running";
  return ctx.isError ? "error" : "success";
}

/** Narrow an unknown tool-call argument to a string, matching pi's own `str()` convention. */
export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

/**
 * Render a path relative to `cwd` when it is inside `cwd`, otherwise the
 * absolute path. Always posix-separated for display, regardless of platform.
 */
export function relativizePath(rawPath: string, cwd: string): string {
  if (!rawPath) return rawPath;
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const rel = relative(cwd, absolute);
  const insideCwd = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  const chosen = insideCwd ? rel || "." : absolute;
  return chosen.split(sep).join("/");
}

function isPosixAbsolute(path: string): boolean {
  return path.startsWith("/");
}

/**
 * Path display helper: relative to `cwd` when inside it; otherwise the
 * absolute path with a `$HOME` prefix collapsed to `~`. This is a display
 * convenience only — the render-time clip in `createToolHeader` is the final
 * safety net against an overlong result.
 */
export function displayPath(
  rawPath: string,
  cwd: string,
  homeDirectory: string = homedir(),
): string {
  const rel = relativizePath(rawPath, cwd);
  if (!rel || !isPosixAbsolute(rel)) return rel;
  const homePosix = homeDirectory.split(sep).join("/");
  if (rel === homePosix) return "~";
  if (rel.startsWith(`${homePosix}/`)) return `~${rel.slice(homePosix.length)}`;
  return rel;
}

/** Number of lines in `text`, treating the empty string as zero lines. */
export function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

export function extractResultText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

// Containment must use path.relative, not startsWith: a sibling directory that
// merely shares the root as a string prefix (e.g. "/tmp/jpi-scratchpad-501x")
// must not pass, and a resolved "root/../escape" must land outside cleanly.
export function isWithinRoot(root: string, resolvedTarget: string): boolean {
  const rel = relative(root, resolvedTarget);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Clip `text` to at most `width` visible characters, appending an ellipsis
 * when it was truncated. Guarantees the result never exceeds `width`, unlike
 * `truncateEnd` at very small widths.
 */
function clipToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function bulletColorFor(state: BulletState): ThemeColor {
  if (state === "success") return "success";
  if (state === "error") return "error";
  return "muted";
}

const BULLET_PREFIX = "⏺ ";

/**
 * Compose `⏺ Name(arg)`, shortening the arg first when it doesn't fit
 * `width`, and only falling back to clipping the bullet+name when there is
 * no room for the arg at all.
 */
function buildHeaderLine(
  state: BulletState,
  name: string,
  arg: string,
  theme: Theme,
  width: number,
): string {
  const bulletColor = bulletColorFor(state);
  const bulletName = `${BULLET_PREFIX}${name}`;
  const full = `${bulletName}(${arg})`;
  if (full.length <= width) {
    return `${theme.fg(bulletColor, BULLET_PREFIX)}${theme.bold(name)}(${theme.fg("muted", arg)})`;
  }

  // Room left for the arg once the closing "…" (replacing the trailing
  // paren) and the opening paren are accounted for.
  const availableForArg = width - bulletName.length - 2;
  if (availableForArg >= 0) {
    const shownArg = `${arg.slice(0, availableForArg)}…`;
    return `${theme.fg(bulletColor, BULLET_PREFIX)}${theme.bold(name)}(${theme.fg("muted", shownArg)}`;
  }

  const clipped = clipToWidth(bulletName, width);
  const prefixLen = Math.min(BULLET_PREFIX.length, clipped.length);
  const prefix = clipped.slice(0, prefixLen);
  const rest = clipped.slice(prefixLen);
  return `${theme.fg(bulletColor, prefix)}${theme.bold(rest)}`;
}

/** `⏺ Name(arg)` header. Clips to the render width and never wraps. */
export class ToolHeader implements Component {
  #state: BulletState = "pending";
  #name = "";
  #arg = "";
  #theme: Theme | undefined;

  update(state: BulletState, name: string, arg: string, theme: Theme): void {
    this.#state = state;
    this.#name = name;
    this.#arg = arg;
    this.#theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.#theme) return [""];
    return [buildHeaderLine(this.#state, this.#name, this.#arg, this.#theme, width)];
  }
}

/** Reuses `reuse` when it is already a `ToolHeader`, otherwise creates one. */
export function createToolHeader(
  state: BulletState,
  name: string,
  arg: string,
  theme: Theme,
  reuse?: Component,
): Component {
  const header = reuse instanceof ToolHeader ? reuse : new ToolHeader();
  header.update(state, name, arg, theme);
  return header;
}

const RESULT_PREFIX = "  ⎿  ";

/** `  ⎿  summary`. Clips to the render width and never wraps. */
export class ToolResultLine implements Component {
  #summary = "";
  #theme: Theme | undefined;
  #color: ThemeColor = "dim";

  update(summary: string, theme: Theme, color: ThemeColor = "dim"): void {
    this.#summary = summary;
    this.#theme = theme;
    this.#color = color;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.#theme) return [""];
    if (width < RESULT_PREFIX.length) {
      return [clipToWidth(RESULT_PREFIX, width)];
    }
    const available = width - RESULT_PREFIX.length;
    const clipped = clipToWidth(this.#summary, available);
    return [`${RESULT_PREFIX}${this.#theme.fg(this.#color, clipped)}`];
  }
}

/** Reuses `reuse` when it is already a `ToolResultLine`, otherwise creates one. */
export function createResultLine(
  summary: string,
  theme: Theme,
  color: ThemeColor = "dim",
  reuse?: Component,
): Component {
  const line = reuse instanceof ToolResultLine ? reuse : new ToolResultLine();
  line.update(summary, theme, color);
  return line;
}

const BORDER_SIDE_WIDTH = 2; // "│ " / " │"
const BORDER_TOTAL_WIDTH = BORDER_SIDE_WIDTH * 2;

/**
 * Hand-drawn rounded border around a panel: neither OverlayOptions nor Box
 * supports one. Renders children at `width - 4` (border column plus one
 * padding space per side) and pads every inner line flush to that width
 * before closing the right edge, so the panel stays opaque over whatever the
 * overlay covers. An optional title interrupts the top rule with `╭── title ──╮`.
 */
export class BorderBox implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly children: readonly Component[],
    private readonly dividerAfterIndex?: number,
    private readonly title?: string,
  ) {}

  invalidate(): void {
    for (const child of this.children) child.invalidate?.();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const innerWidth = Math.max(0, safeWidth - BORDER_TOTAL_WIDTH);
    const horizontal = "─".repeat(Math.max(0, safeWidth - 2));

    const lines: string[] = [this.renderTopLine(safeWidth, horizontal)];

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

  private renderTopLine(width: number, plainHorizontal: string): string {
    if (!this.title) return this.theme.fg("border", `╭${plainHorizontal}╮`);

    const innerWidth = Math.max(0, width - 2);
    const titleText = truncateToWidth(` ${this.title} `, innerWidth);
    const leftLen = Math.floor((innerWidth - visibleWidth(titleText)) / 2);
    const left = "─".repeat(Math.max(0, leftLen));
    const right = "─".repeat(Math.max(0, innerWidth - visibleWidth(titleText) - leftLen));
    return `${this.theme.fg("border", `╭${left}`)}${this.theme.fg("accent", titleText)}${this.theme.fg("border", `${right}╮`)}`;
  }

  private wrapInnerLine(line: string, innerWidth: number): string {
    const padCount = Math.max(0, innerWidth - visibleWidth(line));
    const padded = padCount > 0 ? `${line}${" ".repeat(padCount)}` : line;
    return `${this.theme.fg("border", "│ ")}${padded}${this.theme.fg("border", " │")}`;
  }
}
