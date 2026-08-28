import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { initTheme, type KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";

import { BtwOverlay, type BtwOverlayState } from "../../modules/btw/overlay.ts";

// The markdown body reads pi's global theme singleton via getMarkdownTheme();
// real only once initTheme() has run (see resolveMarkdownTheme's docstring).
initTheme();

// Theme's constructor eagerly computes an ANSI code for every color it
// knows about, so a real instance needs the full name lists, not just the
// handful (accent/success/error/muted/dim/border) this module reads.
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

// A structural stand-in for pi-tui's real KeybindingsManager: jpi depends on
// its own copy of pi-tui, which isn't the same class instance as the one
// nested inside pi-coding-agent, so constructing the real thing here would
// fail BtwOverlay's type check on a private-field mismatch.
const DEFAULT_BINDINGS: Record<string, KeyId | KeyId[]> = {
  "tui.select.cancel": ["escape", "ctrl+c"],
  "tui.select.up": "up",
  "tui.select.down": "down",
  "tui.select.pageUp": "pageUp",
  "tui.select.pageDown": "pageDown",
};

const keybindings = {
  matches: (data: string, id: string) => {
    const keys = DEFAULT_BINDINGS[id];
    if (!keys) return false;
    return Array.isArray(keys) ? keys.some((key) => matchesKey(data, key)) : matchesKey(data, keys);
  },
} as unknown as KeybindingsManager;

function fakeTui(rows: number): TUI {
  return { requestRender: () => {}, terminal: { rows, columns: 80 } } as unknown as TUI;
}

function plainLines(overlay: BtwOverlay, width = 80): string[] {
  return overlay.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

const ESC = "\x1b";
const HOME = "\x1b[H";
const END = "\x1b[F";
const PAGE_DOWN = "\x1b[6~";

test("the asking state shows the question and a spinner, and closing stops it", () => {
  const overlay = new BtwOverlay(
    fakeTui(40),
    testTheme(),
    keybindings,
    { status: "asking", question: "what does this module do" },
    () => {},
  );

  const lines = plainLines(overlay);
  assert.ok(lines.some((line) => line.includes("what does this module do")));
  assert.ok(lines.some((line) => line.includes("thinking")));
  assert.ok(lines.some((line) => line.includes("esc close")));

  overlay.dispose();
});

test("the done state renders the answer as markdown under a success glyph", () => {
  let closed = false;
  const overlay = new BtwOverlay(
    fakeTui(40),
    testTheme(),
    keybindings,
    { status: "done", question: "what is this", answer: "**bold** plain text" },
    () => {
      closed = true;
    },
  );

  const lines = plainLines(overlay);
  assert.ok(lines.some((line) => line.includes("✓")));
  assert.ok(lines.some((line) => line.includes("what is this")));
  assert.ok(lines.some((line) => line.includes("bold plain text")));

  overlay.handleInput(ESC);
  assert.equal(closed, true);
});

test("the error state renders the error message under an error glyph", () => {
  const overlay = new BtwOverlay(
    fakeTui(40),
    testTheme(),
    keybindings,
    { status: "error", question: "q", message: "busy compacting — try again" },
    () => {},
  );

  const lines = plainLines(overlay);
  assert.ok(lines.some((line) => line.includes("✗")));
  assert.ok(lines.some((line) => line.includes("busy compacting")));
});

test("setState swaps in a new exchange on the same instance", () => {
  const overlay = new BtwOverlay(
    fakeTui(40),
    testTheme(),
    keybindings,
    { status: "asking", question: "first" },
    () => {},
  );

  overlay.setState({ status: "done", question: "second", answer: "second answer" });

  const lines = plainLines(overlay);
  assert.ok(lines.some((line) => line.includes("second")));
  assert.ok(lines.some((line) => line.includes("second answer")));
  assert.ok(!lines.some((line) => line.includes("first")));
});

test("every rendered line is padded flush to the requested width", () => {
  const overlay = new BtwOverlay(
    fakeTui(40),
    testTheme(),
    keybindings,
    { status: "done", question: "q", answer: "short answer" },
    () => {},
  );

  for (const line of plainLines(overlay, 60)) {
    assert.equal(line.length, 60, `line ${JSON.stringify(line)} is not padded to width`);
  }
});

test("scroll: an overlong answer opens at the top, and End/Home jump the ends", () => {
  const words = Array.from({ length: 400 }, (_unused, index) => `word${index}`);
  const state: BtwOverlayState = { status: "done", question: "q", answer: words.join(" ") };
  // 10 rows -> viewport = max(3, floor(10 * 0.8) - 5) = 3 body lines, forcing scrolling.
  const overlay = new BtwOverlay(fakeTui(10), testTheme(), keybindings, state, () => {});

  const initial = plainLines(overlay).join("\n");
  assert.ok(initial.includes("word0 "), "expected the answer to open at its top");
  assert.ok(
    !initial.includes("word399"),
    "expected the bottom of a long answer to be scrolled out of view",
  );

  overlay.handleInput(END);
  const bottom = plainLines(overlay).join("\n");
  assert.ok(bottom.includes("word399"), "expected End to jump to the bottom");

  overlay.handleInput(HOME);
  const top = plainLines(overlay).join("\n");
  assert.ok(top.includes("word0 "), "expected Home to jump back to the top");
});

test("scroll: PageDown moves the viewport down", () => {
  const words = Array.from({ length: 400 }, (_unused, index) => `word${index}`);
  const state: BtwOverlayState = { status: "done", question: "q", answer: words.join(" ") };
  const overlay = new BtwOverlay(fakeTui(10), testTheme(), keybindings, state, () => {});

  const initial = plainLines(overlay).join("\n");

  overlay.handleInput(PAGE_DOWN);
  const afterPageDown = plainLines(overlay).join("\n");

  assert.notEqual(initial, afterPageDown, "expected PageDown to move the viewport");
});
