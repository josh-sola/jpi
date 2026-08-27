import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { TaskStore } from "../../modules/tasks/task-store.ts";
import { TaskWidget, type Theme, type UICtx } from "../../modules/tasks/ui/task-widget.ts";

/** Create a mock theme that returns raw text (no ANSI escapes). */
function mockTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    strikethrough: (text: string) => `~~${text}~~`,
  };
}

/** Create a mock UICtx that captures setWidget calls. */
function mockUICtx() {
  const state: {
    widgets: Map<string, any>;
    statuses: Map<string, string | undefined>;
  } = {
    widgets: new Map(),
    statuses: new Map(),
  };

  const ctx: UICtx = {
    setWidget(key, content, options) {
      state.widgets.set(key, { content, options });
    },
    setStatus(key, text) {
      state.statuses.set(key, text);
    },
  };

  return { ctx, state };
}

/** Render the widget and return its lines. */
function renderWidget(state: ReturnType<typeof mockUICtx>["state"], columns = 200): string[] {
  const entry = state.widgets.get("tasks");
  if (!entry?.content) return [];
  const theme = mockTheme();
  const tui = { terminal: { columns }, requestRender() {} };
  const result = entry.content(tui, theme);
  return result.render();
}

describe("TaskWidget", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("shows nothing when no tasks exist", async () => {
    widget.update();
    const entry = ui.state.widgets.get("tasks");
    expect(entry?.content).toBeUndefined();
  });

  it("renders pending tasks with ◻ icon", async () => {
    await store.create("Do something", "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines).toHaveLength(2); // header + 1 task
    expect(lines[0]).toContain("1 tasks");
    expect(lines[0]).toContain("1 open");
    expect(lines[1]).toContain("◻");
    expect(lines[1]).toContain("Do something");
  });

  it("renders in-progress tasks with ◼ icon", async () => {
    await store.create("Working on it", "Desc");
    await store.update("1", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("◼");
    expect(lines[1]).toContain("Working on it");
  });

  it("renders completed tasks with ✔ icon and strikethrough", async () => {
    await store.create("Done task", "Desc");
    await store.create("Open task", "Desc");
    await store.update("1", { status: "completed" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("✔");
    expect(lines[1]).toContain("~~#1 Done task~~");
  });

  it("renders active tasks with spinner icon", async () => {
    await store.create("Running thing", "Desc", "Processing data");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    // Should show activeForm text with "…" suffix
    expect(lines[1]).toContain("Processing data…");
    // Should NOT show ◼ for active task
    expect(lines[1]).not.toContain("◼");
  });

  it("always sorts tasks by ID", async () => {
    await store.create("Pending task", "Desc"); // #1
    await store.create("Completed task", "Desc"); // #2
    await store.create("In progress task", "Desc"); // #3
    await store.update("2", { status: "completed" });
    await store.update("3", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Pending task");
    expect(lines[2]).toContain("Completed task");
    expect(lines[3]).toContain("In progress task");
  });

  it("shows status summary in header", async () => {
    await store.create("Task A", "Desc");
    await store.create("Task B", "Desc");
    await store.create("Task C", "Desc");
    await store.update("1", { status: "completed" });
    await store.update("2", { status: "in_progress" });
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[0]).toContain("3 tasks");
    expect(lines[0]).toContain("1 done");
    expect(lines[0]).toContain("1 in progress");
    expect(lines[0]).toContain("1 open");
  });

  it("clears widget when all tasks are deleted", async () => {
    await store.create("Task", "Desc");
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeDefined();

    await store.update("1", { status: "deleted" });
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
  });

  it("clears widget when every task is completed", async () => {
    await store.create("Task A", "Desc");
    await store.create("Task B", "Desc");
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeDefined();

    await store.update("1", { status: "completed" });
    await store.update("2", { status: "completed" });
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
  });

  it("re-registers the widget when a new task is added after all tasks completed", async () => {
    await store.create("Task A", "Desc");
    await store.update("1", { status: "completed" });
    widget.update();
    expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();

    await store.create("Task B", "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    expect(ui.state.widgets.get("tasks")?.content).toBeDefined();
    expect(lines.some((l) => l.includes("Task B"))).toBe(true);
  });

  it("limits visible tasks to a fixed cap of 10", async () => {
    for (let i = 0; i < 15; i++) {
      await store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 10 tasks + "… and 5 more"
    expect(lines).toHaveLength(12);
    expect(lines[11]).toContain("5 more");
  });

  it("shows all tasks when the count is under the cap", async () => {
    for (let i = 0; i < 3; i++) {
      await store.create(`Task ${i + 1}`, "Desc");
    }
    widget.update();

    const lines = renderWidget(ui.state);
    // header + 3 tasks, no overflow
    expect(lines).toHaveLength(4);
    expect(lines[lines.length - 1]).not.toContain("more");
  });

  it("clips over-wide lines with the truncation ellipsis", async () => {
    await store.create("A subject far too long for this terminal", "Desc");
    widget.update();

    const line = renderWidget(ui.state, 20)[1].replace(/\u001b\[[0-9;]*m/g, "");
    expect(line.endsWith("...")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(20);
    expect(line).not.toContain("terminal");
  });

  it("tracks token usage for active tasks", async () => {
    await store.create("Active task", "Desc", "Running");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(1000, 500);
    widget.addTokenUsage(500, 300);

    const lines = renderWidget(ui.state);
    const activeLine = lines.find((l) => l.includes("Running…"));
    expect(activeLine).toContain("↑ 1.5k");
    expect(activeLine).toContain("↓ 800");
  });

  it("deactivates a task with setActiveTask(id, false)", async () => {
    await store.create("Task", "Desc", "Doing work");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // Should be active (spinner)
    let lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Doing work…");

    widget.setActiveTask("1", false);
    lines = renderWidget(ui.state);
    // Should now show as regular in_progress (◼)
    expect(lines[1]).toContain("◼");
    expect(lines[1]).not.toContain("Doing work…");
  });

  it("prunes stale active IDs on update", async () => {
    await store.create("Task", "Desc");
    await store.create("Other task", "Desc");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // Complete the task externally
    await store.update("1", { status: "completed" });
    widget.update();

    // Should render as completed, not active
    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("✔");
    expect(lines[1]).toContain("~~#1 Task~~");
  });

  it("supports multiple active tasks simultaneously", async () => {
    await store.create("Task A", "Desc", "Processing A");
    await store.create("Task B", "Desc", "Processing B");
    await store.update("1", { status: "in_progress" });
    await store.update("2", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.setActiveTask("2", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("Processing A…");
    expect(lines[2]).toContain("Processing B…");
  });

  it("distributes token usage across all active tasks", async () => {
    await store.create("Task A", "Desc", "A");
    await store.create("Task B", "Desc", "B");
    await store.update("1", { status: "in_progress" });
    await store.update("2", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.setActiveTask("2", true);

    widget.addTokenUsage(100, 50);

    const lines = renderWidget(ui.state);
    // Both tasks should have the same token counts
    expect(lines[1]).toContain("↑ 100");
    expect(lines[2]).toContain("↑ 100");
  });

  it("dispose clears widget and timer", async () => {
    await store.create("Task", "Desc");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.dispose();
    expect(ui.state.widgets.get("tasks")?.content).toBeUndefined();
  });

  it("uses subject as fallback when no activeForm", async () => {
    await store.create("My Subject", "Desc");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("My Subject…");
  });

  it("shows elapsed time but no token arrows when tokens are zero", async () => {
    await store.create("No tokens", "Desc", "Working");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    // No addTokenUsage calls — tokens stay at 0
    vi.advanceTimersByTime(5000);
    widget.update();

    const lines = renderWidget(ui.state);
    const activeLine = lines.find((l) => l.includes("Working…"));
    expect(activeLine).toContain("5s");
    expect(activeLine).not.toContain("↑");
    expect(activeLine).not.toContain("↓");
  });

  it("cleans up metrics when stale active IDs are pruned", async () => {
    await store.create("Task", "Desc", "Running");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);
    widget.addTokenUsage(100, 50);

    // Delete task externally
    await store.update("1", { status: "deleted" });
    widget.update();

    // Reactivate with same ID (new task) — should get fresh metrics
    await store.create("Task 2", "Desc", "Running"); // ID 2
    await store.update("2", { status: "in_progress" });
    widget.setActiveTask("2", true);

    const lines = renderWidget(ui.state);
    // Should not carry over old tokens
    expect(lines[1]).not.toContain("↑ 100");
  });

  it("indents task lines under header", async () => {
    await store.create("Indented task", "Desc");
    widget.update();

    const lines = renderWidget(ui.state);
    // Task line should start with 2 spaces
    expect(lines[1]).toMatch(/^\s{2}/);
  });

  it("widget is placed aboveEditor", async () => {
    await store.create("Task", "Desc");
    widget.update();

    const entry = ui.state.widgets.get("tasks");
    expect(entry?.options?.placement).toBe("aboveEditor");
  });
});

describe("formatDuration (via widget rendering)", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  it("shows seconds for short durations", async () => {
    await store.create("Quick", "Desc", "Working");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(30_000); // 30s
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("30s");
  });

  it("shows hours for long durations", async () => {
    await store.create("Long", "Desc", "Working");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(3_723_000); // 1h 2m 3s → "1h 2m"
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("1h 2m");
  });

  it("shows exact hours without minutes", async () => {
    await store.create("Exact", "Desc", "Working");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(7_200_000); // 2h exactly
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("2h)");
  });

  it("shows minutes and seconds", async () => {
    await store.create("Medium", "Desc", "Working");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    vi.advanceTimersByTime(169_000); // 2m 49s
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("2m 49s");
  });

  it("formats small token counts without k suffix", async () => {
    await store.create("Small", "Desc", "Working");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(500, 200);
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("↑ 500");
    expect(lines[1]).toContain("↓ 200");
  });

  it("formats token counts with k suffix and removes .0", async () => {
    await store.create("Large", "Desc", "Working");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1", true);

    widget.addTokenUsage(2000, 4100);
    widget.update();

    const lines = renderWidget(ui.state);
    expect(lines[1]).toContain("↑ 2k"); // 2000 → "2k" (not "2.0k")
    expect(lines[1]).toContain("↓ 4.1k"); // 4100 → "4.1k"
  });
});

describe("spinner animation timing", () => {
  let store: TaskStore;
  let widget: TaskWidget;
  let ui: ReturnType<typeof mockUICtx>;

  beforeEach(async () => {
    vi.useFakeTimers();
    store = new TaskStore();
    widget = new TaskWidget(store);
    ui = mockUICtx();
    widget.setUICtx(ui.ctx);
    await store.create("Long job", "d", "Working");
    await store.update("1", { status: "in_progress" });
    widget.setActiveTask("1");
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  /** The spinner glyph is the first non-space character of the task line. */
  const glyph = () => renderWidget(ui.state)[1].trim().split(" ")[0];

  it("advances one frame per timer tick", async () => {
    const frames = [glyph()];
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(150);
      frames.push(glyph());
    }
    // Four consecutive, distinct frames.
    expect(new Set(frames).size).toBe(4);
  });

  it("does not advance when task activity redraws the widget", async () => {
    // update() runs on every task mutation and on tool execution. Advancing the
    // frame there tied animation speed to how busy the agent was, so the spinner
    // raced ahead during bursts and stalled when nothing happened.
    const before = glyph();
    for (let i = 0; i < 5; i++) widget.update();

    expect(glyph()).toBe(before);
  });

  it("still animates after an unrelated redraw", async () => {
    widget.update();
    const before = glyph();
    vi.advanceTimersByTime(150);

    expect(glyph()).not.toBe(before);
  });
});
