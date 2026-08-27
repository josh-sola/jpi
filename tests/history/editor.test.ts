import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

import { HistoryEditor, spliceGhostText } from "../../modules/history/editor.ts";

// Editor's constructor only stores tui/theme, and CustomEditor.handleInput
// checks app keybindings before falling through to plain text editing, so a
// keybindings stub that matches nothing is enough to exercise both in
// isolation.
function newEditor(): HistoryEditor {
  const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
  const theme = { borderColor: (text: string) => text } as unknown as EditorTheme;
  const keybindings = { matches: () => false } as unknown as KeybindingsManager;
  return new HistoryEditor(tui, theme, keybindings);
}

function historyOf(editor: HistoryEditor): string[] {
  return (editor as unknown as { history: string[] }).history;
}

function ghostOf(editor: HistoryEditor): string | undefined {
  return (editor as unknown as { ghost: string | undefined }).ghost;
}

test("seedHistory seeds oldest first, then replays pre-seed submissions so they stay newest", () => {
  const editor = newEditor();

  // Submitted while the async prompt scan was still running.
  editor.addToHistory("typed while scan was running #1");
  editor.addToHistory("typed while scan was running #2");

  editor.seedHistory(["oldest seed", "middle seed", "newest seed"]);

  assert.deepEqual(historyOf(editor), [
    "typed while scan was running #2",
    "typed while scan was running #1",
    "newest seed",
    "middle seed",
    "oldest seed",
    "typed while scan was running #2",
    "typed while scan was running #1",
  ]);
});

test("seedHistory is a no-op after the first call", () => {
  const editor = newEditor();

  editor.seedHistory(["a", "b"]);
  const afterFirstSeed = historyOf(editor).slice();

  editor.seedHistory(["c", "d"]);

  assert.deepEqual(historyOf(editor), afterFirstSeed);
});

test("addToHistory fires onPromptRecorded with trimmed text", () => {
  const editor = newEditor();
  const recorded: string[] = [];
  editor.onPromptRecorded = (text) => recorded.push(text);

  editor.addToHistory("  padded  ");

  assert.deepEqual(recorded, ["padded"]);
});

test("addToHistory does not fire onPromptRecorded for whitespace-only input", () => {
  const editor = newEditor();
  const recorded: string[] = [];
  editor.onPromptRecorded = (text) => recorded.push(text);

  editor.addToHistory("   ");

  assert.deepEqual(recorded, []);
});

test("handleInput fires onHistorySearch on ctrl+r without reaching the base editor", () => {
  const editor = newEditor();
  let fired = 0;
  editor.onHistorySearch = () => {
    fired++;
  };

  editor.handleInput("\x12");

  assert.equal(fired, 1);
});

test("handleInput does not fire onHistorySearch for a plain printable character", () => {
  const editor = newEditor();
  let fired = 0;
  editor.onHistorySearch = () => {
    fired++;
  };

  editor.handleInput("r");

  assert.equal(fired, 0);
});

test("Tab accepts a set ghost and clears it", () => {
  const editor = newEditor();
  editor.setGhostText("run the tests");

  editor.handleInput("\t");

  assert.equal(editor.getText(), "run the tests");
  assert.equal(ghostOf(editor), undefined);
});

test("Tab falls through to normal editing when no ghost is set", () => {
  const editor = newEditor();
  editor.handleInput("a");

  editor.handleInput("\t");

  assert.equal(editor.getText(), "a");
});

test("typing a character clears a pending ghost", () => {
  const editor = newEditor();
  editor.setGhostText("run the tests");

  editor.handleInput("x");

  assert.equal(ghostOf(editor), undefined);
});

test("setGhostText no-ops when the editor already has text", () => {
  const editor = newEditor();
  editor.handleInput("a");

  editor.setGhostText("run the tests");

  assert.equal(ghostOf(editor), undefined);
});

test("render shows the dim ghost text inline after the cursor when the editor is empty", () => {
  const editor = newEditor();
  editor.focused = true;
  editor.dim = (text) => `[dim]${text}[/dim]`;
  editor.setGhostText("run the tests");

  const lines = editor.render(80);

  assert.ok(lines.some((line) => line.includes("[dim]run the tests  (tab to accept)[/dim]")));
});

test("render leaves output unstyled when dim was never assigned", () => {
  const editor = newEditor();
  editor.setGhostText("run the tests");

  const lines = editor.render(80);

  assert.ok(lines.some((line) => line.includes("run the tests  (tab to accept)")));
});

test("spliceGhostText inserts right after the cursor marker when a line carries one", () => {
  const dim = (text: string) => `[dim]${text}[/dim]`;

  const lines = spliceGhostText(["before\x1b[7m \x1b[0mafter"], "run the tests", dim);

  assert.deepEqual(lines, ["before\x1b[7m \x1b[0m[dim]run the tests  (tab to accept)[/dim]after"]);
});

test("spliceGhostText falls back to a line below the editor when no line carries the marker", () => {
  const dim = (text: string) => `[dim]${text}[/dim]`;

  const lines = spliceGhostText(["a line with no cursor marker on it"], "run the tests", dim);

  assert.deepEqual(lines, [
    "a line with no cursor marker on it",
    "  [dim]run the tests  (tab to accept)[/dim]",
  ]);
});
