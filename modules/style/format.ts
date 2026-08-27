/**
 * Pure formatting helpers specific to how the built-in read/bash/edit/write/
 * grep/find/ls tools describe their own results as text.
 *
 * Generic display helpers (path relativizing, pluralizing, line counting,
 * the header/result-line Components) live in `src/core/render.ts` instead —
 * this file only holds parsing/summarizing logic tied to one tool's output
 * format. Kept free of pi imports so it can be unit tested without a TUI or
 * extension host.
 */

import { countLines, truncateEnd } from "../../src/core/index.ts";

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

/** Truncate a shell command to its first line, then to `maxLen` characters. */
export function truncateCommand(command: string, maxLen = 80): string {
  const firstLine = command.split("\n")[0] ?? "";
  return truncateEnd(firstLine, maxLen);
}

/** Collapsed bash summary: first non-empty output line, or "(no output)". */
export function summarizeBashOutput(text: string, maxLineLen = 100): string {
  const stripped = stripTrailingBracketNotice(text);
  const lines = stripped.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim() !== "");
  if (firstIndex === -1) return "(no output)";
  const preview = truncateEnd(lines[firstIndex] ?? "", maxLineLen);
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

/**
 * Right-align line numbers starting at `startAt`, indented to sit under a
 * `  ⎿  summary` result line (Claude Code's write/read preview format).
 */
export function numberLines(lines: readonly string[], startAt = 1): string[] {
  if (lines.length === 0) return [];
  const width = String(startAt + lines.length - 1).length;
  return lines.map((line, i) => `    ${String(startAt + i).padStart(width, " ")}  ${line}`);
}
