import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  countDiffStats,
  countFindResults,
  countGrepMatches,
  countLsEntries,
  countReadLines,
  firstNonEmptyLine,
  numberLines,
  stripTrailingBracketNotice,
  summarizeBashOutput,
  truncateCommand,
} from "../../modules/style/format.ts";

// --- truncateCommand ---

test("truncateCommand only keeps the first line before truncating", () => {
  assert.equal(truncateCommand("echo hi\nrm -rf /", 80), "echo hi");
});

// --- stripTrailingBracketNotice / countReadLines ---

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

// --- firstNonEmptyLine ---

test("firstNonEmptyLine skips blank lines", () => {
  assert.equal(firstNonEmptyLine("\n\nfirst\nsecond"), "first");
});

test("firstNonEmptyLine returns undefined when everything is blank", () => {
  assert.equal(firstNonEmptyLine("\n\n"), undefined);
});

// --- numberLines ---

test("numberLines right-aligns the gutter and indents under a result line", () => {
  assert.deepEqual(numberLines(["a", "b", "c"]), ["    1  a", "    2  b", "    3  c"]);
});

test("numberLines starts at the given offset and widens the gutter as needed", () => {
  assert.deepEqual(numberLines(["a", "b"], 9), ["     9  a", "    10  b"]);
});

test("numberLines returns an empty array for no lines", () => {
  assert.deepEqual(numberLines([]), []);
});
