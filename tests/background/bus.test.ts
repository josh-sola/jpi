import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vite-plus/test";

import { Store } from "../../src/core/index.ts";
import {
  createBackgroundBus,
  jpiBackgroundRunningIds,
  REQUEST_CHANNEL,
  REQUEST_SCHEMA,
  RESPONSE_CHANNEL,
  TASKS_CHANNEL,
  TASKS_SCHEMA,
  TERMINAL_CHANNEL,
  type EventBus,
} from "../../modules/background/bus.ts";
import { MonitorManager } from "../../modules/background/monitor.ts";
import { BackgroundTaskRegistry, type TaskRunContext } from "../../modules/background/registry.ts";

function createTestEventBus(): EventBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel, data) {
      const set = listeners.get(channel);
      if (!set) return;
      for (const listener of [...set]) listener(data);
    },
    on(channel, handler) {
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

async function withTempCwd(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-background-bus-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const agentDir = await mkdtemp(join(tmpdir(), "jpi-background-bus-agent-"));
const store = new Store("background", { PI_CODING_AGENT_DIR: agentDir });
afterAll(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

function setUp(cwd: string) {
  const events = createTestEventBus();
  const bus = createBackgroundBus(events, { error: () => undefined });

  let monitors: MonitorManager | undefined;
  const registry = new BackgroundTaskRegistry({
    store,
    sendNotification: () => undefined,
    publishTerminal: (task) => {
      if (monitors?.has(task.id)) return;
      bus.publishTerminal(task);
    },
    killGraceMs: 300,
    stopWaitMs: 1500,
    logger: { error: () => undefined },
  });
  monitors = new MonitorManager({
    registry,
    sendNotification: () => undefined,
    publishTerminal: (monitor) => bus.publishTerminal(monitor),
    logger: { error: () => undefined },
  });
  const ctx: TaskRunContext = { cwd, sessionId: "session-bus" };
  bus.attach(registry, monitors, () => ctx);
  return { events, registry, monitors, bus };
}

function waitForStatus(
  registry: BackgroundTaskRegistry,
  id: string,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (registry.get(id).status !== "running") {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`task ${id} did not settle within ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = registry.onChange(check);
    function cleanup() {
      clearTimeout(timer);
      unsubscribe();
    }
    check();
  });
}

function waitForResponse(
  events: EventBus,
  requestId: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no response for ${requestId} within ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = events.on(RESPONSE_CHANNEL, (data) => {
      const record = data as Record<string, unknown>;
      if (record.request_id !== requestId) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(record);
    });
  });
}

test("a request is correlated to its response by request_id", async (t) => {
  const cwd = await withTempCwd(t);
  const { events, registry } = setUp(cwd);

  const responsePromise = waitForResponse(events, "req-1");
  events.emit(REQUEST_CHANNEL, {
    schema: REQUEST_SCHEMA,
    request_id: "req-1",
    operation: "run",
    params: { command: "printf hi" },
  });
  const response = await responsePromise;
  assert.equal(response.ok, true);
  assert.equal(response.operation, "run");
  const result = response.result as { task: { id: string } };
  assert.ok(result.task.id);

  // Let the task actually finish before the test's temp dir is cleaned up.
  await waitForStatus(registry, result.task.id);
});

test("a message with an unknown or malformed schema is ignored silently", async (t) => {
  const cwd = await withTempCwd(t);
  const { events } = setUp(cwd);

  let responded = false;
  events.on(RESPONSE_CHANNEL, () => {
    responded = true;
  });

  events.emit(REQUEST_CHANNEL, { schema: "someone-else.v1", request_id: "x", operation: "run" });
  events.emit(REQUEST_CHANNEL, {
    schema: REQUEST_SCHEMA,
    request_id: "y",
    operation: "not-a-real-op",
  });
  events.emit(REQUEST_CHANNEL, "not even an object");
  events.emit(REQUEST_CHANNEL, undefined);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(responded, false);
});

test("a terminal snapshot is broadcast with a dedupe-able task id", async (t) => {
  const cwd = await withTempCwd(t);
  const { events, registry } = setUp(cwd);

  const terminalEvents: Array<{ task: { id: string; status: string } }> = [];
  events.on(TERMINAL_CHANNEL, (data) => {
    terminalEvents.push(data as { task: { id: string; status: string } });
  });

  const task = await registry.start({ cwd, sessionId: "s1" }, "printf hi");
  await waitForStatus(registry, task.id);

  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0]!.task.id, task.id);
  assert.equal(terminalEvents[0]!.task.status, "completed");
});

test("the tasks-level channel broadcasts the full running set on start and on finish", async (t) => {
  const cwd = await withTempCwd(t);
  const { events, registry } = setUp(cwd);

  const levels: Array<Array<{ id: string }>> = [];
  events.on(TASKS_CHANNEL, (data) => {
    levels.push((data as { tasks: Array<{ id: string }> }).tasks);
  });

  const task = await registry.start({ cwd, sessionId: "s1" }, "sleep 0.2");
  assert.ok(levels.some((level) => level.some((entry) => entry.id === task.id)));

  await waitForStatus(registry, task.id);

  const lastLevel = levels.at(-1);
  assert.ok(lastLevel);
  assert.equal(
    lastLevel?.some((entry) => entry.id === task.id),
    false,
  );
});

test("jpiBackgroundRunningIds reads the running set off a tasks-level envelope", () => {
  assert.deepEqual(
    jpiBackgroundRunningIds({
      schema: TASKS_SCHEMA,
      tasks: [{ id: "a" }, { id: "b" }, { id: "" }, { notAnId: 1 }],
    }),
    new Set(["a", "b"]),
  );
});

test("jpiBackgroundRunningIds ignores payloads on the wrong schema or shape", () => {
  assert.equal(jpiBackgroundRunningIds(undefined), undefined);
  assert.equal(jpiBackgroundRunningIds("not an object"), undefined);
  assert.equal(jpiBackgroundRunningIds({ schema: "someone-else.v1", tasks: [] }), undefined);
  assert.equal(jpiBackgroundRunningIds({ schema: TASKS_SCHEMA, tasks: "not-an-array" }), undefined);
});
