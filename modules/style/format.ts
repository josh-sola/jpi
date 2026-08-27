/**
 * Pure formatting helpers for the Claude-Code-style tool renderer.
 *
 * Kept free of pi imports so they can be unit tested without a TUI or
 * extension host.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

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

export function truncateSingleLine(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

/** Truncate a shell command to its first line, then to `maxLen` characters. */
export function truncateCommand(command: string, maxLen = 80): string {
  const firstLine = command.split("\n")[0] ?? "";
  return truncateSingleLine(firstLine, maxLen);
}

/** Number of lines in `text`, treating the empty string as zero lines. */
export function countLines(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/**
 * Built-in tools append a trailing `\n\n[...]` notice (truncation, limits,
 * continuation hints) to otherwise-plain output. Strip it before counting
 * lines or picking a preview line so counts reflect actual content.
 */
export function stripTrailingBracketNotice(text: string): string {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith("]")) return text;
  const noticeStart = trimmed.lastIndexOf("\n\n[");
  return noticeStart === -1 ? text : trimmed.slice(0, noticeStart);
}

export function firstNonEmptyLine(text: string): string | undefined {
  return text.split("\n").find((line) => line.trim() !== "");
}

export function extractResultText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/** Collapsed bash summary: first non-empty output line, or "(no output)". */
export function summarizeBashOutput(text: string, maxLineLen = 100): string {
  const stripped = stripTrailingBracketNotice(text);
  const lines = stripped.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim() !== "");
  if (firstIndex === -1) return "(no output)";
  const preview = truncateSingleLine(lines[firstIndex] ?? "", maxLineLen);
  const remaining = lines.length - firstIndex - 1;
  return remaining > 0 ? `${preview} … +${remaining} lines` : preview;
}

export function countReadLines(text: string): number {
  return countLines(stripTrailingBracketNotice(text));
}

/** Added/removed line counts from an edit tool's unified-style diff string. */
export function countDiffStats(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }
  return { additions, removals };
}

const NOTICE_LINE = /^\[.*\]$/;

/**
 * Count grep matches from its rendered output. Match lines use `path:N: `;
 * context lines (from `context > 0`) use `path-N- ` and are excluded.
 */
export function countGrepMatches(text: string): number {
  const trimmed = stripTrailingBracketNotice(text).trim();
  if (!trimmed || trimmed === "No matches found") return 0;
  let count = 0;
  for (const line of trimmed.split("\n")) {
    if (NOTICE_LINE.test(line)) continue;
    if (/:\d+:\s/.test(line)) count++;
  }
  return count;
}

/** Count find results: one file path per line, plus an optional trailing notice. */
export function countFindResults(text: string): number {
  const trimmed = stripTrailingBracketNotice(text).trim();
  if (!trimmed || trimmed === "No files found matching pattern") return 0;
  return trimmed.split("\n").filter((line) => line !== "" && !NOTICE_LINE.test(line)).length;
}

/** Count ls entries: one entry per line, plus an optional trailing notice. */
export function countLsEntries(text: string): number {
  const trimmed = stripTrailingBracketNotice(text).trim();
  if (!trimmed || trimmed === "(empty directory)") return 0;
  return trimmed.split("\n").filter((line) => line !== "" && !NOTICE_LINE.test(line)).length;
}
