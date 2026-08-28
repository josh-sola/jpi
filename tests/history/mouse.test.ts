import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { Editor, TUI, TuiInputListenerResult } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  applySelectionHighlightToRow,
  columnToStringIndex,
  computeLayoutWidth,
  computeMaxVisibleLines,
  computePaddingX,
  computeRowHighlightRange,
  deleteRangeFromLines,
  installMouseSupport,
  isLeftButtonRelevant,
  isMotionEvent,
  isRightButton,
  isWheelEvent,
  mapScreenPointToPosition,
  normalizeSelection,
  parseSgrMouseEvent,
  type Position,
  type Selection,
  type VisualLine,
} from "../../modules/history/mouse.ts";

function sgr(button: number, col: number, row: number, release = false): string {
  return `\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`;
}

// --- SGR parsing ------------------------------------------------------------

test("parseSgrMouseEvent decodes a press, converting to 0-based coordinates", () => {
  assert.deepEqual(parseSgrMouseEvent(sgr(0, 4, 2)), { button: 0, x: 4, y: 2, release: false });
});

test("parseSgrMouseEvent decodes a release", () => {
  assert.deepEqual(parseSgrMouseEvent(sgr(0, 4, 2, true)), {
    button: 0,
    x: 4,
    y: 2,
    release: true,
  });
});

test("parseSgrMouseEvent returns undefined for non-mouse input", () => {
  assert.equal(parseSgrMouseEvent("a"), undefined);
  assert.equal(parseSgrMouseEvent("\x1b[I"), undefined);
});

test("button classification", () => {
  assert.equal(isWheelEvent({ button: 64, x: 0, y: 0, release: false }), true);
  assert.equal(isWheelEvent({ button: 65, x: 0, y: 0, release: false }), true);
  assert.equal(isWheelEvent({ button: 0, x: 0, y: 0, release: false }), false);

  assert.equal(isRightButton({ button: 2, x: 0, y: 0, release: false }), true);
  assert.equal(isRightButton({ button: 0, x: 0, y: 0, release: false }), false);

  assert.equal(isMotionEvent({ button: 32, x: 0, y: 0, release: false }), true);
  assert.equal(isMotionEvent({ button: 0, x: 0, y: 0, release: false }), false);

  assert.equal(isLeftButtonRelevant({ button: 0, x: 0, y: 0, release: false }), true);
  assert.equal(isLeftButtonRelevant({ button: 32, x: 0, y: 0, release: false }), true);
  assert.equal(isLeftButtonRelevant({ button: 1, x: 0, y: 0, release: false }), false);
  assert.equal(isLeftButtonRelevant({ button: 2, x: 0, y: 0, release: false }), false);
  assert.equal(isLeftButtonRelevant({ button: 3, x: 0, y: 0, release: true }), true);
  assert.equal(isLeftButtonRelevant({ button: 3, x: 0, y: 0, release: false }), false);
});

// --- Layout geometry helpers -------------------------------------------------

test("computePaddingX clamps to the same max as Editor#render", () => {
  assert.equal(computePaddingX(2, 10), 2);
  assert.equal(computePaddingX(10, 10), 4);
});

test("computeLayoutWidth mirrors Editor#render's layout-width formula", () => {
  assert.equal(computeLayoutWidth(10, 0), 9);
  assert.equal(computeLayoutWidth(10, 2), 6);
});

test("computeMaxVisibleLines mirrors Editor#render's 30% floor of 5", () => {
  assert.equal(computeMaxVisibleLines(40), 12);
  assert.equal(computeMaxVisibleLines(10), 5);
});

test("columnToStringIndex walks graphemes so a wide character counts once", () => {
  const text = "a你b"; // a, 你 (width 2), b
  assert.equal(columnToStringIndex(text, 0), 0);
  assert.equal(columnToStringIndex(text, 1), 1);
  assert.equal(columnToStringIndex(text, 2), 1, "clicking mid-cell snaps to the wide char's start");
  assert.equal(columnToStringIndex(text, 3), 2);
  assert.equal(columnToStringIndex(text, 99), text.length);
});

// --- Click -> position mapping ----------------------------------------------

