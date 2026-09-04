import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createTitleExtension } from "../../modules/title/extension.ts";
import {
  loadWorktreeName,
  sanitizeTitlePart,
  sessionIndicator,
} from "../../modules/title/helpers.ts";
import { FakeEventBus, ManualScheduler, ok } from "./jpi-title-test-helpers.ts";

function context(mode = "tui", cwd = "/trees/local-tree") {
  const titles: string[] = [];
  return {
    titles,
    value: { mode, cwd, ui: { setTitle: (title: string) => titles.push(title) } },
  };
}

test("session indicator precedence and worktree fallback are exact and safe", async () => {
  assert.equal(sessionIndicator("Named session", "Tree name", "/repo/base"), "Named session");
  assert.equal(sessionIndicator("", "Tree name", "/repo/base"), "Tree name");
  assert.equal(sessionIndicator(undefined, "", "/repo/base"), "base");
  assert.equal(sanitizeTitlePart("safe\n\u001b]2;bad\u0007 名"), "safe  ]2;bad  名");

  const calls: unknown[] = [];
  const loaded = await loadWorktreeName(async (command, args, options) => {
    calls.push({ command, args, options });
    return ok(" Worktree 名\n");
  }, "/repo");
  assert.equal(loaded, "Worktree 名");
  assert.deepEqual(calls, [
    {
      command: "wt",
      args: ["tree", "name", "--path", "/repo"],
      options: { cwd: "/repo", timeout: 3_000 },
    },
  ]);

  for (const result of [{ ...ok("name"), code: 1 }, { ...ok("name"), killed: true }, ok(" \n")]) {
    assert.equal(await loadWorktreeName(async () => result, "/repo"), undefined);
  }
  assert.equal(
    await loadWorktreeName(async () => {
      throw new Error("missing");
    }, "/repo"),
    undefined,
  );
});

test("startup defers the idle title until after worktree lookup and rename is synchronous", async () => {
  const scheduler = new ManualScheduler();
  const events = new FakeEventBus();
  const ctx = context();
  let sessionName = "";
  const extension = createTitleExtension({
    exec: async () => ok("Friendly tree\n"),
    events,
    getSessionName: () => sessionName,
    getTitleMode: () => "dynamic",
    scheduler,
    requestId: () => "request",
  });

  await extension.onSessionStart({}, ctx.value);
  assert.deepEqual(ctx.titles, []);
  const startup = scheduler.active("timeout", 0);
  assert.equal(startup.length, 1);
  scheduler.fire(startup[0]!);
  assert.equal(ctx.titles.at(-1), "⏹ Friendly tree");

  sessionName = "Renamed\nSession";
  extension.onSessionInfoChanged({}, ctx.value);
  assert.equal(ctx.titles.at(-1), "⏹ Renamed Session");
});

test("startup re-asserts the title at 600ms and 1200ms to survive tmux's rename throttle", async () => {
  const scheduler = new ManualScheduler();
  const events = new FakeEventBus();
  const ctx = context();
  const extension = createTitleExtension({
    exec: async () => ok("tree"),
    events,
    getSessionName: () => undefined,
    getTitleMode: () => "dynamic",
    scheduler,
    requestId: () => "request",
  });

  await extension.onSessionStart({}, ctx.value);
  scheduler.fire(scheduler.active("timeout", 0)[0]!);
  assert.equal(ctx.titles.at(-1), "⏹ tree");

  const reassert600 = scheduler.active("timeout", 600);
  const reassert1200 = scheduler.active("timeout", 1200);
  assert.equal(reassert600.length, 1);
  assert.equal(reassert1200.length, 1);

  const before = ctx.titles.length;
  scheduler.fire(reassert600[0]!);
  assert.equal(ctx.titles.length, before + 1);
  assert.equal(ctx.titles.at(-1), "⏹ tree");

  scheduler.fire(reassert1200[0]!);
  assert.equal(ctx.titles.length, before + 2);
  assert.equal(ctx.titles.at(-1), "⏹ tree");
});

test("shutdown before the reasserts fire clears them", async () => {
  const scheduler = new ManualScheduler();
  const events = new FakeEventBus();
  const ctx = context();
  const extension = createTitleExtension({
    exec: async () => ok("tree"),
    events,
    getSessionName: () => undefined,
    getTitleMode: () => "dynamic",
    scheduler,
    requestId: () => "request",
  });

  await extension.onSessionStart({}, ctx.value);
  scheduler.fire(scheduler.active("timeout", 0)[0]!);
  const reassert600 = scheduler.active("timeout", 600)[0]!;
  const reassert1200 = scheduler.active("timeout", 1200)[0]!;

  extension.onSessionShutdown({}, ctx.value);
  assert.equal(reassert600.cleared, true);
  assert.equal(reassert1200.cleared, true);

  const titleCount = ctx.titles.length;
  scheduler.fire(reassert600);
  scheduler.fire(reassert1200);
  assert.equal(ctx.titles.length, titleCount);
});

test("non-TUI sessions install no title behavior", async () => {
  const scheduler = new ManualScheduler();
  const events = new FakeEventBus();
  const ctx = context("json");
  let execCalls = 0;
  const extension = createTitleExtension({
    exec: async () => {
      execCalls += 1;
      return ok();
    },
    events,
    getSessionName: () => undefined,
    getTitleMode: () => "dynamic",
    scheduler,
  });

  await extension.onSessionStart({}, ctx.value);
  extension.onAgentStart({}, ctx.value);
  extension.onAgentSettled({}, ctx.value);
  extension.onSessionInfoChanged({}, ctx.value);
  extension.onSessionShutdown({}, ctx.value);
  assert.equal(execCalls, 0);
  assert.equal(events.handlers.size, 0);
  assert.equal(scheduler.timers.length, 0);
  assert.deepEqual(ctx.titles, []);
});
