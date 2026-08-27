import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSlug, Store } from "../../src/core/index.ts";
import { afterAll, test } from "vite-plus/test";

import {
  BackgroundTaskRegistry,
  type BackgroundTaskRegistryOptions,
  type BgTaskSnapshot,
  type CompletionNotificationMessage,
  type CompletionNotificationOptions,
} from "../../modules/background/registry.ts";

async function withTempCwd(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-background-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const agentDir = await mkdtemp(join(tmpdir(), "jpi-background-registry-agent-"));
const store = new Store("background", { PI_CODING_AGENT_DIR: agentDir });
afterAll(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

function makeCtx(cwd: string, sessionId = "session-a") {
  return { cwd, sessionId };
}

type NotificationCall = {
  message: CompletionNotificationMessage;
  options: CompletionNotificationOptions;
};

function makeNotifier(impl?: (call: NotificationCall) => void) {
  const calls: NotificationCall[] = [];
  let resolveFirstCall: (() => void) | undefined;
  const firstCall = new Promise<void>((resolve) => {
    resolveFirstCall = resolve;
  });
  const sendNotification = (
    message: CompletionNotificationMessage,
    options: CompletionNotificationOptions,
  ) => {
    calls.push({ message, options });
    resolveFirstCall?.();
    if (impl) impl({ message, options });
  };
  return { calls, sendNotification, firstCall };
}

function makeRegistry(overrides: Partial<BackgroundTaskRegistryOptions> = {}) {
  const { sendNotification, calls, firstCall } = makeNotifier();
  const registry = new BackgroundTaskRegistry({
    store,
    sendNotification,
    killGraceMs: 300,
    stopWaitMs: 1500,
    logger: { error: () => undefined },
    ...overrides,
  });
  return { registry, calls, firstCall };
}

function waitForStatus(
  registry: BackgroundTaskRegistry,
  id: string,
  timeoutMs = 5000,
): Promise<BgTaskSnapshot> {
  return new Promise((resolve, reject) => {
    const check = () => {
      const snap = registry.get(id);
      if (snap.status !== "running") {
        cleanup();
        resolve(snap);
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

test("start tracks a spawned task with pid and running status", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry();
  const started = await registry.start(makeCtx(cwd), "printf hello");
  assert.equal(started.status, "running");
  assert.ok(started.pid !== undefined);
  assert.equal(registry.get(started.id).id, started.id);
  await waitForStatus(registry, started.id);
});

test("exit code maps to completed on 0 and failed otherwise", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry();

  const ok = await registry.start(makeCtx(cwd), "exit 0");
  const okDone = await waitForStatus(registry, ok.id);
  assert.equal(okDone.status, "completed");
  assert.equal(okDone.exitCode, 0);

  const bad = await registry.start(makeCtx(cwd), "exit 3");
  const badDone = await waitForStatus(registry, bad.id);
  assert.equal(badDone.status, "failed");
  assert.equal(badDone.exitCode, 3);
  assert.match(badDone.error ?? "", /code 3/);
});

test("output is written to the task's output file", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry();
  const started = await registry.start(makeCtx(cwd), "printf 'hello world'");
  await waitForStatus(registry, started.id);
  const text = await readFile(started.outputPath, "utf8");
  assert.equal(text, "hello world");
});

test("exceeding the output cap kills the task as failed with a notice", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry({ maxOutputBytes: 100 });
  const started = await registry.start(
    makeCtx(cwd),
    "i=0; while [ $i -lt 50 ]; do printf '0123456789'; i=$((i+1)); done",
  );
  const done = await waitForStatus(registry, started.id);
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /cap/);
  const text = await readFile(started.outputPath, "utf8");
  assert.match(text, /background task output cap/);
  assert.ok(Buffer.byteLength(text, "utf8") <= 100 + 200);
});

test("a per-task timeout kills the task as failed", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry();
  const started = await registry.start(makeCtx(cwd), "sleep 5", { timeoutSeconds: 1 });
  const done = await waitForStatus(registry, started.id, 4000);
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /Timed out/);
});

