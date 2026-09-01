import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Config, injectEnabled, Store } from "../../src/core/index.ts";
import { scheduleSchema } from "../../modules/schedule/config.ts";
import { registerSchedule } from "../../modules/schedule/index.ts";
import { saveScheduleFile } from "../../modules/schedule/store.ts";

const SCHEDULES_CHANNEL = "jpi-schedule:schedules:v1";
const SCHEDULES_SCHEMA = "jpi-schedule.schedules.v1";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

/** Tests bypass the module loader, so they build the same injected-schema config it would. */
function makeConfig(env: NodeJS.ProcessEnv) {
  return new Config("schedule", injectEnabled("schedule", scheduleSchema), env);
}

function createTestEventBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    emitted,
    emit(channel: string, data: unknown) {
      emitted.push({ channel, data });
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
  };
}

function makeFakePi() {
  const handlers = new Map<string, Handler>();
  const events = createTestEventBus();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    sendMessage() {},
    events,
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
  };
  // Exercises only the slice of ExtensionAPI that registerSchedule calls.
  return { pi: pi as unknown as ExtensionAPI, handlers, events };
}

function makeFakeUiCtx(sessionId: string) {
  return {
    hasUI: false,
    sessionManager: { getSessionId: () => sessionId },
    ui: { setStatus() {} },
  };
}

async function withTempEnv(t: { onTestFinished: (fn: () => Promise<void> | void) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "jpi-schedule-bus-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { env: { PI_CODING_AGENT_DIR: dir } };
}

function snapshots(events: ReturnType<typeof createTestEventBus>) {
  return events.emitted
    .filter((entry) => entry.channel === SCHEDULES_CHANNEL)
    .map((entry) => entry.data as { schema: string; schedules: Array<{ id: string }> });
}

test("registerSchedule emits the full snapshot on every registry change", async (t) => {
  const { env } = await withTempEnv(t);
  const { pi, handlers, events } = makeFakePi();
  const { registry } = registerSchedule(pi, makeConfig(env), { env });

  await handlers.get("session_start")?.({ type: "session_start" }, makeFakeUiCtx("s1"));
  events.emitted.length = 0;

  const created = registry.create("ping", "* * * * *");
  assert.deepEqual(snapshots(events).at(-1), {
    schema: SCHEDULES_SCHEMA,
    schedules: [{ id: created.id }],
  });

  registry.stop(created.id);
  assert.deepEqual(snapshots(events).at(-1), { schema: SCHEDULES_SCHEMA, schedules: [] });
});

test("session_start's deferred re-emit reaches a subscriber that wires up after restore already fired", async (t) => {
  const { env } = await withTempEnv(t);
  const store = new Store("schedule", env);
  await saveScheduleFile(store, "s1", [
    { id: "s1a", prompt: "ping", cronExpression: "* * * * *", createdAt: 1000, runCount: 0 },
  ]);

  const { pi, handlers, events } = makeFakePi();
  registerSchedule(pi, makeConfig(env), { env });
  await handlers.get("session_start")?.({ type: "session_start" }, makeFakeUiCtx("s1"));

  // Simulate jpi-title subscribing only after this handler has fully run —
  // restore()'s synchronous emit already fired and went unheard.
  const received: unknown[] = [];
  events.on(SCHEDULES_CHANNEL, (data) => received.push(data));
  assert.equal(received.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { schema: SCHEDULES_SCHEMA, schedules: [{ id: "s1a" }] });
});
