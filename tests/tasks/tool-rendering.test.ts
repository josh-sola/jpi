/**
 * Rendering tests for TaskCreate/TaskList/TaskGet/TaskUpdate: the
 * Claude-Code-style `⏺ Name(arg)` header and the collapsed `⎿` result summary.
 */
import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { initTasksExtension } from "./helpers/init-extension.ts";
import { mockPi } from "./helpers/mock-pi.ts";

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

async function setUp() {
  const mock = mockPi();
  await initTasksExtension(mock.pi as any);
  const created = await mock.executeTool("TaskCreate", {
    subject: "Fix bug",
    description: "Investigate and fix the login bug",
  });
  const match = created.content[0].text.match(/^Task #(\S+) created successfully/);
  if (!match) throw new Error(`unexpected TaskCreate result: ${created.content[0].text}`);
  return { mock, taskId: match[1] as string, created };
}

test("TaskCreate renders a ⏺ TaskCreate(<title>) header and a created-task summary", async () => {
  const { mock, taskId, created } = await setUp();
  const TaskCreate = mock.tools.get("TaskCreate");

  const header = TaskCreate.renderCall(
    { subject: "Fix bug", description: "..." },
    testTheme(),
    context(),
  );
  assert.deepEqual(plainLines(header), ["⏺ TaskCreate(Fix bug)"]);

  const rendered = TaskCreate.renderResult(
    created,
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: false }),
  );
  assert.deepEqual(plainLines(rendered), [`  ⎿  Created task ${taskId}`]);
});

test("TaskList renders a ⏺ TaskList() header and a task-count summary", async () => {
  const { mock } = await setUp();
  const TaskList = mock.tools.get("TaskList");

  const header = TaskList.renderCall({}, testTheme(), context());
  assert.deepEqual(plainLines(header), ["⏺ TaskList()"]);

  const listResult = await mock.executeTool("TaskList", {});
  const rendered = TaskList.renderResult(
    listResult,
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: false }),
  );
  assert.deepEqual(plainLines(rendered), ["  ⎿  1 task"]);
});

test("TaskGet renders a ⏺ TaskGet(<id>) header and the task's title as the summary", async () => {
  const { mock, taskId } = await setUp();
  const TaskGet = mock.tools.get("TaskGet");

  const header = TaskGet.renderCall({ taskId }, testTheme(), context({ args: { taskId } }));
  assert.deepEqual(plainLines(header), [`⏺ TaskGet(${taskId})`]);

  const getResult = await mock.executeTool("TaskGet", { taskId });
  const rendered = TaskGet.renderResult(
    getResult,
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: false, args: { taskId } }),
  );
  assert.deepEqual(plainLines(rendered), ["  ⎿  Fix bug"]);
});

test("TaskUpdate renders a ⏺ TaskUpdate(<id>) header and prefers the task's title in the summary", async () => {
  const { mock, taskId } = await setUp();
  const TaskUpdate = mock.tools.get("TaskUpdate");

  const header = TaskUpdate.renderCall(
    { taskId, status: "in_progress" },
    testTheme(),
    context({ args: { taskId } }),
  );
  assert.deepEqual(plainLines(header), [`⏺ TaskUpdate(${taskId})`]);

  const updateResult = await mock.executeTool("TaskUpdate", { taskId, status: "in_progress" });
  const rendered = TaskUpdate.renderResult(
    updateResult,
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: false, args: { taskId } }),
  );
  assert.deepEqual(plainLines(rendered), ["  ⎿  Updated Fix bug"]);
});

test("TaskGet shows the first error line on the ⎿ line when the result is an error", async () => {
  const { mock, taskId } = await setUp();
  const TaskGet = mock.tools.get("TaskGet");

  const errorResult = { content: [{ type: "text", text: "Store read failed" }] };
  const rendered = TaskGet.renderResult(
    errorResult,
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: true, args: { taskId } }),
  );
  assert.deepEqual(plainLines(rendered), ["  ⎿  Store read failed"]);
});
