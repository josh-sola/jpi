import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AgentRecord } from "../../modules/subagents/types.ts";
import { ConversationViewer } from "../../modules/subagents/ui/conversation-viewer.ts";
import type { ViewerKeybindings } from "../../modules/subagents/ui/viewer-keys.ts";
import { createViewerKeys } from "../../modules/subagents/ui/viewer-keys.ts";

// The enriched transcript reuses pi's own chat components, which read colors
// off pi's global theme singleton — real only once initTheme() has run.
initTheme();

const CTRL_P = "\x10";
const CTRL_N = "\x0e";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

function sgr(button: number, col: number, row: number): string {
  return `\x1b[<${button};${col + 1};${row + 1}M`;
}

const WHEEL_UP = sgr(64, 0, 0);
const WHEEL_DOWN = sgr(65, 0, 0);
const WHEEL_HORIZONTAL = sgr(66, 0, 0);
const LEFT_CLICK = sgr(0, 0, 0);

function createEmacsKeybindings(): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": ["up", "ctrl+p"],
    "tui.select.down": ["down", "ctrl+n"],
  });
}

function createViewer(keybindings?: ViewerKeybindings) {
  const tui = {
    terminal: { rows: 20, columns: 80 },
    requestRender: vi.fn(),
  } as any;
  const messages = Array.from({ length: 60 }, (_, i) => ({
    role: "user",
    content: `message ${i}`,
  }));
  const session = {
    messages,
    subscribe: vi.fn(() => vi.fn()),
    sessionManager: { getCwd: () => "/tmp/test-cwd" },
    extensionRunner: { getMarkdownTransformers: () => [], getMessageRenderer: () => undefined },
    getToolDefinition: () => undefined,
  } as any;
  const record = {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "completed",
    toolUses: 0,
    startedAt: Date.now(),
  } as AgentRecord;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
  const viewer = new ConversationViewer(
    tui,
    session,
    record,
    undefined,
    theme,
    vi.fn(),
    undefined,
    keybindings,
  );
  viewer.render(80); // sets lastInnerW and scrolls to bottom (autoScroll)
  return viewer;
}

function scrollOffset(viewer: ConversationViewer): number {
  return (viewer as any).scrollOffset;
}

function autoScroll(viewer: ConversationViewer): boolean {
  return (viewer as any).autoScroll;
}

describe("viewer-keys", () => {
  it("honors user keybindings when a manager is provided", () => {
    const keys = createViewerKeys(createEmacsKeybindings());
    expect(keys.scrollUp(CTRL_P)).toBe(true);
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollDown(CTRL_N)).toBe(true);
    expect(keys.scrollDown(DOWN)).toBe(true);
  });

  it("falls back to hardcoded defaults without a manager", () => {
    const keys = createViewerKeys();
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollUp(CTRL_P)).toBe(false);
    expect(keys.scrollDown(DOWN)).toBe(true);
    expect(keys.scrollDown(CTRL_N)).toBe(false);
    expect(keys.pageUp(PAGE_UP)).toBe(true);
    expect(keys.pageDown(PAGE_DOWN)).toBe(true);
  });

  it("keeps the k/j and shift+arrow aliases with and without a manager", () => {
    for (const keys of [createViewerKeys(), createViewerKeys(createEmacsKeybindings())]) {
      expect(keys.scrollUp("k")).toBe(true);
      expect(keys.scrollDown("j")).toBe(true);
      expect(keys.pageUp(SHIFT_UP)).toBe(true);
      expect(keys.pageDown(SHIFT_DOWN)).toBe(true);
    }
  });

  it("manager with no user overrides behaves like the hardcoded defaults", () => {
    const keys = createViewerKeys(new KeybindingsManager(TUI_KEYBINDINGS, {}));
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollDown(DOWN)).toBe(true);
    expect(keys.pageUp(PAGE_UP)).toBe(true);
    expect(keys.pageDown(PAGE_DOWN)).toBe(true);
    expect(keys.scrollUp(CTRL_P)).toBe(false);
    expect(keys.scrollDown(CTRL_N)).toBe(false);
  });

  it("respects rebinding that removes a default key", () => {
    const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.up": "ctrl+p",
    });
    const keys = createViewerKeys(manager);
    expect(keys.scrollUp(CTRL_P)).toBe(true);
    expect(keys.scrollUp(UP)).toBe(false);
  });
});

