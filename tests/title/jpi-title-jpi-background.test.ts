import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { jpiBackgroundRunningIds } from "../../modules/background/bus.ts";
import { createTitleExtension } from "../../modules/title/extension.ts";
import { FakeEventBus, ManualScheduler, ok, statusResponse } from "./jpi-title-test-helpers.ts";

const TASKS_CHANNEL = "jpi-background:tasks:v1";
const RESPONSE_CHANNEL = "pi-background-tasks:response:v1";

function tasksPayload(ids: string[]) {
  return {
    schema: "jpi-background.tasks.v1",
    tasks: ids.map((id) => ({
      kind: "task",
      id,
      status: "running",
      name: id,
      command: "echo hi",
      startTime: 0,
    })),
  };
}

function requests(events: FakeEventBus) {
  return events.emitted
    .filter(({ channel }) => channel === "pi-background-tasks:request:v1")
    .map(({ data }) => data as { request_id: string; [key: string]: unknown });
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
    scheduler,
    requestId: () => "unique",
  });
  return { scheduler, events, titles, context, extension };
}

test("jpiBackgroundRunningIds accepts a well-formed payload and rejects malformed ones", () => {
  assert.deepEqual(jpiBackgroundRunningIds(tasksPayload(["a", "b"])), new Set(["a", "b"]));
  assert.deepEqual(jpiBackgroundRunningIds(tasksPayload([])), new Set());
  assert.equal(jpiBackgroundRunningIds({ schema: "jpi-background.tasks.v1" }), undefined);
  assert.equal(jpiBackgroundRunningIds({ schema: "wrong", tasks: [] }), undefined);
  assert.equal(jpiBackgroundRunningIds(undefined), undefined);
  assert.equal(jpiBackgroundRunningIds(null), undefined);
  assert.equal(jpiBackgroundRunningIds([]), undefined);
  assert.deepEqual(
    jpiBackgroundRunningIds({
      schema: "jpi-background.tasks.v1",
      tasks: [{ id: "a" }, { status: "running" }, "nope"],
    }),
    new Set(["a"]),
  );
});

test("tasks:v1 is a replace-set: each payload wholly replaces the previous running set", async () => {
  const { events, titles, context, extension } = harness();
  await extension.onSessionStart({}, context);
  assert.equal(titles.length, 0);

  events.emit(TASKS_CHANNEL, tasksPayload(["t1"]));
  assert.equal(titles.at(-1), "⠋ tree");

  // an empty payload clears activity even though the previous set was non-empty
  events.emit(TASKS_CHANNEL, tasksPayload([]));
  assert.equal(titles.at(-1), "⏹ tree");

  events.emit(TASKS_CHANNEL, tasksPayload(["t2", "t3"]));
  assert.equal(titles.at(-1), "⠋ tree");

  // a malformed payload is ignored, leaving the current state untouched
  events.emit(TASKS_CHANNEL, { schema: "wrong" });
  assert.equal(titles.at(-1), "⠋ tree");
});

test("jpi-background and the legacy provider union: either one running keeps the title active", async () => {
  const { scheduler, events, titles, context, extension } = harness();
  await extension.onSessionStart({}, context);
  events.emit(RESPONSE_CHANNEL, statusResponse(requests(events)[0], ["completed"]));
  assert.equal(titles.length, 0);

  events.emit(TASKS_CHANNEL, tasksPayload(["t1"]));
  assert.equal(titles.at(-1), "⠋ tree");

  const poll = scheduler.active("interval", 1_000)[0];
  scheduler.fire(poll);
  events.emit(RESPONSE_CHANNEL, statusResponse(requests(events).at(-1)!, ["running"]));
  assert.equal(titles.at(-1), "⠋ tree");

  // jpi-background clears, but the legacy provider is still running
  events.emit(TASKS_CHANNEL, tasksPayload([]));
  assert.equal(titles.at(-1), "⠋ tree");

  // both providers clear: idle again
  scheduler.fire(poll);
  events.emit(RESPONSE_CHANNEL, statusResponse(requests(events).at(-1)!, ["completed"]));
  assert.equal(titles.at(-1), "⏹ tree");
});
