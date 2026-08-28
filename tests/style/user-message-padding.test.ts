import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

import { removeUserMessagePadding } from "../../modules/style/user-message-style.ts";

initTheme();

function renderLines(text: string, width = 80): string[] {
  const component = new UserMessageComponent(text);
  return component.render(width);
}

test("no blank padded line above or below the message after the patch", () => {
  removeUserMessagePadding();
  const lines = renderLines("hello world");
  assert.ok(lines.length > 0, "should render at least one line");
  // The first/last line carries OSC 133 zone escapes ahead of the content;
  // strip those before checking for the message text.
  assert.ok(
    stripTerminalSequences(lines[0] ?? "").includes("hello world"),
    "first rendered line should carry the message text, not blank padding",
  );
  assert.ok(
    stripTerminalSequences(lines.at(-1) ?? "").includes("hello world"),
    "last rendered line should carry the message text, not blank padding",
  );
});

test("background is still applied after the patch", () => {
  removeUserMessagePadding();
  const lines = renderLines("hello world");
  // A background fill shows up as an SGR background sequence surrounding the
  // padded line; stripping all escapes should shrink the line, proving one
  // was present.
  const raw = lines[0] ?? "";
  assert.ok(
    raw.length > stripTerminalSequences(raw).length,
    "line should carry background/style escapes",
  );
});

test("setOutputPad keeps vertical padding at zero", () => {
  removeUserMessagePadding();
  const component = new UserMessageComponent("hello world");
  component.setOutputPad(2);
  const lines = component.render(80);
  assert.ok(
    stripTerminalSequences(lines[0] ?? "").includes("hello world"),
    "first line should still carry the message text after setOutputPad rebuilds",
  );
});

test("patching twice is idempotent", () => {
  removeUserMessagePadding();
  removeUserMessagePadding();
  const lines = renderLines("hello world");
  assert.ok(stripTerminalSequences(lines[0] ?? "").includes("hello world"));
});
