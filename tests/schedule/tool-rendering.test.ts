/**
 * Rendering tests for the schedule/list_schedules/stop_schedule tools: the
 * Claude-Code-style `⏺ Name(arg)` header and the collapsed `⎿` result summary.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vite-plus/test";

import { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { Store } from "../../src/core/index.ts";
import { ScheduleRegistry } from "../../modules/schedule/registry.ts";
import { createScheduleTools } from "../../modules/schedule/tools.ts";

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

function textResult(text: string): any {
  return { content: [{ type: "text", text }], details: undefined };
}

const agentDir = await mkdtemp(join(tmpdir(), "jpi-schedule-rendering-"));
afterAll(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

function setUp() {
  const store = new Store("schedule", { PI_CODING_AGENT_DIR: agentDir });
  const registry = new ScheduleRegistry({
    store,
    sendNotification: () => undefined,
  });
  const tools = new Map(createScheduleTools({ registry }).map((tool) => [tool.name, tool]));
  return { registry, tools };
}

test("schedule renders a ⏺ Schedule(<cron>) header", () => {
  const { tools } = setUp();
  const header = tools.get("schedule")!.renderCall!(
    { prompt: "ping", cron: "0 9 * * *" },
    testTheme(),
    context(),
  );
  assert.deepEqual(plainLines(header), ["⏺ Schedule(0 9 * * *)"]);
});

test("list_schedules renders a literal ⏺ Schedule(list) header", () => {
  const { tools } = setUp();
  const header = tools.get("list_schedules")!.renderCall!({}, testTheme(), context());
  assert.deepEqual(plainLines(header), ["⏺ Schedule(list)"]);
});

test("stop_schedule renders a ⏺ Schedule(stop: <id>) header", () => {
  const { tools } = setUp();
  const header = tools.get("stop_schedule")!.renderCall!({ id: "abc123" }, testTheme(), context());
  assert.deepEqual(plainLines(header), ["⏺ Schedule(stop: abc123)"]);
});

test("a successful result renders its first line on the ⎿ line", () => {
  const { tools } = setUp();
  const rendered = tools.get("schedule")!.renderResult!(
    textResult('Scheduled s1a2b3c4 (cron "*/5 * * * *"). Next run: 2026-01-01T00:05:00.000Z.'),
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: false }),
  );
  assert.deepEqual(plainLines(rendered), [
    '  ⎿  Scheduled s1a2b3c4 (cron "*/5 * * * *"). Next run: 2026-01-01T00:05:00.000Z.',
  ]);
});

test("stop_schedule shows the first error line on the ⎿ line when the result is an error", () => {
  const { tools } = setUp();
  const rendered = tools.get("stop_schedule")!.renderResult!(
    textResult('No scheduled prompt matches id "nope"'),
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: true }),
  );
  assert.deepEqual(plainLines(rendered), ['  ⎿  No scheduled prompt matches id "nope"']);
});
