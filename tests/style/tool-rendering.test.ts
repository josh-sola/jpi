/**
 * Component-level tests for the Claude-Code-parity renderers: write/read
 * content previews, edit diff bodies, the ≤100-line inline-vs-expanded gate,
 * memory/scratchpad phrasing, and error rendering.
 */
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { memoriesRoot, scratchpadRoot } from "../../src/core/index.ts";
import { registerStyleTools } from "../../modules/style/index.ts";

// renderDiff (used by the edit renderer) reads pi's global theme singleton
// directly rather than the Theme instance passed to renderCall/renderResult;
// real only once initTheme() has run.
initTheme();

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

// `Text` pads rendered lines out to the full render width; trim that padding
// since it's not semantically meaningful for these assertions.
function plainLines(component: { render(width: number): string[] }, width = 120): string[] {
  return component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

function bootStyleTools(
  overrides: {
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    scratchpadTempRoot?: string;
  } = {},
): Map<string, any> {
  const tools = new Map<string, any>();
  const pi = { registerTool: (tool: any) => tools.set(tool.name, tool) } as any;
  registerStyleTools(pi, overrides);
  return tools;
}

function context(overrides: Record<string, unknown> = {}): any {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    isError: false,
    ...overrides,
  };
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text", text }], details };
}

// --- write: plain ---

test("write renders a header and a line-numbered, path-bearing summary", () => {
  const tools = bootStyleTools();
  const write = tools.get("write");
  const args = { path: "src/core/guards.ts", content: "line1\nline2\nline3" };

  const header = write.renderCall(args, testTheme(), context({ args }));
  assert.deepEqual(plainLines(header), ["⏺ Write(src/core/guards.ts)"]);

  const result = write.renderResult(
    textResult("Successfully wrote 17 bytes to src/core/guards.ts"),
    { expanded: false, isPartial: false },
    testTheme(),
    context({ args }),
  );
  const lines = plainLines(result);
  assert.equal(lines[0], "  ⎿  Wrote 3 lines to src/core/guards.ts");
  assert.equal(lines[1], "    1  line1");
  assert.equal(lines[2], "    2  line2");
  assert.equal(lines[3], "    3  line3");
});

test("write hides a body over 100 lines unless expanded", () => {
  const tools = bootStyleTools();
  const write = tools.get("write");
  const content = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
  const args = { path: "big.txt", content };

  const collapsed = plainLines(
    write.renderResult(
      textResult("ok"),
      { expanded: false, isPartial: false },
      testTheme(),
      context({ args }),
    ),
  );
  assert.equal(collapsed.length, 1);
  assert.ok(collapsed[0].includes("Wrote 120 lines to big.txt"));

  const expanded = plainLines(
    write.renderResult(
      textResult("ok"),
      { expanded: true, isPartial: false },
      testTheme(),
      context({ args }),
    ),
  );
  assert.ok(expanded.length > 1);
  assert.ok(expanded.some((l) => l.includes("line 0")));
});

// --- write: memory / scratchpad phrasing ---

test("write into the memories store gets memory phrasing and drops the path", () => {
  const agentDir = "/tmp/jpi-test-agent";
  const tools = bootStyleTools({ env: { PI_CODING_AGENT_DIR: agentDir } });
  const write = tools.get("write");
  const path = join(memoriesRoot({ PI_CODING_AGENT_DIR: agentDir }), "-some-project", "notes.md");
  const args = { path, content: "a\nb" };

  const header = write.renderCall(args, testTheme(), context({ args }));
  assert.deepEqual(plainLines(header), ["⏺ Created a memory (notes)"]);

  const result = write.renderResult(
    textResult("ok"),
    { expanded: false, isPartial: false },
    testTheme(),
    context({ args }),
  );
  assert.equal(plainLines(result)[0], "  ⎿  Wrote 2 lines");
});

test("write into the scratchpad gets scratchpad phrasing and drops the path", () => {
  const tempRoot = "/tmp/jpi-test-scratch-root";
  const tools = bootStyleTools({ scratchpadTempRoot: tempRoot });
  const write = tools.get("write");
  const path = join(scratchpadRoot(tempRoot), "-proj", "session-1", "draft.txt");
  const args = { path, content: "a\nb\nc" };

  const header = write.renderCall(args, testTheme(), context({ args }));
  assert.deepEqual(plainLines(header), ["⏺ Wrote into scratchpad (draft.txt)"]);

  const result = write.renderResult(
    textResult("ok"),
    { expanded: false, isPartial: false },
    testTheme(),
    context({ args }),
  );
  assert.equal(plainLines(result)[0], "  ⎿  Wrote 3 lines");
});

// --- read ---

test("read shows numbered, highlighted content starting at the requested offset when expanded", () => {
  const tools = bootStyleTools();
  const read = tools.get("read");
  const args = { path: "src/a.ts", offset: 10 };

  const header = read.renderCall(args, testTheme(), context({ args }));
  assert.deepEqual(plainLines(header), ["⏺ Read(src/a.ts)"]);

  const result = read.renderResult(
    textResult("const a = 1;\nconst b = 2;"),
    { expanded: true, isPartial: false },
    testTheme(),
    context({ args }),
  );
  const lines = plainLines(result);
  assert.equal(lines[0], "  ⎿  Read 2 lines");
  assert.ok(lines[1].startsWith("    10  "));
  assert.ok(lines[2].startsWith("    11  "));
});

