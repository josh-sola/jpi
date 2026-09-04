import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createTitleExtension } from "../../modules/title/extension.ts";
import { ACTIVE_FRAMES, SPINNER_INTERVAL_MS } from "../../modules/title/helpers.ts";
import { FakeEventBus, ManualScheduler, ok } from "./jpi-title-test-helpers.ts";

function harness(titleMode: "static" | "dynamic" = "dynamic") {
  const scheduler = new ManualScheduler();
  const events = new FakeEventBus();
  const titles: string[] = [];
  const context = {
    mode: "tui",
    cwd: "/repo/project",
    ui: { setTitle: (title: string) => titles.push(title) },
  };
  const extension = createTitleExtension({
    exec: async () => ({ ...ok(), code: 1 }),
    events,
    getSessionName: () => undefined,
    getTitleMode: () => titleMode,
    scheduler,
    requestId: () => "id",
  });
  return { scheduler, events, titles, context, extension };
}

test("activity starts at the first frame and advances in the exact interval order", async () => {
  const { scheduler, titles, context, extension } = harness();
  await extension.onSessionStart({}, context);
  scheduler.fire(scheduler.active("timeout", 0)[0]!);
  titles.length = 0;

  extension.onAgentStart({}, context);
  const spinner = scheduler.active("interval", SPINNER_INTERVAL_MS)[0];
  assert.ok(spinner);
  assert.equal(titles[0], `${ACTIVE_FRAMES[0]} project`);
  for (let index = 1; index < ACTIVE_FRAMES.length; index += 1) scheduler.fire(spinner);
  assert.deepEqual(
    titles,
    ACTIVE_FRAMES.map((frame) => `${frame} project`),
  );

  scheduler.fire(spinner);
  assert.equal(titles.at(-1), `${ACTIVE_FRAMES[0]} project`);
  extension.onAgentSettled({}, context);
  assert.equal(titles.at(-1), "⏹ project");
  assert.equal(spinner.cleared, true);
});

test("static activity renders the fixed first frame without allocating a spinner and returns through waiting to idle", async () => {
  const { scheduler, events, titles, context, extension } = harness("static");
  await extension.onSessionStart({}, context);
  scheduler.fire(scheduler.active("timeout", 0)[0]!);
  titles.length = 0;

  extension.onAgentStart({}, context);
  assert.deepEqual(titles, [`${ACTIVE_FRAMES[0]} project`]);
  assert.equal(scheduler.active("interval", SPINNER_INTERVAL_MS).length, 0);

  events.emit("subagents:started", { id: "one" });
  extension.onAgentSettled({}, context);
  assert.equal(titles.at(-1), "⧗ project");
  assert.equal(scheduler.active("interval", SPINNER_INTERVAL_MS).length, 0);

  events.emit("subagents:completed", { id: "one" });
  assert.equal(titles.at(-1), "⏹ project");
});

test("subagents and background feed waiting while main is idle; the spinner only runs while working", async () => {
  const { scheduler, events, titles, context, extension } = harness();
  await extension.onSessionStart({}, context);
  scheduler.fire(scheduler.active("timeout", 0)[0]!);
  titles.length = 0;

  events.emit("subagents:started", { id: "one" });
  events.emit("subagents:started", { id: "two" });
  assert.equal(titles.at(-1), "⧗ project");
  assert.equal(scheduler.active("interval", SPINNER_INTERVAL_MS).length, 0);

  extension.onAgentStart({}, context);
  const spinner = scheduler.active("interval", SPINNER_INTERVAL_MS)[0];
  assert.ok(spinner);
  assert.equal(titles.at(-1), `${ACTIVE_FRAMES[0]} project`);

  extension.onAgentSettled({}, context);
  assert.equal(spinner!.cleared, true);
  // subagents are still running, so this drops to waiting rather than idle
  assert.equal(titles.at(-1), "⧗ project");

  events.emit("subagents:completed", { id: "one" });
  assert.equal(titles.at(-1), "⧗ project");
  events.emit("subagents:failed", { id: "two" });
  assert.equal(titles.at(-1), "⏹ project");
});

test("state priority: a UI prompt beats working, which beats waiting", async () => {
  const { scheduler, events, titles, context, extension } = harness();
  await extension.onSessionStart({}, context);
  scheduler.fire(scheduler.active("timeout", 0)[0]!);
  titles.length = 0;

  extension.onAgentStart({}, context);
  const spinner = scheduler.active("interval", SPINNER_INTERVAL_MS)[0]!;
  assert.equal(titles.at(-1), `${ACTIVE_FRAMES[0]} project`);

  // a UI prompt opening beats working: the spinner stops even though main is still active
  extension.onUiPromptStart({}, context);
  assert.equal(spinner.cleared, true);
  assert.equal(titles.at(-1), "‼ project");

  // prompts can nest: a second start/end pair leaves input active
  extension.onUiPromptStart({}, context);
  extension.onUiPromptEnd({}, context);
  assert.equal(titles.at(-1), "‼ project");

  // closing the last prompt returns to working and restarts the spinner
  extension.onUiPromptEnd({}, context);
  const resumed = scheduler.active("interval", SPINNER_INTERVAL_MS).find((timer) => !timer.cleared);
  assert.ok(resumed);
  assert.equal(titles.at(-1), `${ACTIVE_FRAMES[0]} project`);

  // an extra end clamps at zero rather than going negative
  extension.onUiPromptEnd({}, context);
  assert.equal(titles.at(-1), `${ACTIVE_FRAMES[0]} project`);

  extension.onAgentSettled({}, context);
  assert.equal(titles.at(-1), "⏹ project");

  // input beats waiting too
  events.emit("subagents:started", { id: "one" });
  assert.equal(titles.at(-1), "⧗ project");
  extension.onUiPromptStart({}, context);
  assert.equal(titles.at(-1), "‼ project");
});
