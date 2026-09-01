import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";

import { Store } from "../../src/core/index.ts";
import {
  ScheduleRegistry,
  type CronFactory,
  type CronLike,
} from "../../modules/schedule/registry.ts";
import {
  loadScheduleFile,
  saveScheduleFile,
  scheduleFileName,
  sweepStaleScheduleFiles,
  type PersistedSchedule,
} from "../../modules/schedule/store.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

async function tempEnv(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-schedule-store-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { PI_CODING_AGENT_DIR: dir };
}

test("save/load round-trips a session's schedules", async (t) => {
  const env = await tempEnv(t);
  const store = new Store("schedule", env);
  const schedules: PersistedSchedule[] = [
    {
      id: "s1",
      prompt: "ping",
      cronExpression: "* * * * *",
      createdAt: 1000,
      runCount: 2,
      lastFiredAt: 2000,
    },
    {
      id: "s2",
      prompt: "pong",
      cronExpression: "*/30 * * * * *",
      createdAt: 1500,
      runCount: 0,
    },
  ];

  await saveScheduleFile(store, "session-a", schedules);
  const loaded = await loadScheduleFile(store, "session-a");

  assert.deepEqual(loaded, schedules);
});

test("loading a missing file starts empty", async (t) => {
  const env = await tempEnv(t);
  const store = new Store("schedule", env);
  assert.deepEqual(await loadScheduleFile(store, "no-such-session"), []);
});

test("loading a malformed (non-JSON) file starts empty", async (t) => {
  const env = await tempEnv(t);
  const store = new Store("schedule", env);
  const path = store.path(scheduleFileName("session-b"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "not json", "utf8");

  assert.deepEqual(await loadScheduleFile(store, "session-b"), []);
});

test("loading drops entries missing required fields but keeps the rest", async (t) => {
  const env = await tempEnv(t);
  const store = new Store("schedule", env);
  await store.write(scheduleFileName("session-c"), {
    version: 1,
    schedules: [
      { id: "ok", prompt: "fine", cronExpression: "* * * * *", createdAt: 1, runCount: 0 },
      { id: "bad", prompt: "missing cron expression" },
      { prompt: "missing id", cronExpression: "* * * * *" },
    ],
  });

  const loaded = await loadScheduleFile(store, "session-c");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.id, "ok");
});

test("restore re-arms schedules loaded from the store", async (t) => {
  const env = await tempEnv(t);
  const store = new Store("schedule", env);
  const persisted: PersistedSchedule[] = [
    {
      id: "s1",
      prompt: "ping",
      cronExpression: "* * * * *",
      createdAt: 1000,
      runCount: 1,
      lastFiredAt: 2000,
    },
  ];
  await saveScheduleFile(store, "session-d", persisted);

  const armedExpressions: string[] = [];
  const createCron: CronFactory = (expression) => {
    armedExpressions.push(expression);
    const cronLike: CronLike = { nextRun: () => null, stop: () => {} };
    return cronLike;
  };
  const registry = new ScheduleRegistry({
    store,
    sendNotification: () => undefined,
    createCron,
  });

  const loaded = await loadScheduleFile(store, "session-d");
  registry.restore(loaded);

  assert.deepEqual(armedExpressions, ["* * * * *"]);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.list()[0]!.runCount, 1);
});

test("sweep drops only files older than ttlDays, and never the current session's file", async (t) => {
  const env = await tempEnv(t);
  const store = new Store("schedule", env);
  const root = join(env.PI_CODING_AGENT_DIR!, "jpi", "schedule");
  const now = Date.now();

  await saveScheduleFile(store, "old-session", []);
  await saveScheduleFile(store, "fresh-session", []);
  await saveScheduleFile(store, "current-session", []);

  const oldPath = store.path(scheduleFileName("old-session"));
  const oldSeconds = (now - 40 * DAY_MS) / 1000;
  await utimes(oldPath, oldSeconds, oldSeconds);

  await sweepStaleScheduleFiles(root, 30, now, store.path(scheduleFileName("current-session")));

  await assert.rejects(stat(oldPath));
  assert.ok((await stat(store.path(scheduleFileName("fresh-session")))).isFile());
  assert.ok((await stat(store.path(scheduleFileName("current-session")))).isFile());
});

test("sweep tolerates a nonexistent root", async (t) => {
  const env = await tempEnv(t);
  await assert.doesNotReject(
    sweepStaleScheduleFiles(
      join(env.PI_CODING_AGENT_DIR!, "jpi", "schedule"),
      30,
      Date.now(),
      "/keep",
    ),
  );
});