test("stopping a task sends exactly one SIGKILL under concurrent stop calls", async (t) => {
  const cwd = await withTempCwd(t);
  let sigtermCount = 0;
  let sigkillCount = 0;
  const { registry } = makeRegistry({
    killGraceMs: 80,
    stopWaitMs: 1000,
    killProcess: (pid, signal) => {
      if (signal === "SIGTERM") sigtermCount += 1;
      if (signal === "SIGKILL") sigkillCount += 1;
      process.kill(pid, signal);
    },
  });
  // SIG_IGN dispositions (trap '' TERM) survive exec, so this process ignores
  // SIGTERM but still dies on the SIGKILL escalation.
  const started = await registry.start(makeCtx(cwd), "trap '' TERM; exec sleep 5");
  // Give the shell time to install the trap before stopping it; under heavy
  // load a signal arriving before that would kill it the ordinary way.
  await new Promise((resolve) => setTimeout(resolve, 150));

  const [first, second] = await Promise.allSettled([
    registry.stop(started.id),
    registry.stop(started.id),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "fulfilled");
  assert.equal(sigtermCount, 1);
  assert.equal(sigkillCount, 1);

  const done = registry.get(started.id);
  assert.equal(done.status, "killed");
});

test("group kill reaches a backgrounded grandchild", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry({ stopWaitMs: 2000 });
  const started = await registry.start(makeCtx(cwd), "sleep 30 & wait");

  const startedAt = Date.now();
  await registry.stop(started.id);
  const elapsedMs = Date.now() - startedAt;

  // The grandchild sleep would otherwise keep "wait" blocked for 30s; a fast
  // return proves the group-wide SIGTERM reached it too.
  assert.ok(elapsedMs < 5000, `expected a fast group kill, took ${elapsedMs}ms`);
  assert.equal(registry.get(started.id).status, "killed");
});

test("killing a task that is not running rejects", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry();
  const started = await registry.start(makeCtx(cwd), "true");
  await waitForStatus(registry, started.id);
  await assert.rejects(() => registry.stop(started.id), /not running/);
});

test("finalize order: metadata is durable and output is closed before the wake fires", async (t) => {
  const cwd = await withTempCwd(t);
  let checked = false;
  const { sendNotification, firstCall } = makeNotifier(({ message: notificationMessage }) => {
    checked = true;
    const metadataPath = store.path(
      join(projectSlug(cwd), `session-a-${process.pid}`, `${notificationMessage.details.id}.json`),
    );
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    assert.equal(metadata.status, "completed");
    const outputText = readFileSync(notificationMessage.details.outputPath, "utf8");
    assert.equal(outputText, "hi");
  });
  const registry = new BackgroundTaskRegistry({
    store,
    sendNotification,
    killGraceMs: 300,
    stopWaitMs: 1500,
  });

  await registry.start(makeCtx(cwd), "printf hi");
  await firstCall;
  assert.ok(checked, "notification callback should have run");
});

test("a completed task notifies exactly once", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, calls, firstCall } = makeRegistry();
  const started = await registry.start(makeCtx(cwd), "printf hi");
  await firstCall;
  await waitForStatus(registry, started.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.message.customType, "jpi-background-notification");
  assert.equal(registry.get(started.id).notified, true);
});

test("a throwing sender resets the notified flag", async (t) => {
  const cwd = await withTempCwd(t);
  let attempts = 0;
  const { sendNotification, calls, firstCall } = makeNotifier(() => {
    attempts += 1;
    throw new Error("boom");
  });
  const registry = new BackgroundTaskRegistry({
    store,
    sendNotification,
    logger: { error: () => undefined },
  });
  const started = await registry.start(makeCtx(cwd), "printf hi");
  await firstCall;
  await waitForStatus(registry, started.id);
  assert.equal(attempts, 1);
  assert.equal(calls.length, 1);
  assert.equal(registry.get(started.id).notified, false);
});

test("shutdown kills running tasks and suppresses notifications", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, calls } = makeRegistry({ stopWaitMs: 2000 });
  const started = await registry.start(makeCtx(cwd), "sleep 5");
  await registry.shutdown();
  assert.equal(registry.get(started.id).status, "killed");
  assert.equal(calls.length, 0);

  // Idempotent, and refuses new work once shut down.
  await registry.shutdown();
  await assert.rejects(() => registry.start(makeCtx(cwd), "true"), /shutting down/);
});

