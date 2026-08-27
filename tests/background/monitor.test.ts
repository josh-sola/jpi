import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/index.ts";
import { afterAll, test } from "vite-plus/test";

import {
  MonitorManager,
  type MonitorSnapshot,
  resolveBackgroundItem,
} from "../../modules/background/monitor.ts";
import { BackgroundTaskRegistry } from "../../modules/background/registry.ts";

async function withTempCwd(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-background-monitor-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const agentDir = await mkdtemp(join(tmpdir(), "jpi-background-monitor-agent-"));
const store = new Store("background", { PI_CODING_AGENT_DIR: agentDir });
afterAll(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

function makeCtx(cwd: string, sessionId = "session-m") {
  return { cwd, sessionId };
}

type NotificationCall = { content: string; details: unknown; options: unknown };

function makeNotifier() {
  const calls: NotificationCall[] = [];
  const sendNotification = (message: { content: string; details: unknown }, options: unknown) => {
    calls.push({ content: message.content, details: message.details, options });
  };
  return { calls, sendNotification };
}

function makeManagers(
  overrides: {
    maxEventsPerMinute?: number;
    batchWindowMs?: number;
    defaultTimeoutSeconds?: number;
    maxRecentMonitors?: number;
    maxRecentTasks?: number;
  } = {},
) {
  const { sendNotification, calls } = makeNotifier();
  const registry = new BackgroundTaskRegistry({
    store,
    sendNotification: () => undefined,
    killGraceMs: 300,
    stopWaitMs: 1500,
    maxRecentTasks: overrides.maxRecentTasks,
    logger: { error: () => undefined },
  });
  const monitors = new MonitorManager({
    registry,
    sendNotification,
    batchWindowMs: overrides.batchWindowMs ?? 30,
    maxEventsPerMinute: overrides.maxEventsPerMinute,
    defaultTimeoutSeconds: overrides.defaultTimeoutSeconds,
    maxRecentMonitors: overrides.maxRecentMonitors,
    logger: { error: () => undefined },
  });
  return { registry, monitors, calls };
}

function waitForMonitorDone(
  registry: BackgroundTaskRegistry,
  monitors: MonitorManager,
  id: string,
  timeoutMs = 5000,
): Promise<MonitorSnapshot> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const snap = monitors.get(id);
      if (snap && snap.status !== "running") {
        cleanup();
        resolve(snap);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`monitor ${id} did not settle within ${timeoutMs}ms`));
    }, timeoutMs);
    const unsubscribe = registry.onChange(check);
    function cleanup() {
      clearTimeout(timer);
      unsubscribe();
    }
    check();
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("condition not met in time"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

test("each stdout line produces its own notification", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, monitors, calls } = makeManagers();
  const monitor = await monitors.start(
    makeCtx(cwd),
    "printf 'one\\n'; sleep 0.2; printf 'two\\n'; sleep 5",
    "two lines",
  );

  await waitFor(() => calls.length >= 2);
  assert.match(calls[0]!.content, /one/);
  assert.match(calls[1]!.content, /two/);

  await registry.stop(monitor.id);
});

test("lines within the batch window coalesce into one notification", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, monitors, calls } = makeManagers();
  const monitor = await monitors.start(makeCtx(cwd), "printf 'a\\nb\\n'", "batched lines");

  await waitForMonitorDone(registry, monitors, monitor.id);
  const eventCalls = calls.filter((call) => call.content.includes("event:"));
  assert.equal(eventCalls.length, 1);
  assert.match(eventCalls[0]!.content, /a/);
  assert.match(eventCalls[0]!.content, /b/);
});

test("stderr never triggers an event but still reaches the output file", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, monitors, calls } = makeManagers();
  const monitor = await monitors.start(
    makeCtx(cwd),
    "printf 'stdoutline\\n'; printf 'errline\\n' 1>&2",
    "stdout only",
  );

  await waitForMonitorDone(registry, monitors, monitor.id);
  const eventCalls = calls.filter((call) => call.content.includes("event:"));
  assert.equal(eventCalls.length, 1);
  assert.match(eventCalls[0]!.content, /stdoutline/);

  const output = await registry.readOutput(monitor.id, { maxBytes: 1000 });
  assert.match(output.text, /errline/);
});

test("exit sends exactly one final notification naming the exit code", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, monitors, calls } = makeManagers();
  const monitor = await monitors.start(makeCtx(cwd), "exit 3", "exits nonzero");

  const done = await waitForMonitorDone(registry, monitors, monitor.id);
  assert.equal(done.status, "exited");
  assert.equal(done.exitCode, 3);
  const terminalCalls = calls.filter((call) => call.content.includes("status: exited"));
  assert.equal(terminalCalls.length, 1);
  assert.match(terminalCalls[0]!.content, /exit_code: 3/);
});

