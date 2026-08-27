/**
 * Guardian's "reviewed" annotation now renders as the final line of a tool's
 * own result, instead of as a separately-spaced transcript entry. These
 * tests exercise that inline rendering directly against the review-
 * annotation registry, without going through guardian itself.
 */
import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { recordReviewAnnotation } from "../../src/core/index.ts";
import { registerStyleTools } from "../../modules/style/index.ts";

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

function testTheme(): Theme {
  const fgColors = Object.fromEntries(THEME_COLOR_NAMES.map((name) => [name, 7]));
  const bgColors = Object.fromEntries(THEME_BG_NAMES.map((name) => [name, 0]));
  return new Theme(fgColors as never, bgColors as never, "256color");
}

function plainLines(component: { render(width: number): string[] }, width = 120): string[] {
  return component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

function bootStyleTools(): Map<string, any> {
  const tools = new Map<string, any>();
  const pi = { registerTool: (tool: any) => tools.set(tool.name, tool) } as any;
  registerStyleTools(pi);
  return tools;
}

function context(toolCallId: string, overrides: Record<string, unknown> = {}): any {
  return {
    args: {},
    toolCallId,
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

test("renderResult appends the reviewed annotation when one is recorded for the toolCallId", () => {
  const tools = bootStyleTools();
  const write = tools.get("write");
  const args = { path: "a.txt", content: "x" };

  recordReviewAnnotation("call-reviewed-write", { durationMs: 1234 });

  const lines = plainLines(
    write.renderResult(
      textResult("ok"),
      { expanded: false, isPartial: false },
      testTheme(),
      context("call-reviewed-write", { args }),
    ),
  );

  assert.equal(lines[0], "  ⎿  Wrote 1 line to a.txt");
  assert.equal(lines.at(-1), "  ⛨ reviewed · 1.2s");
});

test("renderResult omits the annotation line when none is recorded for the toolCallId", () => {
  const tools = bootStyleTools();
  const write = tools.get("write");
  const args = { path: "a.txt", content: "x" };

  const lines = plainLines(
    write.renderResult(
      textResult("ok"),
      { expanded: false, isPartial: false },
      testTheme(),
      context("call-unreviewed-write", { args }),
    ),
  );

  assert.ok(!lines.some((line) => line.includes("⛨ reviewed")));
});

test("the annotation renders through the shared bash/grep/find/ls result path too", () => {
  const tools = bootStyleTools();
  const bash = tools.get("bash");
  const args = { command: "npm test" };

  recordReviewAnnotation("call-reviewed-bash", { durationMs: 800 });

  const lines = plainLines(
    bash.renderResult(
      textResult("ok"),
      { expanded: false, isPartial: false },
      testTheme(),
      context("call-reviewed-bash", { args }),
    ),
  );

  assert.equal(lines.at(-1), "  ⛨ reviewed · 0.8s");
});

test("an error result still shows the annotation when the call was reviewed", () => {
  const tools = bootStyleTools();
  const write = tools.get("write");
  const args = { path: "a.txt", content: "x" };

  recordReviewAnnotation("call-reviewed-error", { durationMs: 500 });

  const lines = plainLines(
    write.renderResult(
      textResult("boom: permission denied"),
      { expanded: false, isPartial: false },
      testTheme(),
      context("call-reviewed-error", { args, isError: true }),
    ),
  );

  assert.equal(lines[0], "  ⎿  boom: permission denied");
  assert.equal(lines.at(-1), "  ⛨ reviewed · 0.5s");
});

test("a late-arriving annotation triggers invalidate so the line can appear on repaint", () => {
  const tools = bootStyleTools();
  const write = tools.get("write");
  const args = { path: "a.txt", content: "x" };

  let invalidateCalls = 0;
  const ctx = context("call-late-write", {
    args,
    invalidate: () => {
      invalidateCalls += 1;
    },
  });

  const firstRender = plainLines(
    write.renderResult(textResult("ok"), { expanded: false, isPartial: false }, testTheme(), ctx),
  );
  assert.ok(!firstRender.some((line) => line.includes("⛨ reviewed")));
  assert.equal(invalidateCalls, 0);

  recordReviewAnnotation("call-late-write", { durationMs: 2000 });
  assert.equal(invalidateCalls, 1);

  // The repaint invalidate triggers finds the annotation already recorded,
  // renders it, and does not subscribe (and so does not invalidate) again.
  const secondRender = plainLines(
    write.renderResult(textResult("ok"), { expanded: false, isPartial: false }, testTheme(), ctx),
  );
  assert.equal(secondRender.at(-1), "  ⛨ reviewed · 2.0s");
  assert.equal(invalidateCalls, 1);
});