test("readOutput clamps maxBytes and reports a truncation notice with the full path", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry();
  const head = "H".repeat(30);
  const tailPart = "T".repeat(30);
  const content = `${head}${tailPart}`;
  const started = await registry.start(makeCtx(cwd), `printf '%s' '${content}'`);
  await waitForStatus(registry, started.id);

  const tailRead = await registry.readOutput(started.id, { maxBytes: 30, tail: true });
  assert.ok(tailRead.truncated);
  assert.match(tailRead.text, /Showing tail 30 of 60 bytes; 30 omitted/);
  assert.match(
    tailRead.text,
    new RegExp(started.outputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.match(tailRead.text, /T{30}/);

  const headRead = await registry.readOutput(started.id, { maxBytes: 30, tail: false });
  assert.ok(headRead.truncated);
  assert.match(headRead.text, /H{30}/);

  const clampedLow = await registry.readOutput(started.id, { maxBytes: -5 });
  assert.ok(clampedLow.bytesRead >= 1);

  const clampedHigh = await registry.readOutput(started.id, { maxBytes: 10_000_000 });
  assert.equal(clampedHigh.truncated, false);
  assert.match(clampedHigh.text, /Full output:/);
});

test("task ids resolve by exact match or unambiguous prefix", async (t) => {
  const cwd = await withTempCwd(t);
  const ids = ["aaa111", "aaa222", "bbb333"];
  let index = 0;
  const { registry } = makeRegistry({ makeTaskId: () => ids[index++]! });

  const first = await registry.start(makeCtx(cwd), "true");
  const second = await registry.start(makeCtx(cwd), "true");
  const third = await registry.start(makeCtx(cwd), "true");
  await Promise.all([first, second, third].map((task) => waitForStatus(registry, task.id)));

  assert.equal(registry.get("aaa111").id, "aaa111");
  assert.equal(registry.get("bbb").id, "bbb333");
  assert.throws(() => registry.get("aaa"), /ambiguous/);
  assert.throws(() => registry.get("zzz"), /No background task/);
});

test("a prepared invocation spawns argv directly and records language/stageDir/cwd", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry();
  const started = await registry.start(makeCtx(cwd), "printf hi", {
    invocation: { argv: ["printf", "hi"], cwd, language: "zsh", stageDir: "/tmp/stage-x" },
  });
  assert.equal(started.command, "printf hi");
  assert.equal(started.language, "zsh");
  assert.equal(started.stageDir, "/tmp/stage-x");
  assert.equal(started.cwd, cwd);
  const done = await waitForStatus(registry, started.id);
  assert.equal(done.status, "completed");
});

test("a prepared invocation's own cwd overrides the session cwd", async (t) => {
  const cwd = await withTempCwd(t);
  const otherCwd = await withTempCwd(t);
  const { registry } = makeRegistry();
  const started = await registry.start(makeCtx(cwd), "pwd", {
    invocation: { argv: ["pwd"], cwd: otherCwd },
  });
  await waitForStatus(registry, started.id);
  assert.equal(started.cwd, otherCwd);
  const text = await readFile(started.outputPath, "utf8");
  // `pwd` resolves symlinks (macOS: /var -> /private/var); realpath both sides.
  assert.equal(await realpath(text.trim()), await realpath(otherCwd));
});

test("awaited suppresses the completion notification; clearAwaited re-arms it", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, calls, firstCall } = makeRegistry();
  const started = await registry.start(makeCtx(cwd), "sleep 5", { awaited: true });
  assert.equal(registry.get(started.id).status, "running");

  registry.clearAwaited(started.id);
  await registry.stop(started.id);
  await firstCall;
  assert.equal(calls.length, 1);
});

test("awaited stays suppressed for the whole run when never cleared", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, calls } = makeRegistry();
  const started = await registry.start(makeCtx(cwd), "printf hi", { awaited: true });
  await waitForStatus(registry, started.id);
  assert.equal(calls.length, 0);
  assert.equal(registry.get(started.id).notified, false);
});

test("waitForTask resolves once a running task settles, and immediately for one already done", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry();
  const started = await registry.start(makeCtx(cwd), "printf hi");

  const finished = await registry.waitForTask(started.id);
  assert.equal(finished.status, "completed");

  const again = await registry.waitForTask(started.id);
  assert.equal(again.status, "completed");
});

test("ensureSessionDir creates and returns the same dir start() writes task files into", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry();
  const ctx = makeCtx(cwd);
  const dir = await registry.ensureSessionDir(ctx);
  assert.equal(dir, registry.sessionDirPath(ctx));

  const started = await registry.start(ctx, "true");
  assert.ok(started.outputPath.startsWith(dir));
  await waitForStatus(registry, started.id);
});

test("a prepared invocation's ENOENT surfaces as a normal failed task", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry();
  const started = await registry.start(makeCtx(cwd), "does-not-exist-binary", {
    invocation: { argv: ["does-not-exist-binary-xyz"], cwd },
  });
  const done = await waitForStatus(registry, started.id);
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /ENOENT/);
});

test("reset after shutdown lets a new session start tasks under its own session dir", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry } = makeRegistry({ stopWaitMs: 2000 });

  const first = await registry.start(makeCtx(cwd, "session-one"), "sleep 5");
  await registry.shutdown();
  assert.equal(registry.get(first.id).status, "killed");
  await assert.rejects(() => registry.start(makeCtx(cwd, "session-two"), "true"), /shutting down/);

  registry.reset();

  const second = await registry.start(makeCtx(cwd, "session-two"), "true");
  await waitForStatus(registry, second.id);
  assert.match(second.outputPath, new RegExp(`session-two-${process.pid}`));
  assert.doesNotMatch(second.outputPath, /session-one/);

  // History from before the reset is kept, not discarded.
  assert.equal(registry.get(first.id).id, first.id);
});
