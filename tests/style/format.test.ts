import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  asString,
  bulletState,
  countDiffStats,
  countFindResults,
  countGrepMatches,
  countLines,
  countLsEntries,
  countReadLines,
  extractResultText,
  firstNonEmptyLine,
  plural,
  relativizePath,
  stripTrailingBracketNotice,
  summarizeBashOutput,
  truncateCommand,
  truncateSingleLine,
} from "../../modules/style/format.ts";

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

// --- truncateSingleLine / truncateCommand ---

test("truncateSingleLine leaves short text alone", () => {
  assert.equal(truncateSingleLine("short", 80), "short");
});

test("truncateSingleLine truncates with an ellipsis at the limit", () => {
  const result = truncateSingleLine("a".repeat(90), 80);
  assert.equal(result.length, 80);
  assert.ok(result.endsWith("…"));
});

test("truncateCommand only keeps the first line before truncating", () => {
  assert.equal(truncateCommand("echo hi\nrm -rf /", 80), "echo hi");
});

// --- countLines / stripTrailingBracketNotice / countReadLines ---

test("countLines treats the empty string as zero lines", () => {
  assert.equal(countLines(""), 0);
});

test("countLines counts newline-separated lines", () => {
  assert.equal(countLines("a\nb\nc"), 3);
});

test("stripTrailingBracketNotice removes a trailing truncation notice", () => {
  const text = "line one\nline two\n\n[Truncated: showing 2 of 100 lines (50KB limit)]";
  assert.equal(stripTrailingBracketNotice(text), "line one\nline two");
});

test("stripTrailingBracketNotice leaves plain text untouched", () => {
  assert.equal(stripTrailingBracketNotice("line one\nline two"), "line one\nline two");
});

test("countReadLines counts lines after stripping a trailing notice", () => {
  const text = "a\nb\nc\n\n[Showing lines 1-3 of 500. Use offset=4 to continue.]";
  assert.equal(countReadLines(text), 3);
});

// --- countDiffStats ---

test("countDiffStats counts additions and removals, ignoring diff headers", () => {
  const diff = [
    "--- a/file.ts",
    "+++ b/file.ts",
    "-old line",
    "+new line 1",
    "+new line 2",
    " context",
  ].join("\n");
  assert.deepEqual(countDiffStats(diff), { additions: 2, removals: 1 });
});

// --- countGrepMatches ---

test("countGrepMatches counts match lines and ignores context lines", () => {
  const output = [
    "src/a.ts-1- before",
    "src/a.ts:2: match one",
    "src/a.ts-3- after",
    "src/b.ts:5: match two",
  ].join("\n");
  assert.equal(countGrepMatches(output), 2);
});

test("countGrepMatches returns zero for no matches", () => {
  assert.equal(countGrepMatches("No matches found"), 0);
});

test("countGrepMatches ignores a trailing limit notice", () => {
  const output =
    "src/a.ts:1: match\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]";
  assert.equal(countGrepMatches(output), 1);
});

// --- countFindResults / countLsEntries ---

test("countFindResults counts one result per line", () => {
  assert.equal(countFindResults("src/a.ts\nsrc/b.ts"), 2);
});

test("countFindResults returns zero for no results", () => {
  assert.equal(countFindResults("No files found matching pattern"), 0);
});

test("countLsEntries counts one entry per line", () => {
  assert.equal(countLsEntries("a.ts\nb.ts\nsub/"), 3);
});

test("countLsEntries returns zero for an empty directory", () => {
  assert.equal(countLsEntries("(empty directory)"), 0);
});

// --- summarizeBashOutput ---

test("summarizeBashOutput reports no output", () => {
  assert.equal(summarizeBashOutput(""), "(no output)");
  assert.equal(summarizeBashOutput("\n\n"), "(no output)");
});

test("summarizeBashOutput previews the first non-empty line", () => {
  assert.equal(summarizeBashOutput("hello world"), "hello world");
});

test("summarizeBashOutput skips leading blank lines and counts the rest", () => {
  assert.equal(summarizeBashOutput("\nfirst\nsecond\nthird"), "first … +2 lines");
});

test("summarizeBashOutput truncates a long first line", () => {
  const result = summarizeBashOutput("x".repeat(150));
  assert.equal(result.length, 100);
  assert.ok(result.endsWith("…"));
});

// --- extractResultText / firstNonEmptyLine ---

test("extractResultText joins only text content blocks", () => {
  const content = [
    { type: "text", text: "hello" },
    { type: "image" },
    { type: "text", text: "world" },
  ];
  assert.equal(extractResultText(content), "hello\nworld");
});

test("firstNonEmptyLine skips blank lines", () => {
  assert.equal(firstNonEmptyLine("\n\nfirst\nsecond"), "first");
});

test("firstNonEmptyLine returns undefined when everything is blank", () => {
  assert.equal(firstNonEmptyLine("\n\n"), undefined);
});
