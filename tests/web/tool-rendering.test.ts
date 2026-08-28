/**
 * Rendering tests for web_search and web_fetch: the Claude-Code-style
 * `⏺ Name(arg)` header and the collapsed `⎿` result summary.
 */
import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { recordReviewAnnotation } from "../../src/core/index.ts";
import { createWebSearchTool, type WebSearchDetails } from "../../modules/web/search.ts";
import { createWebFetchTool } from "../../modules/web/fetch.ts";

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

// --- web_search ---

test("web_search renders a ⏺ WebSearch(<query>) header", () => {
  const tool = createWebSearchTool({ runJson: async () => [] });
  const header = tool.renderCall!({ query: "weather in nyc" }, testTheme(), context());
  assert.deepEqual(plainLines(header), ["⏺ WebSearch(weather in nyc)"]);
});

test("web_search summarizes the collapsed result as a result count", () => {
  const tool = createWebSearchTool({ runJson: async () => [] });
  const details: WebSearchDetails = {
    query: "weather",
    results: [
      { title: "A", url: "https://a.example", description: "" },
      { title: "B", url: "https://b.example", description: "" },
    ],
  };
  const result = {
    content: [
      { type: "text", text: "1. A\n   URL: https://a.example\n\n2. B\n   URL: https://b.example" },
    ],
    details,
  };
  const rendered = tool.renderResult!(
    result as any,
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: false }),
  );
  assert.deepEqual(plainLines(rendered), ["  ⎿  Found 2 results"]);
});

test("web_search shows the first error line on the ⎿ line when the result is an error", () => {
  const tool = createWebSearchTool({ runJson: async () => [] });
  const result = { content: [{ type: "text", text: "Ketch returned malformed search output." }] };
  const rendered = tool.renderResult!(
    result as any,
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: true }),
  );
  assert.deepEqual(plainLines(rendered), ["  ⎿  Ketch returned malformed search output."]);
});

test("a reviewed web_search result renders the ⛨ reviewed annotation as its last line", () => {
  const tool = createWebSearchTool({ runJson: async () => [] });
  recordReviewAnnotation("call-reviewed-search", { durationMs: 600 });
  const details: WebSearchDetails = { query: "weather", results: [] };
  const result = { content: [{ type: "text", text: "No web results found." }], details };

  const rendered = tool.renderResult!(
    result as any,
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: false, toolCallId: "call-reviewed-search" }),
  );
  assert.equal(plainLines(rendered).at(-1), "  ⛨ reviewed · 0.6s");
});

// --- web_fetch ---

function fetchTool() {
  return createWebFetchTool({ runner: { runJson: async () => ({}) } });
}

test("web_fetch renders a ⏺ WebFetch(<url>) header", () => {
  const tool = fetchTool();
  const header = tool.renderCall!(
    { url: "https://example.com/page", prompt: "what is this page about" },
    testTheme(),
    context(),
  );
  assert.deepEqual(plainLines(header), ["⏺ WebFetch(https://example.com/page)"]);
});

test("web_fetch summarizes the collapsed result as fetched KB", () => {
  const tool = fetchTool();
  const result = { content: [{ type: "text", text: "x".repeat(2048) }] };
  const rendered = tool.renderResult!(
    result as any,
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: false }),
  );
  assert.deepEqual(plainLines(rendered), ["  ⎿  Fetched 2.0KB"]);
});

test("web_fetch shows the first error line on the ⎿ line when the result is an error", () => {
  const tool = fetchTool();
  const result = {
    content: [{ type: "text", text: "web_fetch only accepts HTTP and HTTPS URLs." }],
  };
  const rendered = tool.renderResult!(
    result as any,
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: true }),
  );
  assert.deepEqual(plainLines(rendered), ["  ⎿  web_fetch only accepts HTTP and HTTPS URLs."]);
});
