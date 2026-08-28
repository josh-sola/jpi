import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { renderBackgroundNotification } from "../../modules/background/notification-renderer.ts";

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

function plainLine(
  component: { render(width: number): string[] } | undefined,
  width = 120,
): string {
  if (!component) return "";
  return component
    .render(width)
    .map((line) => stripTerminalSequences(line).trimEnd())
    .join("\n");
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    role: "custom" as const,
    customType: "jpi-background-notification",
    content: "preamble\nmonitor_id: mon-1\ndescription: my monitor\nevent:\nsome output",
    display: true,
    timestamp: 0,
    ...overrides,
  } as any;
}

test("a monitor's terminal completion renders a compact completed/exit-code line", () => {
  const line = plainLine(
    renderBackgroundNotification(
      message({
        details: {
          kind: "monitor",
          id: "mon-1",
          description: "watch build",
          status: "exited",
          exitCode: 0,
        },
      }),
      { expanded: false, outputPad: 1 },
      testTheme(),
    ),
  );

  assert.equal(line, "✓ background: watch build completed · exit 0");
});

test("a monitor's terminal failure renders with the error icon and status verbatim", () => {
  const line = plainLine(
    renderBackgroundNotification(
      message({
        details: {
          kind: "monitor",
          id: "mon-1",
          description: "watch build",
          status: "failed",
          error: "boom",
        },
      }),
      { expanded: false, outputPad: 1 },
      testTheme(),
    ),
  );

  assert.equal(line, "✗ background: watch build failed");
});

test("a mid-run event notification renders the running status", () => {
  const line = plainLine(
    renderBackgroundNotification(
      message({
        details: { kind: "monitor", id: "mon-1", description: "watch build", status: "running" },
      }),
      { expanded: false, outputPad: 1 },
      testTheme(),
    ),
  );

  assert.equal(line, "✓ background: watch build running");
});

test("a plain task's completion (name instead of description) renders the same shape", () => {
  const line = plainLine(
    renderBackgroundNotification(
      message({
        details: { kind: "task", id: "task-1", name: "run tests", status: "exited", exitCode: 1 },
      }),
      { expanded: false, outputPad: 1 },
      testTheme(),
    ),
  );

  assert.equal(line, "✓ background: run tests completed · exit 1");
});

test("missing details falls back to the first content line and never throws", () => {
  assert.doesNotThrow(() => {
    const line = plainLine(
      renderBackgroundNotification(
        message({ details: undefined, content: "\n\nsome raw notification text\nmore" }),
        { expanded: false, outputPad: 1 },
        testTheme(),
      ),
    );
    assert.equal(line, "✓ background: some raw notification text");
  });
});

test("malformed details falls back to a generic label and never throws", () => {
  assert.doesNotThrow(() => {
    const line = plainLine(
      renderBackgroundNotification(
        message({ details: "not an object" as unknown, content: "" }),
        { expanded: false, outputPad: 1 },
        testTheme(),
      ),
    );
    assert.ok(line.includes("background"));
  });
});