test("mapScreenPointToPosition maps a click inside a single unwrapped line", () => {
  const visualLines: VisualLine[] = [{ logicalLine: 0, startCol: 0, length: 11 }];
  const position = mapScreenPointToPosition({
    rectX: 2,
    rectY: 1,
    rectWidth: 20,
    paddingX: 1,
    scrollOffset: 0,
    visualLines,
    lines: ["hello world"],
    screenX: 2 + 1 + 3,
    screenY: 1 + 1,
  });
  assert.deepEqual(position, { line: 0, col: 3 });
});

test("mapScreenPointToPosition clamps a click past the end of the line", () => {
  const visualLines: VisualLine[] = [{ logicalLine: 0, startCol: 0, length: 11 }];
  const position = mapScreenPointToPosition({
    rectX: 0,
    rectY: 0,
    rectWidth: 20,
    paddingX: 0,
    scrollOffset: 0,
    visualLines,
    lines: ["hello world"],
    screenX: 50,
    screenY: 1,
  });
  assert.deepEqual(position, { line: 0, col: 11 });
});

test("mapScreenPointToPosition clamps a click above the text rows to the first row", () => {
  const visualLines: VisualLine[] = [{ logicalLine: 0, startCol: 0, length: 11 }];
  const position = mapScreenPointToPosition({
    rectX: 0,
    rectY: 5,
    rectWidth: 20,
    paddingX: 0,
    scrollOffset: 0,
    visualLines,
    lines: ["hello world"],
    screenX: 0,
    screenY: 0, // the top border row, above the text
  });
  assert.deepEqual(position, { line: 0, col: 0 });
});

test("mapScreenPointToPosition offsets by startCol on a word-wrapped continuation row", () => {
  const visualLines: VisualLine[] = [
    { logicalLine: 0, startCol: 0, length: 5 },
    { logicalLine: 0, startCol: 5, length: 6 },
  ];
  const position = mapScreenPointToPosition({
    rectX: 0,
    rectY: 0,
    rectWidth: 20,
    paddingX: 0,
    scrollOffset: 0,
    visualLines,
    lines: ["helloworld"],
    screenX: 2,
    screenY: 2, // second text row
  });
  assert.deepEqual(position, { line: 0, col: 7 });
});

test("mapScreenPointToPosition accounts for scrollOffset", () => {
  const visualLines: VisualLine[] = [
    { logicalLine: 0, startCol: 0, length: 3 },
    { logicalLine: 1, startCol: 0, length: 3 },
    { logicalLine: 2, startCol: 0, length: 3 },
  ];
  const position = mapScreenPointToPosition({
    rectX: 0,
    rectY: 0,
    rectWidth: 20,
    paddingX: 0,
    scrollOffset: 1,
    visualLines,
    lines: ["aaa", "bbb", "ccc"],
    screenX: 1,
    screenY: 1, // first visible text row, scrolled to logical line 1
  });
  assert.deepEqual(position, { line: 1, col: 1 });
});

test("mapScreenPointToPosition walks graphemes for a wide-character line", () => {
  const visualLines: VisualLine[] = [{ logicalLine: 0, startCol: 0, length: 3 }];
  const position = mapScreenPointToPosition({
    rectX: 0,
    rectY: 0,
    rectWidth: 20,
    paddingX: 0,
    scrollOffset: 0,
    visualLines,
    lines: ["a你b"],
    screenX: 3, // past the 2-wide 你, into b
    screenY: 1,
  });
  assert.deepEqual(position, { line: 0, col: 2 });
});

// --- Selection normalization -------------------------------------------------

test("normalizeSelection is undefined for no selection or a collapsed one", () => {
  assert.equal(normalizeSelection(undefined), undefined);
  const point: Position = { line: 0, col: 2 };
  assert.equal(normalizeSelection({ anchor: point, focus: point }), undefined);
});

test("normalizeSelection orders start before end for a forward drag", () => {
  const selection: Selection = { anchor: { line: 0, col: 1 }, focus: { line: 0, col: 5 } };
  assert.deepEqual(normalizeSelection(selection), {
    start: selection.anchor,
    end: selection.focus,
  });
});

test("normalizeSelection orders start before end for a backward drag", () => {
  const selection: Selection = { anchor: { line: 2, col: 1 }, focus: { line: 0, col: 5 } };
  assert.deepEqual(normalizeSelection(selection), {
    start: selection.focus,
    end: selection.anchor,
  });
});

// --- Range delete -------------------------------------------------------------

