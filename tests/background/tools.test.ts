import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/index.ts";
import { afterAll, test } from "vite-plus/test";

import { DetachRegistry } from "../../modules/background/detach.ts";
import { MonitorManager } from "../../modules/background/monitor.ts";
import {
  type BackgroundChildProcess,
  BackgroundTaskRegistry,
  type BackgroundSpawnFn,
} from "../../modules/background/registry.ts";
import { createBackgroundTools, createRunTool } from "../../modules/background/tools.ts";

async function withTempCwd(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-background-tools-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const agentDir = await mkdtemp(join(tmpdir(), "jpi-background-tools-agent-"));
const store = new Store("background", { PI_CODING_AGENT_DIR: agentDir });
afterAll(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

function makeFakeCtx(cwd: string, sessionId = "session-tools") {
  return { cwd, sessionManager: { getSessionId: () => sessionId } } as never;
}

function setUp() {
  const registry = new BackgroundTaskRegistry({
    store,
    sendNotification: () => undefined,
    killGraceMs: 300,
    stopWaitMs: 1500,
    logger: { error: () => undefined },
  });
  const monitors = new MonitorManager({
    registry,
    sendNotification: () => undefined,
    logger: { error: () => undefined },
  });
  const tools = createBackgroundTools({ registry, monitors });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { registry, monitors, tools, byName };
}

function waitForStatus(registry: BackgroundTaskRegistry, id: string, timeoutMs = 5000) {
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (registry.get(id).status !== "running") {
        cleanup();
        resolve();
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    const unsubscribe = registry.onChange(check);
    function cleanup() {
      clearTimeout(timer);
      unsubscribe();
    }
    check();
  });
}

// The tool type declares `parameters` as the generic typebox TSchema; every
// tool here actually returns a Type.Object, which carries `required` at runtime.
function requiredParams(tool: { parameters: unknown }): string[] {
  return (tool.parameters as { required?: string[] }).required ?? [];
}

test("all four bg_* tools are registered with the expected names and required parameters", () => {
  const { tools } = setUp();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["bg_kill", "bg_logs", "bg_monitor", "bg_status"].sort());

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(requiredParams(byName.get("bg_logs")!), ["taskId"]);
  assert.deepEqual(requiredParams(byName.get("bg_kill")!), ["taskId"]);
  assert.deepEqual(requiredParams(byName.get("bg_monitor")!).sort(), ["command", "description"]);
  assert.deepEqual(requiredParams(byName.get("bg_status")!), []);
});

test("bg_logs clamps maxBytes and reports a truncation notice", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, byName } = setUp();
  const bgLogs = byName.get("bg_logs")!;

  const started = await registry.start({ cwd, sessionId: "session-tools" }, "printf '0123456789'");
  await waitForStatus(registry, started.id);

  const result = await bgLogs.execute(
    "call-2",
    { taskId: started.id, maxBytes: 5, tail: false },
    undefined,
    undefined,
    makeFakeCtx(cwd),
  );
  const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
  assert.match(text, /Showing head 5 of 10 bytes/);
  assert.match(text, /Full output:/);
});

test("bg_status and bg_kill resolve an unambiguous task id prefix", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, byName } = setUp();
  const bgStatus = byName.get("bg_status")!;
  const bgKill = byName.get("bg_kill")!;

  const started = await registry.start({ cwd, sessionId: "session-tools" }, "sleep 5");
  const prefix = started.id.slice(0, 4);

  const status = await bgStatus.execute(
    "call-2",
    { taskId: prefix },
    undefined,
    undefined,
    makeFakeCtx(cwd),
  );
  assert.equal((status.details as { items: Array<{ id: string }> }).items[0]!.id, started.id);

  const killed = await bgKill.execute(
    "call-3",
    { taskId: prefix },
    undefined,
    undefined,
    makeFakeCtx(cwd),
  );
  assert.equal((killed.details as { task: { status: string } }).task.status, "killed");
});

test("bg_kill rejects a task that has already finished", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, byName } = setUp();
  const bgKill = byName.get("bg_kill")!;

  const started = await registry.start({ cwd, sessionId: "session-tools" }, "true");
  await waitForStatus(registry, started.id);

  await assert.rejects(
    () => bgKill.execute("call-2", { taskId: started.id }, undefined, undefined, makeFakeCtx(cwd)),
    /not running/,
  );
});

test("bg_status returns a monitor snapshot for a monitor-backed id", async (t) => {
  const cwd = await withTempCwd(t);
  const { registry, byName } = setUp();
  const bgMonitor = byName.get("bg_monitor")!;
  const bgStatus = byName.get("bg_status")!;

  const started = await bgMonitor.execute(
    "call-1",
    { command: "sleep 5", description: "watch" },
    undefined,
    undefined,
    makeFakeCtx(cwd),
  );
  const monitorId = (started.details as { monitor: { id: string } }).monitor.id;

  const status = await bgStatus.execute(
    "call-2",
    { taskId: monitorId },
    undefined,
    undefined,
    makeFakeCtx(cwd),
  );
  const item = (status.details as { items: Array<{ kind: string; id: string }> }).items[0]!;
  assert.equal(item.kind, "monitor");
  assert.equal(item.id, monitorId);

  await registry.stop(monitorId);
});

