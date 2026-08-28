import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import {
  formatPromptRow,
  formatRelativeTime,
  matchIndices,
  rankPrompts,
  renderPromptRow,
} from "../../modules/history/picker.ts";
import type { PromptEntry } from "../../modules/history/store.ts";
import { BorderBox } from "../../src/core/index.ts";

function entry(text: string, timestamp: string, cwd = "/repo/project"): PromptEntry {
  return { text, timestamp, cwd };
}

const THEME_COLOR_NAMES = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
];

const THEME_BG_NAMES = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
];

/** Minimal in-memory Theme (numeric 256-color indices, no disk access) for exercising fg/bg/bold in tests. */
function testTheme(): Theme {
  const fgColors = Object.fromEntries(THEME_COLOR_NAMES.map((name) => [name, 7]));
  const bgColors = Object.fromEntries(THEME_BG_NAMES.map((name) => [name, 0]));
  return new Theme(fgColors as never, bgColors as never, "256color");
}

test("rankPrompts keeps newest-first order for an empty (or blank) query", () => {
  const entries = [
    entry("third", "2024-01-03T00:00:00.000Z"),
    entry("second", "2024-01-02T00:00:00.000Z"),
    entry("first", "2024-01-01T00:00:00.000Z"),
  ];
  assert.deepEqual(rankPrompts(entries, "   "), entries);
});

test("rankPrompts fuzzy-orders by match quality and drops non-matches", () => {
  const entries = [
    entry("refactor the login flow", "2024-01-01T00:00:00.000Z"),
    entry("fix login bug", "2024-01-02T00:00:00.000Z"),
    entry("unrelated prompt", "2024-01-03T00:00:00.000Z"),
  ];
  const ranked = rankPrompts(entries, "login");
  assert.deepEqual(
    ranked.map((e) => e.text),
    ["fix login bug", "refactor the login flow"],
  );
});

test("formatPromptRow shows the first line (untruncated), relative time, and project basename", () => {
  const now = Date.parse("2024-01-10T00:00:00.000Z");
  const row = formatPromptRow(
    entry("first line of a prompt\nsecond line", "2024-01-08T00:00:00.000Z", "/repo/my-project"),
    now,
  );
  assert.equal(row.primary, "first line of a prompt");
  assert.equal(row.time, "2d ago");
  assert.equal(row.project, "my-project");
});

test("formatPromptRow no longer truncates — width-aware truncation happens at render time", () => {
  const longLine = "x".repeat(120);
  const row = formatPromptRow(
    entry(longLine, "2024-01-08T00:00:00.000Z"),
    Date.parse("2024-01-10T00:00:00.000Z"),
  );
  assert.equal(row.primary, longLine);
});

test("formatRelativeTime buckets by minutes, hours, and days", () => {
  const now = Date.parse("2024-01-10T12:00:00.000Z");
  assert.equal(formatRelativeTime("2024-01-10T11:59:30.000Z", now), "just now");
  assert.equal(formatRelativeTime("2024-01-10T11:30:00.000Z", now), "30m ago");
  assert.equal(formatRelativeTime("2024-01-10T09:00:00.000Z", now), "3h ago");
  assert.equal(formatRelativeTime("2024-01-08T12:00:00.000Z", now), "2d ago");
});

test("matchIndices matches characters in order, not just presence", () => {
  const indices = matchIndices("lg", "login");
  assert.deepEqual(
    [...indices].sort((a, b) => a - b),
    [0, 2],
  );
});

test("matchIndices is case-insensitive", () => {
  const indices = matchIndices("LOGIN", "login");
  assert.deepEqual(
    [...indices].sort((a, b) => a - b),
    [0, 1, 2, 3, 4],
  );
});

test("matchIndices unions indices across whitespace/slash-separated tokens", () => {
  const indices = matchIndices("log in", "login flow");
  assert.deepEqual(
    [...indices].sort((a, b) => a - b),
    [0, 1, 2, 3, 4],
  );
});