test("deleteRangeFromLines removes a single-line span and lands the cursor at the start", () => {
  const result = deleteRangeFromLines(["hello world"], {
    start: { line: 0, col: 0 },
    end: { line: 0, col: 6 },
  });
  assert.deepEqual(result.lines, ["world"]);
  assert.deepEqual(result.cursor, { line: 0, col: 0 });
});

test("deleteRangeFromLines merges the endpoints of a multi-line span", () => {
  const result = deleteRangeFromLines(["abc", "def", "ghi"], {
    start: { line: 0, col: 1 },
    end: { line: 2, col: 2 },
  });
  assert.deepEqual(result.lines, ["ai"]);
  assert.deepEqual(result.cursor, { line: 0, col: 1 });
});

// --- Highlight rendering -------------------------------------------------------

test("computeRowHighlightRange skips a visual line outside the selection's lines", () => {
  const vl: VisualLine = { logicalLine: 5, startCol: 0, length: 3 };
  const range = { start: { line: 0, col: 0 }, end: { line: 1, col: 0 } };
  assert.equal(computeRowHighlightRange(vl, "abc", range, 0), undefined);
});

test("computeRowHighlightRange highlights a fully-interior blank line in a multi-line selection", () => {
  const vl: VisualLine = { logicalLine: 1, startCol: 0, length: 0 };
  const range = { start: { line: 0, col: 1 }, end: { line: 2, col: 1 } };
  assert.deepEqual(computeRowHighlightRange(vl, "", range, 2), { startCol: 2, endCol: 3 });
});

test("computeRowHighlightRange converts wide characters to visible columns", () => {
  const vl: VisualLine = { logicalLine: 0, startCol: 0, length: 3 };
  const range = { start: { line: 0, col: 1 }, end: { line: 0, col: 3 } };
  assert.deepEqual(computeRowHighlightRange(vl, "a你b", range, 0), { startCol: 1, endCol: 4 });
});

test("applySelectionHighlightToRow preserves the row's total visible width", () => {
  const row = "  hello world  ";
  const highlighted = applySelectionHighlightToRow(row, { startCol: 2, endCol: 7 });
  assert.equal(visibleWidth(highlighted), visibleWidth(row));
  assert.ok(highlighted.includes("\x1b[7m"));
});

// --- installMouseSupport: feature detection and event routing ----------------

interface FakeEditorHandle {
  editor: Editor;
  state: { lines: string[]; cursorLine: number; cursorCol: number };
  snapshots: unknown[];
  onChangeCalls: string[];
}

function fakeEditor(lines: string[]): FakeEditorHandle {
  const state = { lines: [...lines], cursorLine: 0, cursorCol: 0 };
  const snapshots: unknown[] = [];
  const onChangeCalls: string[] = [];
  const obj = {
    state,
    scrollOffset: 0,
    buildVisualLineMap: (_width: number): VisualLine[] =>
      state.lines.map((line, index) => ({ logicalLine: index, startCol: 0, length: line.length })),
    pushUndoSnapshot: () => snapshots.push(structuredClone(state)),
    getPaddingX: () => 0,
    getText: () => state.lines.join("\n"),
    onChange: undefined as ((text: string) => void) | undefined,
  };
  obj.onChange = (text: string) => onChangeCalls.push(text);
  return { editor: obj as unknown as Editor, state, snapshots, onChangeCalls };
}

interface FakeTuiHandle {
  tui: TUI;
  raw: {
    handleViewportInput: (data: string) => TuiInputListenerResult;
    currentLayout: unknown;
    hasOverlay: () => boolean;
  };
  originalCalls: string[];
  original: (data: string) => TuiInputListenerResult;
}

function fakeTui(rows = 40): FakeTuiHandle {
  const originalCalls: string[] = [];
  const original = (data: string): TuiInputListenerResult => {
    originalCalls.push(data);
    return { consume: false };
  };
  const raw = {
    terminal: { rows },
    requestRender: () => {},
    hasOverlay: () => false,
    handleViewportInput: original,
    currentLayout: undefined as unknown,
  };
  return {
    tui: raw as unknown as TUI,
    raw: raw as unknown as FakeTuiHandle["raw"],
    originalCalls,
    original,
  };
}

function mountEditorBox(
  tuiHandle: FakeTuiHandle,
  editor: Editor,
  rect: { x: number; y: number; width: number; height: number },
) {
  (tuiHandle.raw as unknown as { currentLayout: unknown }).currentLayout = {
    root: { component: editor, rect, clip: rect, children: [] },
  };
}

