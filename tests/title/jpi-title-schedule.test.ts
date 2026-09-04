import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createTitleExtension } from "../../modules/title/extension.ts";
import { FakeEventBus, ManualScheduler, ok } from "./jpi-title-test-helpers.ts";

const SCHEDULES_CHANNEL = "jpi-schedule:schedules:v1";
const SCHEDULES_SCHEMA = "jpi-schedule.schedules.v1";

function schedulesPayload(ids: string[]) {
  return { schema: SCHEDULES_SCHEMA, schedules: ids.map((id) => ({ id })) };
}

function harness() {
  const scheduler = new ManualScheduler();
  const events = new FakeEventBus();
  const titles: string[] = [];
  const context = {
    mode: "tui",
    cwd: "/repo/project",
    ui: { setTitle: (title: string) => titles.push(title) },
  };
  const extension = createTitleExtension({
    exec: async () => ok("tree"),
    events,
    getSessionName: () => undefined,
    getTitleMode: () => "dynamic",
    scheduler,
    requestId: () => "unique",
  });
  return { scheduler, events, titles, context, extension };
}

test("a non-empty schedules snapshot shows waiting while idle, and an empty one clears it", async () => {
  const { events, titles, context, extension } = harness();
  await extension.onSessionStart({}, context);
  assert.equal(titles.length, 0);

  events.emit(SCHEDULES_CHANNEL, schedulesPayload(["s1"]));
  assert.equal(titles.at(-1), "⧗ tree");

  events.emit(SCHEDULES_CHANNEL, schedulesPayload([]));
  assert.equal(titles.at(-1), "⏹ tree");
});

test("a malformed schedules payload is ignored, leaving the current state untouched", async () => {
  const { events, titles, context, extension } = harness();
  await extension.onSessionStart({}, context);

  events.emit(SCHEDULES_CHANNEL, schedulesPayload(["s1"]));
  assert.equal(titles.at(-1), "⧗ tree");

  events.emit(SCHEDULES_CHANNEL, { schema: "wrong" });
  assert.equal(titles.at(-1), "⧗ tree");
});

test("scheduled prompts are one more waiting source: working still beats them", async () => {
  const { events, titles, context, extension } = harness();
  await extension.onSessionStart({}, context);

  events.emit(SCHEDULES_CHANNEL, schedulesPayload(["s1"]));
  assert.equal(titles.at(-1), "⧗ tree");

  extension.onAgentStart({}, context);
  assert.notEqual(titles.at(-1)?.startsWith("⧗"), true);
  extension.onAgentSettled({}, context);
  assert.equal(titles.at(-1), "⧗ tree");
});
