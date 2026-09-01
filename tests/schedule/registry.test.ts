import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vite-plus/test";

import { Store } from "../../src/core/index.ts";
import {
  ScheduleRegistry,
  type CronFactory,
  type CronLike,
  type ScheduleNotificationMessage,
  type ScheduleNotificationOptions,
  type ScheduleRegistryOptions,
} from "../../modules/schedule/registry.ts";

const agentDir = await mkdtemp(join(tmpdir(), "jpi-schedule-registry-agent-"));
const store = new Store("schedule", { PI_CODING_AGENT_DIR: agentDir });
afterAll(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

type NotificationCall = {
  message: ScheduleNotificationMessage;
  options: ScheduleNotificationOptions;
};

function makeNotifier() {
  const calls: NotificationCall[] = [];
  const sendNotification = (
    message: ScheduleNotificationMessage,
    options: ScheduleNotificationOptions,
  ) => {
    calls.push({ message, options });
  };
  return { calls, sendNotification };
}

interface FakeCronJob {
  readonly expression: string;
  readonly callback: () => void;
  stopped: boolean;
  nextRunAt: number | null;
}

function makeFakeCronFactory() {
  const jobs: FakeCronJob[] = [];
  const createCron: CronFactory = (expression, callback) => {
    const job: FakeCronJob = {
      expression,
      callback,
      stopped: false,
      nextRunAt: Date.now() + 60_000,
    };
    jobs.push(job);
    const cronLike: CronLike = {
      nextRun: () => (job.stopped || job.nextRunAt === null ? null : new Date(job.nextRunAt)),
      stop: () => {
        job.stopped = true;
      },
    };
    return cronLike;
  };
  return { jobs, createCron };
}

function makeRegistry(
  overrides: Partial<
    Pick<ScheduleRegistryOptions, "makeId" | "now" | "createCron" | "maxSchedules">
  > = {},
) {
  const { calls, sendNotification } = makeNotifier();
  let idCounter = 0;
  const registry = new ScheduleRegistry({
    store,
    sendNotification,
    now: overrides.now ?? (() => 1_000_000),
    makeId: overrides.makeId ?? (() => `s${++idCounter}`),
    ...(overrides.createCron ? { createCron: overrides.createCron } : {}),
    ...(overrides.maxSchedules !== undefined ? { maxSchedules: overrides.maxSchedules } : {}),
  });
  return { registry, calls };
}

test("create arms a cron schedule and its nextRun comes from the injected croner", () => {
  const { jobs, createCron } = makeFakeCronFactory();
  const { registry } = makeRegistry({ createCron });

  const created = registry.create("do the thing", "*/5 * * * *");

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.expression, "*/5 * * * *");
  assert.equal(created.nextRun, jobs[0]!.nextRunAt);
  assert.equal(created.runCount, 0);
  assert.equal(created.lastFiredAt, undefined);
});

test("create accepts a 6-field cron expression with a seconds column", () => {
  const { jobs, createCron } = makeFakeCronFactory();
  const { registry } = makeRegistry({ createCron });

  const created = registry.create("ping often", "*/30 * * * * *");

  assert.equal(jobs[0]!.expression, "*/30 * * * * *");
  assert.equal(created.cronExpression, "*/30 * * * * *");
});

test("create rejects an empty prompt", () => {
  const { registry } = makeRegistry();
  assert.throws(() => registry.create("   ", "* * * * *"), /empty/);
});

test("create rejects an invalid cron expression", () => {
  const { registry } = makeRegistry();
  assert.throws(() => registry.create("do it", "not a cron"), /Invalid cron expression/);
});

test("create enforces max-schedules", () => {
  const { createCron } = makeFakeCronFactory();
  const { registry } = makeRegistry({ createCron, maxSchedules: 1 });

  registry.create("first", "* * * * *");
  assert.throws(() => registry.create("second", "* * * * *"), /Cannot exceed 1/);
});

test("stop resolves an unambiguous id prefix and disarms the timer", () => {
  const { jobs, createCron } = makeFakeCronFactory();
  let n = 0;
  const ids = ["abcdef", "zzzzzz"];
  const { registry } = makeRegistry({ createCron, makeId: () => ids[n++]! });

  registry.create("first", "* * * * *");
  registry.create("second", "* * * * *");

  const stopped = registry.stop("abc");
  assert.equal(stopped.id, "abcdef");
  assert.equal(registry.list().length, 1);
  assert.equal(jobs[0]!.stopped, true);
  assert.equal(jobs[1]!.stopped, false);
});

test("stop rejects an ambiguous prefix and lists the candidates", () => {
  const { createCron } = makeFakeCronFactory();
  let n = 0;
  const ids = ["abc111", "abc222"];
  const { registry } = makeRegistry({ createCron, makeId: () => ids[n++]! });

  registry.create("first", "* * * * *");
  registry.create("second", "* * * * *");

  assert.throws(() => registry.stop("abc"), /ambiguous: matches abc111, abc222/);
});

test("stop rejects an unknown id", () => {
  const { registry } = makeRegistry();
  assert.throws(() => registry.stop("nope"), /No scheduled prompt matches/);
});

test("reset stops every timer and clears the map", () => {
  const { jobs, createCron } = makeFakeCronFactory();
  const { registry } = makeRegistry({ createCron });

  registry.create("cron one", "* * * * *");
  registry.create("cron two", "*/5 * * * *");

  registry.reset();

  assert.equal(registry.list().length, 0);
  assert.equal(jobs[0]!.stopped, true);
  assert.equal(jobs[1]!.stopped, true);
});

test("firing a schedule sends a followUp/triggerTurn notification and bumps runCount/lastFiredAt", () => {
  const { jobs, createCron } = makeFakeCronFactory();
  let now = 1_000_000;
  const { registry, calls } = makeRegistry({ createCron, now: () => now });

  const created = registry.create("ping", "* * * * *");
  now = 2_000_000;
  jobs[0]!.callback();

  assert.equal(calls.length, 1);
  const { message, options } = calls[0]!;
  assert.equal(message.customType, "jpi-schedule-notification");
  assert.equal(message.display, true);
  assert.ok(message.content.includes(created.id));
  assert.ok(message.content.includes("ping"));
  assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });

  const after = registry.get(created.id);
  assert.equal(after.runCount, 1);
  assert.equal(after.lastFiredAt, 2_000_000);
});

test("onChange fires on create, stop, and fire", () => {
  const { jobs, createCron } = makeFakeCronFactory();
  const { registry } = makeRegistry({ createCron });

  let changes = 0;
  registry.onChange(() => {
    changes++;
  });

  const created = registry.create("watch me", "* * * * *");
  assert.equal(changes, 1);

  jobs[0]!.callback();
  assert.equal(changes, 2);

  registry.stop(created.id);
  assert.equal(changes, 3);
});

test("restore re-arms persisted schedules via the injected croner", () => {
  const { jobs, createCron } = makeFakeCronFactory();
  const { registry } = makeRegistry({ createCron });

  registry.restore([
    {
      id: "s1",
      prompt: "ping",
      cronExpression: "* * * * *",
      createdAt: 1000,
      runCount: 2,
      lastFiredAt: 2000,
    },
  ]);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.expression, "* * * * *");
  const listed = registry.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.runCount, 2);
  assert.equal(listed[0]!.lastFiredAt, 2000);
});