describe("ConversationViewer custom keybindings", () => {
  it("scrolls with ctrl+p/ctrl+n when bound to tui.select.up/down", () => {
    const viewer = createViewer(createEmacsKeybindings());
    const bottom = scrollOffset(viewer);
    expect(bottom).toBeGreaterThan(0);

    viewer.handleInput(CTRL_P);
    expect(scrollOffset(viewer)).toBe(bottom - 1);
    viewer.handleInput(CTRL_N);
    expect(scrollOffset(viewer)).toBe(bottom);
  });

  it("keeps arrows and k/j working alongside custom bindings", () => {
    const viewer = createViewer(createEmacsKeybindings());
    const bottom = scrollOffset(viewer);

    viewer.handleInput(UP);
    viewer.handleInput("k");
    expect(scrollOffset(viewer)).toBe(bottom - 2);
    viewer.handleInput(DOWN);
    viewer.handleInput("j");
    expect(scrollOffset(viewer)).toBe(bottom);
  });

  it("treats ctrl+p/ctrl+n as unbound without a keybindings manager", () => {
    const viewer = createViewer();
    const bottom = scrollOffset(viewer);

    viewer.handleInput(CTRL_P);
    viewer.handleInput(CTRL_N);
    expect(scrollOffset(viewer)).toBe(bottom);
    viewer.handleInput(UP);
    expect(scrollOffset(viewer)).toBe(bottom - 1);
  });
});

describe("ConversationViewer mouse wheel", () => {
  it("scrolls up 3 lines and disengages autoScroll", () => {
    const viewer = createViewer();
    const bottom = scrollOffset(viewer);
    expect(autoScroll(viewer)).toBe(true);

    viewer.handleInput(WHEEL_UP);

    expect(scrollOffset(viewer)).toBe(bottom - 3);
    expect(autoScroll(viewer)).toBe(false);
  });

  it("scrolls down 3 lines and re-engages autoScroll once back at the bottom", () => {
    const viewer = createViewer();
    const bottom = scrollOffset(viewer);
    viewer.handleInput(WHEEL_UP);
    expect(autoScroll(viewer)).toBe(false);

    viewer.handleInput(WHEEL_DOWN);

    expect(scrollOffset(viewer)).toBe(bottom);
    expect(autoScroll(viewer)).toBe(true);
  });

  it("clamps wheel-up at the top", () => {
    const viewer = createViewer();

    for (let i = 0; i < 100; i++) viewer.handleInput(WHEEL_UP);

    expect(scrollOffset(viewer)).toBe(0);
  });

  it("clamps wheel-down at the bottom", () => {
    const viewer = createViewer();
    const bottom = scrollOffset(viewer);

    for (let i = 0; i < 100; i++) viewer.handleInput(WHEEL_DOWN);

    expect(scrollOffset(viewer)).toBe(bottom);
    expect(autoScroll(viewer)).toBe(true);
  });

  it("consumes a non-wheel SGR sequence without changing scrollOffset", () => {
    const viewer = createViewer();
    const bottom = scrollOffset(viewer);

    viewer.handleInput(LEFT_CLICK);

    expect(scrollOffset(viewer)).toBe(bottom);
    expect(autoScroll(viewer)).toBe(true);
  });

  it("ignores a horizontal wheel tick", () => {
    const viewer = createViewer();
    const bottom = scrollOffset(viewer);

    viewer.handleInput(WHEEL_HORIZONTAL);

    expect(scrollOffset(viewer)).toBe(bottom);
    expect(autoScroll(viewer)).toBe(true);
  });
});