test("matchIndices contributes nothing for a token that cannot match", () => {
  assert.deepEqual(matchIndices("zzz", "login"), new Set());
  // A non-matching token alongside a matching one drops out silently —
  // the matching token's indices still come through.
  const indices = matchIndices("log zzz", "login flow");
  assert.deepEqual(
    [...indices].sort((a, b) => a - b),
    [0, 1, 2],
  );
});

test("renderPromptRow right-aligns meta at the exact row width", () => {
  const theme = testTheme();
  const line = stripTerminalSequences(
    renderPromptRow(
      40,
      "short prompt",
      { time: "2h ago", project: "proj" },
      false,
      new Set(),
      theme,
    ),
  );
  assert.equal(line.length, 40);
  assert.ok(line.startsWith("  short prompt"));
  assert.ok(line.endsWith("2h ago · proj"));
});

test("renderPromptRow truncates an overlong primary with an ellipsis", () => {
  const theme = testTheme();
  const line = stripTerminalSequences(
    renderPromptRow(30, "x".repeat(200), undefined, false, new Set(), theme),
  );
  assert.equal(line.length, 30);
  assert.ok(line.endsWith("…"));
});

test("renderPromptRow drops meta entirely when there isn't ~20 cols left for primary", () => {
  const theme = testTheme();
  const line = stripTerminalSequences(
    renderPromptRow(
      25,
      "a reasonably long first line of a prompt",
      { time: "2h ago", project: "a-very-long-project-name" },
      false,
      new Set(),
      theme,
    ),
  );
  assert.ok(!line.includes("·"));
  assert.ok(!line.includes("a-very-long-project-name"));
});

test("renderPromptRow pads a selected row with trailing spaces to the full width", () => {
  const theme = testTheme();
  const raw = renderPromptRow(20, "hi", undefined, true, new Set(), theme);
  const stripped = stripTerminalSequences(raw);
  assert.equal(stripped.length, 20);
  assert.ok(raw.includes(theme.getBgAnsi("selectedBg")));
});

test("renderPromptRow bold-highlights matched runs, not the whole primary", () => {
  const theme = testTheme();
  const raw = renderPromptRow(40, "hello world", undefined, false, new Set([0, 1]), theme);
  assert.ok(raw.includes(theme.bold(theme.fg("searchMatchText", "he"))));
  assert.ok(!raw.includes(theme.bold(theme.fg("searchMatchText", "hello"))));
});

test("BorderBox draws exact-width rounded corners top and bottom", () => {
  const theme = testTheme();
  const child = { render: (w: number) => ["x".repeat(Math.min(3, w))], invalidate() {} };
  const lines = new BorderBox(theme, [child]).render(20).map(stripTerminalSequences);
  assert.equal(lines[0]?.length, 20);
  assert.ok(lines[0]?.startsWith("╭") && lines[0]?.endsWith("╮"));
  assert.equal(lines[lines.length - 1]?.length, 20);
  assert.ok(lines[lines.length - 1]?.startsWith("╰") && lines[lines.length - 1]?.endsWith("╯"));
});

test("BorderBox pads inner lines flush to the inner width before the right edge", () => {
  const theme = testTheme();
  const child = { render: () => ["hi"], invalidate() {} };
  const lines = new BorderBox(theme, [child]).render(20).map(stripTerminalSequences);
  assert.equal(lines[1], `│ hi${" ".repeat(14)} │`);
  assert.equal(lines[1]?.length, 20);
});

test("BorderBox emits a divider row after the marked child index", () => {
  const theme = testTheme();
  const first = { render: () => ["a"], invalidate() {} };
  const second = { render: () => ["b"], invalidate() {} };
  const lines = new BorderBox(theme, [first, second], 0).render(10).map(stripTerminalSequences);
  assert.equal(lines.length, 5);
  assert.equal(lines[2]?.length, 10);
  assert.ok(lines[2]?.startsWith("├") && lines[2]?.endsWith("┤"));
});
