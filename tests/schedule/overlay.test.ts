import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type KeyId, matchesKey, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";

import type { Store } from "../../src/core/index.ts";
import { ScheduleOverlay } from "../../modules/schedule/overlay.ts";
import {
  ScheduleRegistry,
  type CronFactory,
  type CronLike,
} from "../../modules/schedule/registry.ts";

function fakeTheme() {
  return { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
}

// A structural stand-in for pi-tui's real KeybindingsManager: jpi depends on
// its own copy of pi-tui, a different class instance than the one nested
// inside pi-coding-agent, so constructing the real thing here would fail
// ScheduleOverlay's type check on a private-field mismatch.
const DEFAULT_BINDINGS: Record<string, KeyId | KeyId[]> = {
  "tui.select.cancel": ["escape", "ctrl+c"],
  "tui.select.up": "up",
  "tui.select.down": "down",
};

const keybindings = {
  matches: (data: string, id: string) => {
    const keys = DEFAULT_BINDINGS[id];
    if (!keys) return false;
    return Array.isArray(keys) ? keys.some((key) => matchesKey(data, key)) : matchesKey(data, keys);
  },
} as unknown as KeybindingsManager;

function fakeTui(rows = 40): TUI {
  return { requestRender: () => {}, terminal: { rows, columns: 80 } } as unknown as TUI;
}

function plainLines(overlay: ScheduleOverlay, width = 80): string[] {
  return overlay.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

/** Never actually schedules anything — captures the callback so a test could fire it, but none here need to. */
const fakeCreateCron: CronFactory = () => {
  const cronLike: CronLike = { nextRun: () => null, stop: () => {} };
  return cronLike;
};

function makeRegistry(makeId?: () => string) {
  return new ScheduleRegistry({
    store: {} as unknown as Store, // never persisted here — setSession() is never called
    sendNotification: () => undefined,
    createCron: fakeCreateCron,
    ...(makeId ? { makeId } : {}),
  });
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";

test("an empty registry shows the empty-state message", () => {
  const registry = makeRegistry();
  const overlay = new ScheduleOverlay(fakeTui(), fakeTheme(), keybindings, registry, () => {});

  assert.ok(plainLines(overlay).some((line) => line.includes("No scheduled prompts.")));
  assert.ok(plainLines(overlay).some((line) => line.includes("0 scheduled prompts")));
});

test("one row per schedule, with the selected row marked", () => {
  const registry = makeRegistry();
  registry.create("first prompt", "*/5 * * * *");
  registry.create("second prompt", "0 9 * * *");
  const overlay = new ScheduleOverlay(fakeTui(), fakeTheme(), keybindings, registry, () => {});

  const lines = plainLines(overlay);
  assert.ok(lines.some((line) => line.includes("first prompt") && line.includes("*/5 * * * *")));
  assert.ok(lines.some((line) => line.includes("second prompt") && line.includes("0 9 * * *")));
  assert.equal(lines.filter((line) => line.includes("●")).length, 1);
});

test("down/up move the selection marker between rows", () => {
  const registry = makeRegistry();
  registry.create("first prompt", "* * * * *");
  registry.create("second prompt", "* * * * *");
  const overlay = new ScheduleOverlay(fakeTui(), fakeTheme(), keybindings, registry, () => {});

  assert.ok(
    plainLines(overlay)
      .find((line) => line.includes("●"))
      ?.includes("first prompt"),
  );

  overlay.handleInput(DOWN);
  assert.ok(
    plainLines(overlay)
      .find((line) => line.includes("●"))
      ?.includes("second prompt"),
  );

  overlay.handleInput(UP);
  assert.ok(
    plainLines(overlay)
      .find((line) => line.includes("●"))
      ?.includes("first prompt"),
  );
});

test("j/k move the selection the same way as down/up", () => {
  const registry = makeRegistry();
  registry.create("first prompt", "* * * * *");
  registry.create("second prompt", "* * * * *");
  const overlay = new ScheduleOverlay(fakeTui(), fakeTheme(), keybindings, registry, () => {});

  overlay.handleInput("j");
  assert.ok(
    plainLines(overlay)
      .find((line) => line.includes("●"))
      ?.includes("second prompt"),
  );

  overlay.handleInput("k");
  assert.ok(
    plainLines(overlay)
      .find((line) => line.includes("●"))
      ?.includes("first prompt"),
  );
});

test("x stops the selected schedule immediately", () => {
  const registry = makeRegistry();
  const created = registry.create("first prompt", "* * * * *");
  const overlay = new ScheduleOverlay(fakeTui(), fakeTheme(), keybindings, registry, () => {});

  overlay.handleInput("x");

  assert.equal(registry.list().length, 0);
  assert.throws(() => registry.get(created.id), /No scheduled prompt matches/);
  assert.ok(plainLines(overlay).some((line) => line.includes("No scheduled prompts.")));
});

test("d also stops the selected schedule", () => {
  const registry = makeRegistry();
  registry.create("first prompt", "* * * * *");
  const overlay = new ScheduleOverlay(fakeTui(), fakeTheme(), keybindings, registry, () => {});

  overlay.handleInput("d");

  assert.equal(registry.list().length, 0);
});

test("esc closes the overlay", () => {
  let closed = false;
  const registry = makeRegistry();
  const overlay = new ScheduleOverlay(fakeTui(), fakeTheme(), keybindings, registry, () => {
    closed = true;
  });

  overlay.handleInput(ESC);

  assert.equal(closed, true);
});

test("a firing or a tool-driven stop refreshes the list live via onChange", () => {
  const registry = makeRegistry();
  registry.create("first prompt", "* * * * *");
  const overlay = new ScheduleOverlay(fakeTui(), fakeTheme(), keybindings, registry, () => {});

  assert.ok(plainLines(overlay).some((line) => line.includes("first prompt")));

  registry.create("second prompt", "* * * * *");

  assert.ok(plainLines(overlay).some((line) => line.includes("second prompt")));

  overlay.dispose();
});