test("read collapsed shows only the summary line", () => {
  const tools = bootStyleTools();
  const read = tools.get("read");
  const args = { path: "src/a.ts" };
  const result = read.renderResult(
    textResult("const a = 1;\nconst b = 2;"),
    { expanded: false, isPartial: false },
    testTheme(),
    context({ args }),
  );
  assert.deepEqual(plainLines(result), ["  ⎿  Read 2 lines"]);
});

test("read from the scratchpad gets scratchpad phrasing", () => {
  const tempRoot = "/tmp/jpi-test-scratch-root-2";
  const tools = bootStyleTools({ scratchpadTempRoot: tempRoot });
  const read = tools.get("read");
  const path = join(scratchpadRoot(tempRoot), "-proj", "session-1", "notes.txt");
  const header = read.renderCall({ path }, testTheme(), context({ args: { path } }));
  assert.deepEqual(plainLines(header), ["⏺ Read from scratchpad (notes.txt)"]);
});

// --- edit ---

function editArgs(path = "src/core/index.ts") {
  return { path, edits: [{ oldText: "old", newText: "new" }] };
}

test("edit summarizes pure additions and renders the diff body inline", () => {
  const tools = bootStyleTools();
  const edit = tools.get("edit");
  const args = editArgs();

  const header = edit.renderCall(args, testTheme(), context({ args }));
  assert.deepEqual(plainLines(header), ["⏺ Update(src/core/index.ts)"]);

  const diff = ['+1 export { isRecord } from "./guards.ts";'].join("\n");
  const result = edit.renderResult(
    textResult("Successfully replaced 1 block(s).", { diff }),
    { expanded: false, isPartial: false },
    testTheme(),
    context({ args }),
  );
  const lines = plainLines(result);
  assert.equal(lines[0], "  ⎿  Added 1 line");
  assert.equal(lines[1], `    +1 export { isRecord } from "./guards.ts";`);
});

test("edit summarizes pure removals and mixed changes", () => {
  const tools = bootStyleTools();
  const edit = tools.get("edit");
  const args = editArgs();

  const removalDiff = '-1 export { old } from "./guards.ts";';
  const removalSummary = plainLines(
    edit.renderResult(
      textResult("ok", { diff: removalDiff }),
      { expanded: false, isPartial: false },
      testTheme(),
      context({ args }),
    ),
  )[0];
  assert.equal(removalSummary, "  ⎿  Removed 1 line");

  const mixedDiff = ["-1 old line", "+1 new line"].join("\n");
  const mixedSummary = plainLines(
    edit.renderResult(
      textResult("ok", { diff: mixedDiff }),
      { expanded: false, isPartial: false },
      testTheme(),
      context({ args }),
    ),
  )[0];
  assert.equal(mixedSummary, "  ⎿  Updated with 1 addition and 1 removal");
});

test("edit hides the diff body over 100 lines unless expanded", () => {
  const tools = bootStyleTools();
  const edit = tools.get("edit");
  const args = editArgs();
  const diff = Array.from({ length: 120 }, (_, i) => `+${i + 1} line ${i}`).join("\n");

  const collapsed = plainLines(
    edit.renderResult(
      textResult("ok", { diff }),
      { expanded: false, isPartial: false },
      testTheme(),
      context({ args }),
    ),
  );
  assert.equal(collapsed.length, 1);

  const expanded = plainLines(
    edit.renderResult(
      textResult("ok", { diff }),
      { expanded: true, isPartial: false },
      testTheme(),
      context({ args }),
    ),
  );
  assert.ok(expanded.length > 1);
});

test("edit on a memory file gets memory phrasing", () => {
  const agentDir = "/tmp/jpi-test-agent-2";
  const tools = bootStyleTools({ env: { PI_CODING_AGENT_DIR: agentDir } });
  const edit = tools.get("edit");
  const path = join(memoriesRoot({ PI_CODING_AGENT_DIR: agentDir }), "-proj", "lessons.md");
  const args = editArgs(path);

  const header = edit.renderCall(args, testTheme(), context({ args }));
  assert.deepEqual(plainLines(header), ["⏺ Updated a memory (lessons)"]);
});

test("edit on a scratchpad file gets scratchpad phrasing", () => {
  const tempRoot = "/tmp/jpi-test-scratch-root-3";
  const tools = bootStyleTools({ scratchpadTempRoot: tempRoot });
  const edit = tools.get("edit");
  const path = join(scratchpadRoot(tempRoot), "-proj", "session-1", "scratch.txt");
  const args = editArgs(path);

  const header = edit.renderCall(args, testTheme(), context({ args }));
  assert.deepEqual(plainLines(header), ["⏺ Updated in scratchpad (scratch.txt)"]);
});

// --- errors ---

test("an error result stays visible when collapsed and shows the full text when expanded", () => {
  const tools = bootStyleTools();
  const write = tools.get("write");
  const args = { path: "src/a.ts", content: "x" };

  const collapsed = plainLines(
    write.renderResult(
      textResult("boom: permission denied"),
      { expanded: false, isPartial: false },
      testTheme(),
      context({ args, isError: true }),
    ),
  );
  assert.deepEqual(collapsed, ["  ⎿  boom: permission denied"]);

  const expanded = plainLines(
    write.renderResult(
      textResult("boom: permission denied\nmore detail"),
      { expanded: true, isPartial: false },
      testTheme(),
      context({ args, isError: true }),
    ),
  );
  assert.ok(expanded.some((l) => l.includes("more detail")));
});