test("flood suppression kicks in, then a hard flood stops the monitor as failed", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, monitors, calls } = makeManagers({ maxEventsPerMinute: 2, batchWindowMs: 20 });
  const monitor = await monitors.start(
    makeCtx(cwd),
    "i=0; while [ $i -lt 8 ]; do printf 'line %s\\n' \"$i\"; sleep 0.08; i=$((i+1)); done",
    "flood test",
  );

  const done = await waitForMonitorDone(registry, monitors, monitor.id, 8000);
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /stopped/);

  const eventCalls = calls.filter(
    (call) => call.content.includes("event:") && !call.content.includes("suppressed"),
  );
  assert.equal(eventCalls.length, 2);
  const suppressedCalls = calls.filter((call) => call.content.includes("suppressed"));
  assert.equal(suppressedCalls.length, 1);
  const terminalCalls = calls.filter((call) => call.content.includes("status: failed"));
  assert.equal(terminalCalls.length, 1);
});

test("a monitor timeout reports status timeout", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, monitors, calls } = makeManagers();
  const monitor = await monitors.start(makeCtx(cwd), "sleep 5", "should time out", {
    timeoutSeconds: 1,
  });

  const done = await waitForMonitorDone(registry, monitors, monitor.id, 4000);
  assert.equal(done.status, "timeout");
  const terminalCalls = calls.filter((call) => call.content.includes("status: timeout"));
  assert.equal(terminalCalls.length, 1);
});

test("persistent: true skips the default timeout", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, monitors } = makeManagers({ defaultTimeoutSeconds: 1 });
  const monitor = await monitors.start(makeCtx(cwd), "sleep 1.5; exit 0", "long watch", {
    persistent: true,
  });

  const done = await waitForMonitorDone(registry, monitors, monitor.id, 4000);
  assert.equal(done.status, "exited");
  assert.equal(done.exitCode, 0);
});

test("cancelling the underlying task reports status cancelled", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, monitors } = makeManagers();
  const monitor = await monitors.start(makeCtx(cwd), "sleep 5", "cancel me");

  await registry.stop(monitor.id);
  const done = monitors.get(monitor.id);
  assert.equal(done?.status, "cancelled");
});

test("a final line with no trailing newline still produces one event before the terminal notification", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, monitors, calls } = makeManagers();
  const monitor = await monitors.start(makeCtx(cwd), "printf 'found it'", "no trailing newline");

  await waitForMonitorDone(registry, monitors, monitor.id);

  const eventIndex = calls.findIndex((call) => call.content.includes("event:"));
  const terminalIndex = calls.findIndex((call) => call.content.includes("status: exited"));
  assert.notEqual(eventIndex, -1, "expected one event notification");
  assert.match(calls[eventIndex]!.content, /found it/);
  assert.equal(calls.filter((call) => call.content.includes("event:")).length, 1);
  assert.ok(eventIndex < terminalIndex, "the event notification must precede the terminal one");
});

test("finished monitors are pruned oldest-first past the retention cap; a running one is never pruned", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, monitors } = makeManagers({ maxRecentMonitors: 2 });

  const a = await monitors.start(makeCtx(cwd), "true", "a");
  await waitForMonitorDone(registry, monitors, a.id);
  const b = await monitors.start(makeCtx(cwd), "true", "b");
  await waitForMonitorDone(registry, monitors, b.id);
  const c = await monitors.start(makeCtx(cwd), "sleep 5", "c (stays running)");
  const d = await monitors.start(makeCtx(cwd), "true", "d");
  await waitForMonitorDone(registry, monitors, d.id);

  assert.equal(monitors.get(a.id), undefined, "oldest finished monitor should be pruned first");
  assert.equal(
    monitors.get(b.id),
    undefined,
    "second-oldest finished monitor should also be pruned",
  );
  assert.equal(monitors.get(c.id)?.status, "running", "a running monitor is never pruned");
  assert.ok(monitors.get(d.id), "the most recently finished monitor is retained");

  await registry.stop(c.id);
});

test("status resolves a finished monitor even after the registry has pruned its backing task", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, monitors } = makeManagers({ maxRecentTasks: 1 });

  const monitor = await monitors.start(
    makeCtx(cwd),
    "true",
    "will outlive its task in the registry",
  );
  await waitForMonitorDone(registry, monitors, monitor.id);

  // A second, unrelated task pushes the registry (cap 1) past its limit,
  // evicting the monitor's now-finished backing task from the registry —
  // while the monitor manager's own, larger cap still retains the monitor.
  const other = await registry.start(makeCtx(cwd), "true");
  await new Promise<void>((resolve) => {
    const unsubscribe = registry.onChange(() => {
      if (registry.get(other.id).status !== "running") {
        unsubscribe();
        resolve();
      }
    });
  });

  assert.throws(() => registry.get(monitor.id), /No background task/);
  assert.ok(monitors.get(monitor.id));

  const resolved = resolveBackgroundItem(registry, monitors, monitor.id);
  assert.equal(resolved.kind, "monitor");
  assert.equal(resolved.id, monitor.id);
});