// ---- run tool ----

let nextFakePid = 9000;

/** A controllable stand-in child process: nothing exits until the test says so. */
class FakeChild extends EventEmitter implements BackgroundChildProcess {
  readonly pid = nextFakePid++;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  kill(): boolean {
    return true;
  }
}

function makeFakeSpawn() {
  const children: FakeChild[] = [];
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn: BackgroundSpawnFn = (command, args) => {
    calls.push({ command, args });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

/** Simulates a process-group kill actually reaching the child: records the call, then closes it. */
function makeKillProcessSpy(children: FakeChild[]) {
  const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const killProcess = (pid: number, signal: NodeJS.Signals) => {
    calls.push({ pid, signal });
    const child = children.find((c) => c.pid === Math.abs(pid));
    queueMicrotask(() => child?.emit("close", null, signal));
  };
  return { killProcess, calls };
}

function makeNotifier() {
  const calls: unknown[] = [];
  return { sendNotification: (message: unknown) => calls.push(message), calls };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await flush();
  }
}

function setUpRun(
  overrides: {
    spawn?: BackgroundSpawnFn;
    killProcess?: (pid: number, signal: NodeJS.Signals) => void;
    sendNotification?: (message: unknown, options: unknown) => void;
  } = {},
) {
  const registry = new BackgroundTaskRegistry({
    store,
    sendNotification: overrides.sendNotification ?? (() => undefined),
    killGraceMs: 50,
    stopWaitMs: 1500,
    logger: { error: () => undefined },
    ...(overrides.spawn ? { spawn: overrides.spawn } : {}),
    ...(overrides.killProcess ? { killProcess: overrides.killProcess } : {}),
  });
  const detach = new DetachRegistry();
  const runTool = createRunTool({ registry, detach, defaultTimeoutSeconds: undefined });
  return { registry, detach, runTool };
}

test("run: prepareArguments requires exactly one of script or file", () => {
  const { runTool } = setUpRun();
  assert.throws(
    () => runTool.prepareArguments!({ language: "zsh" }),
    /exactly one of script or file/,
  );
  assert.throws(
    () => runTool.prepareArguments!({ language: "zsh", script: "a", file: "b.zsh" }),
    /exactly one of script or file/,
  );
});

test("run: prepareArguments rejects dependencies for zsh", () => {
  const { runTool } = setUpRun();
  assert.throws(
    () => runTool.prepareArguments!({ language: "zsh", script: "echo hi", dependencies: ["curl"] }),
    /does not support dependencies for zsh/,
  );
});

test("run: prepareArguments requires a known language", () => {
  const { runTool } = setUpRun();
  assert.throws(
    () => runTool.prepareArguments!({ language: "ruby", script: "puts 1" }),
    /language to be/,
  );
});

test("run: prepareArguments rejects an array as arguments", () => {
  const { runTool } = setUpRun();
  assert.throws(
    () => runTool.prepareArguments!(["zsh", "echo hi"]),
    /run arguments must be an object/,
  );
});

test("run foreground: returns exit code and output tail", async (t) => {
  const cwd = await withTempCwd(t);
  const { spawn, children } = makeFakeSpawn();
  const { runTool } = setUpRun({ spawn });

  const resultPromise = runTool.execute(
    "call-1",
    { language: "zsh", script: "echo hi" },
    undefined,
    undefined,
    makeFakeCtx(cwd),
  );
  await waitUntil(() => children.length === 1);
  children[0]!.stdout.emit("data", Buffer.from("hello output"));
  children[0]!.emit("close", 0, null);

  const result = await resultPromise;
  const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
  assert.match(text, /completed/);
  assert.match(text, /hello output/);
  assert.equal((result.details as { task: { status: string } }).task.status, "completed");
});

test("run foreground: a timeout kills the process group and is reported", async (t) => {
  const cwd = await withTempCwd(t);
  const { spawn, children } = makeFakeSpawn();
  const { killProcess, calls: killCalls } = makeKillProcessSpy(children);
  const { runTool } = setUpRun({ spawn, killProcess });

  const resultPromise = runTool.execute(
    "call-1",
    { language: "zsh", script: "sleep 5", timeout: 0.05 },
    undefined,
    undefined,
    makeFakeCtx(cwd),
  );
  await waitUntil(() => children.length === 1);
  const result = await resultPromise;

  const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
  assert.match(text, /Timed out/);
  assert.equal(killCalls.length, 1);
  assert.ok(killCalls[0]!.pid < 0, "expected a negative (process-group) pid");
});

test("run foreground: the tool AbortSignal kills the process group", async (t) => {
  const cwd = await withTempCwd(t);
  const { spawn, children } = makeFakeSpawn();
  const { killProcess, calls: killCalls } = makeKillProcessSpy(children);
  const { runTool } = setUpRun({ spawn, killProcess });
  const controller = new AbortController();

  const resultPromise = runTool.execute(
    "call-1",
    { language: "zsh", script: "sleep 5" },
    controller.signal,
    undefined,
    makeFakeCtx(cwd),
  );
  await waitUntil(() => children.length === 1);
  controller.abort();

  const result = await resultPromise;
  const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
  assert.match(text, /killed/);
  assert.equal(killCalls.length, 1);
  assert.ok(killCalls[0]!.pid < 0, "expected a negative (process-group) pid");
});

test("run foreground: no completion notification is sent while awaited", async (t) => {
  const cwd = await withTempCwd(t);
  const { spawn, children } = makeFakeSpawn();
  const { sendNotification, calls: notifyCalls } = makeNotifier();
  const { runTool } = setUpRun({ spawn, sendNotification });

  const resultPromise = runTool.execute(
    "call-1",
    { language: "zsh", script: "echo hi" },
    undefined,
    undefined,
    makeFakeCtx(cwd),
  );
  await waitUntil(() => children.length === 1);
  children[0]!.emit("close", 0, null);
  await resultPromise;
  await flush();
  await flush();

  assert.equal(notifyCalls.length, 0);
});

test("run background: registers a normal task with the display command, visible immediately", async (t) => {
  const cwd = await withTempCwd(t);
  const { spawn, children } = makeFakeSpawn();
  const { registry, runTool } = setUpRun({ spawn });

  const result = await runTool.execute(
    "call-1",
    { language: "zsh", script: "sleep 5", background: true },
    undefined,
    undefined,
    makeFakeCtx(cwd),
  );
  const taskId = (result.details as { task: { id: string } }).task.id;
  assert.equal(registry.get(taskId).command, "zsh script.zsh");
  assert.equal(registry.get(taskId).status, "running");

  children[0]!.emit("close", 0, null);
  await waitUntil(() => registry.get(taskId).status !== "running");
});

test("run: ctrl+b mid-run returns the task id, leaves the child running, and re-arms the wake", async (t) => {
  const cwd = await withTempCwd(t);
  const { spawn, children } = makeFakeSpawn();
  const { sendNotification, calls: notifyCalls } = makeNotifier();
  const { registry, detach, runTool } = setUpRun({ spawn, sendNotification });
  const controller = new AbortController();

  const resultPromise = runTool.execute(
    "call-1",
    { language: "zsh", script: "sleep 5" },
    controller.signal,
    undefined,
    makeFakeCtx(cwd),
  );
  await waitUntil(() => children.length === 1 && detach.hasActive());
  const detachedCount = detach.detachAll();
  assert.equal(detachedCount, 1);

  const result = await resultPromise;
  const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
  assert.match(text, /background/);
  const taskId = (result.details as { task: { id: string; status: string } }).task.id;
  assert.equal((result.details as { task: { status: string } }).task.status, "running");
  assert.equal(detach.hasActive(), false);

  // A no-op: the wait already settled, and detach has nothing left to act on.
  assert.equal(detach.detachAll(), 0);

  // A later Esc on the caller's own signal must not kill the detached task.
  controller.abort();
  await flush();
  assert.equal(registry.get(taskId).status, "running");

  children[0]!.emit("close", 0, null);
  await waitUntil(() => notifyCalls.length > 0);
  assert.equal(notifyCalls.length, 1);
});

test("run: a detach that wins the race with the task's own settlement still returns the completed result", async (t) => {
  const cwd = await withTempCwd(t);
  const { spawn, children } = makeFakeSpawn();
  const { registry, detach, runTool } = setUpRun({ spawn });

  const resultPromise = runTool.execute(
    "call-1",
    { language: "zsh", script: "echo hi" },
    undefined,
    undefined,
    makeFakeCtx(cwd),
  );
  await waitUntil(() => children.length === 1 && detach.hasActive());

  const task = registry.list().find((t) => t.status === "running")!;
  // finalizeTask resolves the waiter, then synchronously fires onChange —
  // still before the waiter's own microtask runs. Detaching from inside
  // that onChange call wins the race against the task's own settlement,
  // the exact window the tool must not mistake for "still running".
  const unsubscribe = registry.onChange(() => {
    if (registry.get(task.id).status === "running") return;
    unsubscribe();
    detach.detachAll();
  });
  children[0]!.stdout.emit("data", Buffer.from("hello output"));
  children[0]!.emit("close", 0, null);

  const result = await resultPromise;
  const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
  assert.match(text, /completed/);
  assert.match(text, /hello output/);
  assert.doesNotMatch(text, /Moved .* to the background/);
});

test("run: an ENOENT spawn error is mapped to an install hint", async (t) => {
  const cwd = await withTempCwd(t);
  const { spawn, children } = makeFakeSpawn();
  const { runTool } = setUpRun({ spawn });

  const resultPromise = runTool.execute(
    "call-1",
    { language: "zsh", script: "echo hi" },
    undefined,
    undefined,
    makeFakeCtx(cwd),
  );
  await waitUntil(() => children.length === 1);
  children[0]!.emit("error", new Error("spawn zsh ENOENT"));

  const result = await resultPromise;
  const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
  assert.match(text, /zsh was not found on PATH/);
});
