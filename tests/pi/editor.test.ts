/**
 * editor.test.ts — canary for src/pi/editor.ts's private-surface reach-ins,
 * against real pi-tui classes.
 *
 * `detectEditorAccess` proves pi-tui's real `Editor` still has the four
 * private members (`state`, `scrollOffset`, `buildVisualLineMap`,
 * `pushUndoSnapshot`) mouse support depends on. `patchViewportInput` proves
 * the real TUI half (`handleViewportInput`, `currentLayout`) — pi-tui's `TUI`
 * is an interface (`TuiMainScreen`/`TuiAltScreen` implement it), and its
 * constructor only stores the `Terminal` it's given, so a real
 * `TuiAltScreen` — the implementation jpi's fullscreen mode actually uses —
 * is cheap to construct against a minimal `Terminal`-shaped stub, no real TTY
 * needed. `computePaddingX`/`computeLayoutWidth`/`computeMaxVisibleLines`
 * are exercised indirectly, against a real `Editor` and a real layout pass,
 * by tests/history/mouse.test.ts's two REGRESSION tests.
 */
import { describe, expect, it } from "vite-plus/test";
import type { EditorTheme, Terminal } from "@earendil-works/pi-tui";
import { Editor, TuiAltScreen } from "@earendil-works/pi-tui";
import { detectEditorAccess, patchViewportInput } from "../../src/pi/editor.ts";

function fakeTerminal(): Terminal {
  return {
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  };
}

/** A real TuiAltScreen — the TUI implementation jpi's fullscreen mode actually uses. */
function realTui(): TuiAltScreen {
  return new TuiAltScreen(fakeTerminal(), false, "/tmp/pi-canary-editor-test");
}

describe("editor: Editor private surface (real pi-tui)", () => {
  it("detectEditorAccess finds the four private members on a real Editor", () => {
    const theme: EditorTheme = { borderColor: (text: string) => text, selectList: {} as never };
    const editor = new Editor(realTui(), theme, {});
    const access = detectEditorAccess(editor);
    expect(access).toBeDefined();

    // Exercise each accessor for real, against the real instance.
    editor.setText("hello\nworld");
    expect(access!.getState().lines).toEqual(["hello", "world"]);
    expect(typeof access!.getScrollOffset()).toBe("number");
    expect(Array.isArray(access!.buildVisualLineMap(80))).toBe(true);
    expect(() => access!.pushUndoSnapshot()).not.toThrow();
  });
});

describe("editor: TUI private surface (real pi-tui TuiAltScreen)", () => {
  it("patchViewportInput installs against a real TuiAltScreen's handleViewportInput/currentLayout", () => {
    const tui = realTui();
    const calls: string[] = [];
    const patched = patchViewportInput(tui, (original) => (data: string) => {
      calls.push(data);
      return original(data);
    });
    expect(patched).toBeDefined();

    // currentLayout starts undefined on a fresh instance — proves the field
    // exists (an own class field), not that it holds anything real yet.
    expect(patched!.getCurrentLayout()).toBeUndefined();

    // The wrap actually runs on real input dispatch, chaining to the original.
    (tui as unknown as { handleViewportInput(data: string): unknown }).handleViewportInput("x");
    expect(calls).toEqual(["x"]);
  });

  it("patchViewportInput returns undefined for a tui missing the private surface", () => {
    const bareTui = { requestRender: () => {} } as never;
    expect(patchViewportInput(bareTui, (original) => original)).toBeUndefined();
  });
});