test("installMouseSupport returns undefined when the tui has no handleViewportInput to wrap", () => {
  const { editor } = fakeEditor(["hello"]);
  const tui = {
    terminal: { rows: 40 },
    requestRender: () => {},
    hasOverlay: () => false,
  } as unknown as TUI;

  assert.equal(installMouseSupport(tui, editor), undefined);
});

test("installMouseSupport returns undefined when currentLayout isn't a tracked property", () => {
  const { editor } = fakeEditor(["hello"]);
  const tui = {
    terminal: { rows: 40 },
    requestRender: () => {},
    hasOverlay: () => false,
    handleViewportInput: (_data: string) => undefined,
  } as unknown as TUI;

  assert.equal(installMouseSupport(tui, editor), undefined);
});

test("installMouseSupport returns undefined when the editor is missing a required private field", () => {
  const { tui } = fakeTui();
  const editor = { state: { lines: [], cursorLine: 0, cursorCol: 0 } } as unknown as Editor;

  assert.equal(installMouseSupport(tui, editor), undefined);
});

test("installMouseSupport does not touch handleViewportInput on a feature-detect miss", () => {
  const tuiHandle = fakeTui();
  const editor = { state: { lines: [], cursorLine: 0, cursorCol: 0 } } as unknown as Editor;

  installMouseSupport(tuiHandle.tui, editor);

  assert.equal(tuiHandle.raw.handleViewportInput, tuiHandle.original);
});

test("wheel, right-click, and clicks outside the editor delegate untouched", () => {
  const { editor } = fakeEditor(["hello world"]);
  const tuiHandle = fakeTui();
  mountEditorBox(tuiHandle, editor, { x: 0, y: 0, width: 20, height: 5 });
  const mouse = installMouseSupport(tuiHandle.tui, editor);
  assert.ok(mouse);

  const wheel = "\x1b[<64;3;3M";
  const rightClick = sgr(2, 3, 1);
  const outsideClick = sgr(0, 50, 50);

  for (const data of [wheel, rightClick, outsideClick]) {
    const result = tuiHandle.raw.handleViewportInput(data);
    assert.deepEqual(result, { consume: false });
  }
  assert.deepEqual(tuiHandle.originalCalls, [wheel, rightClick, outsideClick]);
});

test("FOCUS_IN and FOCUS_OUT delegate untouched", () => {
  const { editor } = fakeEditor(["hello"]);
  const tuiHandle = fakeTui();
  mountEditorBox(tuiHandle, editor, { x: 0, y: 0, width: 20, height: 5 });
  installMouseSupport(tuiHandle.tui, editor);

  tuiHandle.raw.handleViewportInput("\x1b[I");
  tuiHandle.raw.handleViewportInput("\x1b[O");

  assert.deepEqual(tuiHandle.originalCalls, ["\x1b[I", "\x1b[O"]);
});

test("everything delegates untouched while an overlay is open", () => {
  const { editor } = fakeEditor(["hello world"]);
  const tuiHandle = fakeTui();
  mountEditorBox(tuiHandle, editor, { x: 0, y: 0, width: 20, height: 5 });
  (tuiHandle.raw as unknown as { hasOverlay: () => boolean }).hasOverlay = () => true;
  installMouseSupport(tuiHandle.tui, editor);

  const press = sgr(0, 2, 1);
  tuiHandle.raw.handleViewportInput(press);

  assert.deepEqual(tuiHandle.originalCalls, [press]);
});

test("a left click inside the editor moves the cursor and consumes the event", () => {
  const { editor, state } = fakeEditor(["hello world"]);
  const tuiHandle = fakeTui();
  mountEditorBox(tuiHandle, editor, { x: 0, y: 0, width: 20, height: 5 });
  installMouseSupport(tuiHandle.tui, editor);

  const result = tuiHandle.raw.handleViewportInput(sgr(0, 3, 1));

  assert.deepEqual(result, { consume: true });
  assert.equal(state.cursorLine, 0);
  assert.equal(state.cursorCol, 3);
  assert.deepEqual(tuiHandle.originalCalls, []);
});

