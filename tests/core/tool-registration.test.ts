import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { Theme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text } from "@earendil-works/pi-tui";

import { decorateToolRegistration } from "../../src/core/tool-registration.ts";
import {
  hasReviewAnnotationConsumer,
  recordReviewAnnotation,
} from "../../src/core/review-annotations.ts";

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

/** Registers `def` through the decorator against a fake pi and returns the registered definition. */
function registerThrough(fakeRegisterTool: (tool: any) => void, def: any): void {
  decorateToolRegistration({ registerTool: fakeRegisterTool } as any).registerTool(def);
}

test("a tool with renderResult is marked as a review-annotation consumer", () => {
  const registered = new Map<string, any>();
  registerThrough((tool) => registered.set(tool.name, tool), {
    name: "with-render",
    renderResult: () => new Text("ok", 0, 0),
  });

  assert.equal(hasReviewAnnotationConsumer("with-render"), true);
  assert.ok(registered.has("with-render"));
});

test("a tool without renderResult passes through unmarked and unwrapped", () => {
  const registered = new Map<string, any>();
  const def = { name: "no-render" };
  registerThrough((tool) => registered.set(tool.name, tool), def);

  assert.equal(hasReviewAnnotationConsumer("no-render"), false);
  assert.equal(registered.get("no-render"), def);
});

test("a reviewed result carries the annotation as its final line", () => {
  const registered = new Map<string, any>();
  registerThrough((tool) => registered.set(tool.name, tool), {
    name: "reviewed-tool",
    renderResult: () => {
      const container = new Container();
      container.addChild(new Text("  ⎿  done", 0, 0));
      return container;
    },
  });

  recordReviewAnnotation("call-reviewed", { durationMs: 1200 });
  const rendered = registered
    .get("reviewed-tool")
    .renderResult(
      {},
      { isPartial: false, expanded: false },
      testTheme(),
      context({ toolCallId: "call-reviewed" }),
    );

  const lines = plainLines(rendered);
  assert.equal(lines[0], "  ⎿  done");
  assert.equal(lines.at(-1), "  ⛨ reviewed · 1.2s");
});

test("an unreviewed result has no annotation line and subscribes for a late arrival", () => {
  const registered = new Map<string, any>();
  registerThrough((tool) => registered.set(tool.name, tool), {
    name: "late-tool",
    renderResult: () => new Text("  ⎿  done", 0, 0),
  });

  let invalidateCalls = 0;
  const ctx = context({
    toolCallId: "call-late",
    invalidate: () => {
      invalidateCalls += 1;
    },
  });

  const firstRender = plainLines(
    registered
      .get("late-tool")
      .renderResult({}, { isPartial: false, expanded: false }, testTheme(), ctx),
  );
  assert.ok(!firstRender.some((line) => line.includes("⛨ reviewed")));
  assert.equal(invalidateCalls, 0);

  recordReviewAnnotation("call-late", { durationMs: 2000 });
  assert.equal(invalidateCalls, 1);

  const secondRender = plainLines(
    registered
      .get("late-tool")
      .renderResult({}, { isPartial: false, expanded: false }, testTheme(), ctx),
  );
  assert.equal(secondRender.at(-1), "  ⛨ reviewed · 2.0s");
  assert.equal(invalidateCalls, 1);
});

test("a partial result is returned untouched, with no annotation and no subscription", () => {
  const registered = new Map<string, any>();
  let renders = 0;
  registerThrough((tool) => registered.set(tool.name, tool), {
    name: "partial-tool",
    renderResult: () => {
      renders += 1;
      return new Text("partial", 0, 0);
    },
  });

  recordReviewAnnotation("call-partial", { durationMs: 100 });
  const rendered = registered
    .get("partial-tool")
    .renderResult(
      {},
      { isPartial: true, expanded: false },
      testTheme(),
      context({ toolCallId: "call-partial" }),
    );

  assert.equal(renders, 1);
  assert.equal(rendered instanceof Container, false);
  assert.deepEqual(plainLines(rendered), ["partial"]);
});

test("a non-Container component still gets wrapped with the annotation line", () => {
  const registered = new Map<string, any>();
  registerThrough((tool) => registered.set(tool.name, tool), {
    name: "plain-text-tool",
    renderResult: () => new Text("  ⎿  bare text component", 0, 0),
  });

  recordReviewAnnotation("call-plain-text", { durationMs: 300 });
  const rendered = registered
    .get("plain-text-tool")
    .renderResult(
      {},
      { isPartial: false, expanded: false },
      testTheme(),
      context({ toolCallId: "call-plain-text" }),
    );

  assert.ok(rendered instanceof Container);
  const lines = plainLines(rendered);
  assert.equal(lines[0], "  ⎿  bare text component");
  assert.equal(lines.at(-1), "  ⛨ reviewed · 0.3s");
});
