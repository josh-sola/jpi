/**
 * Rendering tests for the bg_* tools and `run`: the Claude-Code-style
 * `⏺ Name(arg)` header and the collapsed `⎿` result summary.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vite-plus/test";

import { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { recordReviewAnnotation, Store } from "../../src/core/index.ts";
import { DetachRegistry } from "../../modules/background/detach.ts";
import { MonitorManager } from "../../modules/background/monitor.ts";
import { BackgroundTaskRegistry } from "../../modules/background/registry.ts";
import { createBackgroundTools, createRunTool } from "../../modules/background/tools.ts";

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

const agentDir = await mkdtemp(join(tmpdir(), "jpi-background-rendering-"));
const store = new Store("background", { PI_CODING_AGENT_DIR: agentDir });
afterAll(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

function setUp() {
  const registry = new BackgroundTaskRegistry({
    store,
    sendNotification: () => undefined,
    killGraceMs: 300,
    stopWaitMs: 1500,
    logger: { error: () => undefined },
  });
  const monitors = new MonitorManager({
    registry,
    sendNotification: () => undefined,
    logger: { error: () => undefined },
  });
  const tools = new Map(createBackgroundTools({ registry, monitors }).map((t) => [t.name, t]));
  const runTool = createRunTool({
    registry,
    detach: new DetachRegistry(),
    defaultTimeoutSeconds: undefined,
  });
  return { tools, runTool };
}

test("bg_status renders a literal ⏺ Background(status) header", () => {
  const { tools } = setUp();
  const header = tools.get("bg_status")!.renderCall!({}, testTheme(), context());
  assert.deepEqual(plainLines(header), ["⏺ Background(status)"]);
});

test("bg_logs renders a ⏺ Background(logs: <id>) header", () => {
  const { tools } = setUp();
  const header = tools.get("bg_logs")!.renderCall!({ taskId: "abc123" }, testTheme(), context());
  assert.deepEqual(plainLines(header), ["⏺ Background(logs: abc123)"]);
});

test("bg_kill renders a ⏺ Background(kill: <id>) header", () => {
  const { tools } = setUp();
  const header = tools.get("bg_kill")!.renderCall!({ taskId: "abc123" }, testTheme(), context());
  assert.deepEqual(plainLines(header), ["⏺ Background(kill: abc123)"]);
});

test("bg_monitor renders a ⏺ Background(monitor: <description>) header", () => {
  const { tools } = setUp();
  const header = tools.get("bg_monitor")!.renderCall!(
    { command: "tail -f log", description: "watch for OOM" },
    testTheme(),
    context(),
  );
  assert.deepEqual(plainLines(header), ["⏺ Background(monitor: watch for OOM)"]);
});

test("bg_status summarizes a multi-line result as first line + remaining count", () => {
  const { tools } = setUp();
  const rendered = tools.get("bg_status")!.renderResult!(
    textResult(
      "task abc (build): running [12s]\n  output: /tmp/a\n\ntask def (test): completed [3s]\n  output: /tmp/b",
    ),
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: false }),
  );
  assert.deepEqual(plainLines(rendered), ["  ⎿  task abc (build): running [12s] … +4 lines"]);
});

test("run renders a ⏺ Run(<command>) header from the script's first line", () => {
  const { runTool } = setUp();
  const header = runTool.renderCall!(
    { language: "zsh", script: "echo hello\necho world" },
    testTheme(),
    context(),
  );
  assert.deepEqual(plainLines(header), ["⏺ Run(echo hello)"]);
});

test("a reviewed run result renders the ⛨ reviewed annotation as its last line", () => {
  const { runTool } = setUp();
  recordReviewAnnotation("call-reviewed-run", { durationMs: 1500 });

  const rendered = runTool.renderResult!(
    textResult("done"),
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: false, toolCallId: "call-reviewed-run" }),
  );
  assert.equal(plainLines(rendered).at(-1), "  ⛨ reviewed · 1.5s");
});

test("bg_kill shows the first error line on the ⎿ line when the result is an error", () => {
  const { tools } = setUp();
  const rendered = tools.get("bg_kill")!.renderResult!(
    textResult("Unknown task id: nope"),
    { isPartial: false, expanded: false },
    testTheme(),
    context({ isError: true }),
  );
  assert.deepEqual(plainLines(rendered), ["  ⎿  Unknown task id: nope"]);
});