test("a left-drag selects text and the drag keeps ownership even off the editor's rect", () => {
  const { editor, state } = fakeEditor(["hello world"]);
  const tuiHandle = fakeTui();
  mountEditorBox(tuiHandle, editor, { x: 0, y: 0, width: 20, height: 5 });
  const mouse = installMouseSupport(tuiHandle.tui, editor);
  assert.ok(mouse);

  tuiHandle.raw.handleViewportInput(sgr(0, 0, 1));
  const dragResult = tuiHandle.raw.handleViewportInput(sgr(32, 500, 500)); // way outside the box
  const releaseResult = tuiHandle.raw.handleViewportInput(sgr(0, 500, 500, true));

  assert.deepEqual(dragResult, { consume: true });
  assert.deepEqual(releaseResult, { consume: true });
  assert.equal(mouse.hasSelection(), true);
  assert.deepEqual(tuiHandle.originalCalls, []);
  assert.equal(state.cursorCol, 11); // clamped to end of "hello world"
});

test("deleteSelection removes the range as one undo step, notifies onChange, and clears the selection", () => {
  const { editor, state, snapshots, onChangeCalls } = fakeEditor(["hello world"]);
  const tuiHandle = fakeTui();
  mountEditorBox(tuiHandle, editor, { x: 0, y: 0, width: 20, height: 5 });
  const mouse = installMouseSupport(tuiHandle.tui, editor);
  assert.ok(mouse);

  tuiHandle.raw.handleViewportInput(sgr(0, 0, 1));
  tuiHandle.raw.handleViewportInput(sgr(32, 6, 1));
  tuiHandle.raw.handleViewportInput(sgr(0, 6, 1, true));
  assert.equal(mouse.hasSelection(), true);

  mouse.deleteSelection();

  assert.deepEqual(state.lines, ["world"]);
  assert.equal(state.cursorLine, 0);
  assert.equal(state.cursorCol, 0);
  assert.equal(mouse.hasSelection(), false);
  assert.equal(snapshots.length, 1, "exactly one undo snapshot for the whole delete");
  assert.deepEqual(onChangeCalls, ["world"]);
});

test("clearSelection drops a non-empty selection without touching the text", () => {
  const { editor, state } = fakeEditor(["hello world"]);
  const tuiHandle = fakeTui();
  mountEditorBox(tuiHandle, editor, { x: 0, y: 0, width: 20, height: 5 });
  const mouse = installMouseSupport(tuiHandle.tui, editor);
  assert.ok(mouse);

  tuiHandle.raw.handleViewportInput(sgr(0, 0, 1));
  tuiHandle.raw.handleViewportInput(sgr(32, 5, 1));
  tuiHandle.raw.handleViewportInput(sgr(0, 5, 1, true));
  assert.equal(mouse.hasSelection(), true);

  mouse.clearSelection();

  assert.equal(mouse.hasSelection(), false);
  assert.deepEqual(state.lines, ["hello world"]);
});

test("applyHighlight leaves rendered lines unchanged without a selection", () => {
  const { editor } = fakeEditor(["hello world"]);
  const tuiHandle = fakeTui();
  mountEditorBox(tuiHandle, editor, { x: 0, y: 0, width: 20, height: 5 });
  const mouse = installMouseSupport(tuiHandle.tui, editor);
  assert.ok(mouse);

  const lines = ["border", "  hello world", "border"];
  assert.equal(mouse.applyHighlight(lines, 20), lines);
});

test("applyHighlight wraps the selected span and preserves each row's visible width", () => {
  const { editor } = fakeEditor(["hello world"]);
  const tuiHandle = fakeTui();
  mountEditorBox(tuiHandle, editor, { x: 0, y: 0, width: 20, height: 5 });
  const mouse = installMouseSupport(tuiHandle.tui, editor);
  assert.ok(mouse);

  tuiHandle.raw.handleViewportInput(sgr(0, 0, 1));
  tuiHandle.raw.handleViewportInput(sgr(32, 5, 1));
  tuiHandle.raw.handleViewportInput(sgr(0, 5, 1, true));

  const rendered = ["border row", "hello world         ", "border row"];
  const highlighted = mouse.applyHighlight(rendered, 20);

  assert.notDeepEqual(highlighted, rendered);
  assert.equal(visibleWidth(highlighted[1]!), visibleWidth(rendered[1]!));
  assert.ok(highlighted[1]!.includes("\x1b[7m"));
  assert.equal(highlighted[0], rendered[0]);
  assert.equal(highlighted[2], rendered[2]);
});
