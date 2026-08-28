import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import {
  asString,
  bulletState,
  countLines,
  createResultLine,
  createToolHeader,
  displayPath,
  extractResultText,
  isWithinRoot,
  plural,
  relativizePath,
} from "../../src/core/render.ts";

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

/** Minimal in-memory Theme (numeric 256-color indices, no disk access) for exercising fg/bold in tests. */
function testTheme(): Theme {
  const fgColors = Object.fromEntries(THEME_COLOR_NAMES.map((name) => [name, 7]));
  const bgColors = Object.fromEntries(THEME_BG_NAMES.map((name) => [name, 0]));
  return new Theme(fgColors as never, bgColors as never, "256color");
}

function renderPlain(component: { render(width: number): string[] }, width: number): string[] {
  return component.render(width).map((line) => stripTerminalSequences(line));
}

// --- bulletState ---

test("bulletState is pending before execution starts", () => {
  assert.equal(
    bulletState({ executionStarted: false, isPartial: true, isError: false }),
    "pending",
  );
});

test("bulletState is running once started but not yet settled", () => {
  assert.equal(bulletState({ executionStarted: true, isPartial: true, isError: false }), "running");
});

test("bulletState is success on a settled non-error result", () => {
  assert.equal(
    bulletState({ executionStarted: true, isPartial: false, isError: false }),
    "success",
  );
});

test("bulletState is error on a settled error result", () => {
  assert.equal(bulletState({ executionStarted: true, isPartial: false, isError: true }), "error");
});

// --- asString / plural ---

test("asString narrows strings and rejects everything else", () => {
  assert.equal(asString("foo"), "foo");
  assert.equal(asString(42), "");
  assert.equal(asString(undefined), "");
});

test("plural picks singular or plural by count", () => {
  assert.equal(plural(1, "line"), "line");
  assert.equal(plural(0, "line"), "lines");
  assert.equal(plural(2, "line"), "lines");
  assert.equal(plural(1, "match", "matches"), "match");
  assert.equal(plural(3, "match", "matches"), "matches");
});

// --- relativizePath ---

test("relativizePath makes a path under cwd relative", () => {
  assert.equal(relativizePath("/repo/src/foo.ts", "/repo"), "src/foo.ts");
});

test("relativizePath resolves a relative input against cwd first", () => {
  assert.equal(relativizePath("src/foo.ts", "/repo"), "src/foo.ts");
});

test("relativizePath keeps cwd itself as a dot", () => {
  assert.equal(relativizePath("/repo", "/repo"), ".");
});

test("relativizePath keeps an absolute path when outside cwd", () => {
  assert.equal(relativizePath("/etc/hosts", "/repo"), "/etc/hosts");
});

test("relativizePath passes through an empty path", () => {
  assert.equal(relativizePath("", "/repo"), "");
});

// --- displayPath ---

test("displayPath keeps a cwd-relative path relative", () => {
  assert.equal(displayPath("/repo/src/foo.ts", "/repo", "/Users/tester"), "src/foo.ts");
});

test("displayPath collapses a $HOME prefix to ~ when outside cwd", () => {
  assert.equal(
    displayPath("/Users/tester/notes/todo.md", "/repo", "/Users/tester"),
    "~/notes/todo.md",
  );
});

test("displayPath renders the bare home directory as ~", () => {
  assert.equal(displayPath("/Users/tester", "/repo", "/Users/tester"), "~");
});

test("displayPath leaves an absolute path outside both cwd and home untouched", () => {
  assert.equal(displayPath("/etc/hosts", "/repo", "/Users/tester"), "/etc/hosts");
});

// --- countLines ---

test("countLines treats the empty string as zero lines", () => {
  assert.equal(countLines(""), 0);
});

test("countLines counts newline-separated lines", () => {
  assert.equal(countLines("a\nb\nc"), 3);
});

// --- extractResultText ---

test("extractResultText joins only text content blocks", () => {
  const content = [
    { type: "text", text: "hello" },
    { type: "image" },
    { type: "text", text: "world" },
  ];
  assert.equal(extractResultText(content), "hello\nworld");
});

// --- isWithinRoot ---

test("isWithinRoot uses real path containment, not a string prefix match", () => {
  const root = "/scratch/root";
  assert.equal(isWithinRoot(root, "/scratch/root/proj-a/session-1/notes.txt"), true);
  // A sibling directory that merely shares the root as a string prefix must not pass.
  assert.equal(isWithinRoot(root, "/scratch/root-other/notes.txt"), false);
  // The root itself is not "within" the root.
  assert.equal(isWithinRoot(root, root), false);
  // A resolved "root/../escape" must land outside cleanly.
  assert.equal(isWithinRoot(root, "/scratch/root/../escape.txt"), false);
});

// --- createToolHeader ---

test("createToolHeader renders the full line when it fits the width", () => {
  const header = createToolHeader("success", "Write", "src/core/guards.ts", testTheme());
  const lines = renderPlain(header, 30);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "⏺ Write(src/core/guards.ts)");
});

test("createToolHeader shortens the arg first, ending the line in an ellipsis", () => {
  const header = createToolHeader("success", "Write", "src/core/guards.ts", testTheme());
  const lines = renderPlain(header, 20);
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.ok(line!.length <= 20, `expected length <= 20, got ${line!.length}`);
  assert.ok(line!.endsWith("…"));
  assert.equal(line, "⏺ Write(src/core/gu…");
});

test("createToolHeader never exceeds the render width across a range of widths", () => {
  const header = createToolHeader(
    "running",
    "Search",
    "a very long grep pattern indeed",
    testTheme(),
  );
  for (const width of [1, 2, 3, 5, 8, 12, 20, 30, 45, 80]) {
    const lines = renderPlain(header, width);
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.ok(line!.length <= width, `width ${width}: got "${line}" (${line!.length} chars)`);
  }
});

test("createToolHeader falls back to clipping the bullet+name at very narrow widths", () => {
  const header = createToolHeader("success", "Write", "src/core/guards.ts", testTheme());
  const lines = renderPlain(header, 5);
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.ok(line!.length <= 5);
  assert.ok(line!.endsWith("…"));
});

test("createToolHeader reuses a passed-in ToolHeader instance", () => {
  const first = createToolHeader("pending", "Read", "a.ts", testTheme());
  const second = createToolHeader("success", "Read", "b.ts", testTheme(), first);
  assert.equal(second, first);
  assert.equal(renderPlain(second, 30)[0], "⏺ Read(b.ts)");
});

// --- createResultLine ---

test("createResultLine renders the two-space-indented ⎿ format", () => {
  const line = createResultLine("Wrote 3 lines to src/core/guards.ts", testTheme());
  const lines = renderPlain(line, 80);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "  ⎿  Wrote 3 lines to src/core/guards.ts");
});

test("createResultLine clips a long summary and never exceeds the width", () => {
  const line = createResultLine(
    "a very long summary that will not fit in a narrow terminal",
    testTheme(),
  );
  for (const width of [1, 5, 10, 20, 40, 80]) {
    const lines = renderPlain(line, width);
    assert.equal(lines.length, 1);
    const [rendered] = lines;
    assert.ok(
      rendered!.length <= width,
      `width ${width}: got "${rendered}" (${rendered!.length} chars)`,
    );
  }
});
