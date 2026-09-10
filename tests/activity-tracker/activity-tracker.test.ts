import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createActivityTracker, type ActivitySnapshot } from "../../src/core/activity-tracker.ts";

class FakeEventBus {
  handlers = new Map<string, Set<(data: unknown) => void>>();
  unsubscribed = 0;

  on(channel: string, handler: (data: unknown) => void) {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => {
      if (handlers.delete(handler)) this.unsubscribed += 1;
    };
  }

  emit(channel: string, data: unknown) {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
}

class ManualScheduler {
  timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];

  setTimeout(callback: () => void, delay: number) {
    const timer = { callback, delay, cleared: false };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(timer: unknown) {
    (timer as { cleared: boolean }).cleared = true;
  }

  fire(timer: { callback: () => void; cleared: boolean }) {
    if (timer.cleared) return;
    timer.cleared = true;
    timer.callback();
  }

  active(delay: number) {
    return this.timers.filter((timer) => timer.delay === delay && !timer.cleared);
  }
}

function taskSet(ids: string[]) {
  return {
    schema: "jpi-background.tasks.v1",
    tasks: ids.map((id) => ({ id })),
  };
}

function harness() {
  const events = new FakeEventBus();
  const scheduler = new ManualScheduler();
  const snapshots: ActivitySnapshot[] = [];
  const tracker = createActivityTracker({
    events,
    now: () => 1234,
    scheduler,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { events, scheduler, snapshots, tracker };
}

test("start emits the initial done snapshot", () => {
  const { tracker, snapshots } = harness();
  tracker.start();
  assert.deepEqual(snapshots, [{ state: "done", monitoring: false, subagents: [] }]);
});

test("foreground stays working, not monitoring, until setForeground(false)", () => {
  const { tracker, events, snapshots } = harness();
  tracker.start();
  tracker.setForeground(true);
  events.emit("subagents:started", { id: "a", type: "explore", description: "Inspect" });
  assert.deepEqual(snapshots.at(-1), {
    state: "working",
    monitoring: false,
    subagents: [
      { id: "a", state: "working", startedAt: 1234, agentType: "explore", description: "Inspect" },
    ],
  });
  events.emit("subagents:completed", { id: "a" });
  assert.deepEqual(snapshots.at(-1), { state: "working", monitoring: false, subagents: [] });
  tracker.setForeground(false);
  assert.deepEqual(snapshots.at(-1), { state: "done", monitoring: false, subagents: [] });
});

test("detached subagent work reports working with monitoring true", () => {
  const { tracker, events, snapshots } = harness();
  tracker.start();
  events.emit("subagents:started", {
    id: "a",
    startedAt: 7,
    type: "general-purpose",
    description: "Review",
  });
  assert.deepEqual(snapshots.at(-1), {
    state: "working",
    monitoring: true,
    subagents: [
      {
        id: "a",
        state: "working",
        startedAt: 7,
        agentType: "general-purpose",
        description: "Review",
      },
    ],
  });
});

test("a prompt blocks and reports blocked with monitoring false", () => {
  const { tracker, events, snapshots } = harness();
  tracker.start();
  events.emit("subagents:started", { id: "a" });
  tracker.startPrompt();
  assert.deepEqual(snapshots.at(-1), {
    state: "blocked",
    monitoring: false,
    subagents: [{ id: "a", state: "working", startedAt: 1234 }],
  });
  tracker.endPrompt();
  assert.deepEqual(snapshots.at(-1), {
    state: "working",
    monitoring: true,
    subagents: [{ id: "a", state: "working", startedAt: 1234 }],
  });
});

test("background tasks form a replace-set", () => {
  const { tracker, events, snapshots, scheduler } = harness();
  tracker.start();
  events.emit("jpi-background:tasks:v1", taskSet(["one"]));
  assert.deepEqual(snapshots.at(-1), { state: "working", monitoring: true, subagents: [] });
  events.emit("jpi-background:tasks:v1", taskSet([]));
  assert.equal(snapshots.at(-1)?.state, "working");
  assert.equal(scheduler.active(250).length, 1);
});

test("holds monitoring through the final detached completion before publishing done, after a grace period", () => {
  const { tracker, events, snapshots, scheduler } = harness();
  tracker.start();
  events.emit("subagents:started", { id: "a" });
  const beforeCompletion = snapshots.length;
  events.emit("subagents:failed", { id: "a" });
  assert.equal(snapshots.length, beforeCompletion);
  const grace = scheduler.active(250)[0];
  assert.ok(grace);
  scheduler.fire(grace);
  assert.deepEqual(snapshots.at(-1), { state: "done", monitoring: false, subagents: [] });
});

test("a foreground turn during grace cancels the delayed done", () => {
  const { tracker, events, snapshots, scheduler } = harness();
  tracker.start();
  events.emit("subagents:started", { id: "a" });
  events.emit("subagents:completed", { id: "a" });
  const grace = scheduler.active(250)[0];
  assert.ok(grace);
  tracker.setForeground(true);
  assert.equal(grace.cleared, true);
  assert.deepEqual(snapshots.at(-1), { state: "working", monitoring: false, subagents: [] });
  scheduler.fire(grace);
  assert.deepEqual(snapshots.at(-1), { state: "working", monitoring: false, subagents: [] });
});

test("dispose removes listeners and cancels a pending grace timer", () => {
  const { tracker, events, snapshots, scheduler } = harness();
  tracker.start();
  events.emit("subagents:started", { id: "a" });
  events.emit("subagents:completed", { id: "a" });
  const grace = scheduler.active(250)[0];
  assert.ok(grace);
  const beforeDispose = snapshots.length;
  tracker.dispose();
  assert.equal(grace.cleared, true);
  assert.equal(events.unsubscribed, 4);
  scheduler.fire(grace);
  assert.equal(snapshots.length, beforeDispose);
});

test("suppresses consecutive identical snapshots", () => {
  const { tracker, events, snapshots } = harness();
  tracker.start();
  tracker.setForeground(true);
  tracker.setForeground(true);
  events.emit("jpi-background:tasks:v1", taskSet(["one"]));
  events.emit("jpi-background:tasks:v1", taskSet(["one", "two"]));
  assert.deepEqual(snapshots, [
    { state: "done", monitoring: false, subagents: [] },
    { state: "working", monitoring: false, subagents: [] },
  ]);
});
