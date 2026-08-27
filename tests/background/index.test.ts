import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Config, injectEnabled, projectSlug } from "../../src/core/index.ts";
import { backgroundSchema } from "../../modules/background/config.ts";
import { registerBackground } from "../../modules/background/index.ts";
import { MonitorManager } from "../../modules/background/monitor.ts";
import { BackgroundTaskRegistry, type BgTaskSnapshot } from "../../modules/background/registry.ts";

/** Tests bypass the module loader, so they build the same injected-schema config it would. */
function makeConfig(env: NodeJS.ProcessEnv) {
  return new Config("background", injectEnabled("background", backgroundSchema), env);
}

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function createTestEventBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      const set = listeners.get(channel);
      if (!set) return;
      for (const listener of [...set]) listener(data);
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
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const registeredTools: Array<{ name: string }> = [];
  const registeredCommands: Array<{ name: string }> = [];
  let resolveFirstMessage: (() => void) | undefined;
  const firstMessage = new Promise<void>((resolve) => {
    resolveFirstMessage = resolve;
  });
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
      resolveFirstMessage?.();
    },
    events: createTestEventBus(),
    registerTool(tool: { name: string }) {
      registeredTools.push(tool);
    },
    registerCommand(name: string) {
      registeredCommands.push({ name });
    },
  };
  // Exercises only the slice of ExtensionAPI that registerBackground calls.
  return {
    pi: pi as unknown as ExtensionAPI,
    handlers,
    sentMessages,
    firstMessage,
    registeredTools,
    registeredCommands,
  };
}

function makeFakeUiCtx(cwd: string, sessionId: string) {
  const statuses = new Map<string, string | undefined>();
  const terminalInputHandlers = new Set<(data: string) => { consume?: boolean } | undefined>();
  return {
    cwd,
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      setStatus(key: string, value: string | undefined) {
        statuses.set(key, value);
      },
      onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
        terminalInputHandlers.add(handler);
        return () => terminalInputHandlers.delete(handler);
      },
    },
    statuses,
    terminalInputHandlers,
  };
}

async function withTempEnv(t: { onTestFinished: (fn: () => Promise<void> | void) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "jpi-background-config-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, env: { PI_CODING_AGENT_DIR: dir } };
}

async function withTempCwd(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-background-cwd-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
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

test("session_start loads the background config into the registry", async (t) => {
  const { dir, env } = await withTempEnv(t);
  await writeFile(join(dir, "jpi.kdl"), "background {\n  max-output-bytes 50\n}\n", "utf8");
  const { pi, handlers } = makeFakePi();

  const { registry } = registerBackground(pi, makeConfig(env), { env });
  const cwd = await withTempCwd(t);
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    makeFakeUiCtx(cwd, "s1"),
  );

  const started = await registry.start(
    { cwd, sessionId: "s1" },
    "i=0; while [ $i -lt 50 ]; do printf '0123456789'; i=$((i+1)); done",
  );
  const done = await waitForStatus(registry, started.id);
  assert.equal(done.status, "failed");
  assert.match(done.error ?? "", /cap/);
});

test("session_start sweeps stale session dirs older than ttl-days, keeping the current session", async (t) => {
  const { dir, env } = await withTempEnv(t);
  await writeFile(join(dir, "jpi.kdl"), "background {\n  ttl-days 1\n}\n", "utf8");
  const { pi, handlers } = makeFakePi();
  const { registry } = registerBackground(pi, makeConfig(env), { env });
  const cwd = await withTempCwd(t);

  // A pid that has already exited is guaranteed dead.
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid!;
  const slugDir = join(dir, "jpi", "background", projectSlug(cwd));
  const staleDir = join(slugDir, `old-session-${deadPid}`);
  await mkdir(staleDir, { recursive: true });
  const staleSeconds = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  await utimes(staleDir, staleSeconds, staleSeconds);

  await handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    makeFakeUiCtx(cwd, "s1"),
  );

  await assert.rejects(stat(staleDir));

  // The current session's own dir survives even once it exists and ages.
  const currentDir = registry.sessionDirPath({ cwd, sessionId: "s1" });
  await mkdir(currentDir, { recursive: true });
  await utimes(currentDir, staleSeconds, staleSeconds);
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    makeFakeUiCtx(cwd, "s1"),
  );
  assert.ok((await stat(currentDir)).isDirectory());
});

test("session_shutdown kills running tasks and running monitors", async (t) => {
  const { env } = await withTempEnv(t);
  const { pi, handlers } = makeFakePi();
  const { registry, monitors } = registerBackground(pi, makeConfig(env), { env });
  const cwd = await withTempCwd(t);
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    makeFakeUiCtx(cwd, "s1"),
  );

  const task = await registry.start({ cwd, sessionId: "s1" }, "sleep 5");
  const monitor = await monitors.start({ cwd, sessionId: "s1" }, "sleep 5", "watch");
  await handlers.get("session_shutdown")?.(
    { type: "session_shutdown", reason: "quit" },
    makeFakeUiCtx(cwd, "s1"),
  );

  assert.equal(registry.get(task.id).status, "killed");
  assert.equal(monitors.get(monitor.id)?.status, "cancelled");
});

test("a session switch resets the registry so the next session can start tasks", async (t) => {
  const { env } = await withTempEnv(t);
  const { pi, handlers } = makeFakePi();
  const { registry } = registerBackground(pi, makeConfig(env), { env });
  const cwd = await withTempCwd(t);

  await handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    makeFakeUiCtx(cwd, "session-one"),
  );
  const task = await registry.start({ cwd, sessionId: "session-one" }, "sleep 5");
  await handlers.get("session_shutdown")?.(
    { type: "session_shutdown", reason: "reload" },
    makeFakeUiCtx(cwd, "session-one"),
  );
  assert.equal(registry.get(task.id).status, "killed");

  await handlers.get("session_start")?.(
    { type: "session_start", reason: "reload" },
    makeFakeUiCtx(cwd, "session-two"),
  );
  const second = await registry.start({ cwd, sessionId: "session-two" }, "true");
  assert.match(second.outputPath, new RegExp(`session-two-${process.pid}`));
  await waitForStatus(registry, second.id);
});

test("the default wake sender forwards to pi.sendMessage", async (t) => {
  const { env } = await withTempEnv(t);
  const { pi, sentMessages, firstMessage } = makeFakePi();
  const { registry } = registerBackground(pi, makeConfig(env), { env });

  const cwd = await withTempCwd(t);
  const started = await registry.start({ cwd, sessionId: "s1" }, "printf hi");
  await firstMessage;
  await waitForStatus(registry, started.id);

  assert.equal(sentMessages.length, 1);
  const [sent] = sentMessages;
  assert.equal((sent!.message as { customType: string }).customType, "jpi-background-notification");
  assert.deepEqual(sent!.options, { deliverAs: "followUp", triggerTurn: true });
});

test("the four bg_* tools are registered synchronously, before any session starts", async (t) => {
  const { env } = await withTempEnv(t);
  const { pi, registeredTools } = makeFakePi();
  registerBackground(pi, makeConfig(env), { env });
  assert.deepEqual(
    registeredTools.map((tool) => tool.name).sort(),
    ["bg_kill", "bg_logs", "bg_monitor", "bg_status"].sort(),
  );
});

test("session_start registers the run tool when runEnabled (the default)", async (t) => {
  const { env } = await withTempEnv(t);
  const { pi, handlers, registeredTools } = makeFakePi();
  registerBackground(pi, makeConfig(env), { env });
  const cwd = await withTempCwd(t);
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    makeFakeUiCtx(cwd, "s1"),
  );
  assert.ok(registeredTools.some((tool) => tool.name === "run"));
});

test("session_start skips the run tool when runEnabled is false", async (t) => {
  const { dir, env } = await withTempEnv(t);
  await writeFile(join(dir, "jpi.kdl"), "background {\n  run-enabled #false\n}\n", "utf8");
  const { pi, handlers, registeredTools } = makeFakePi();
  registerBackground(pi, makeConfig(env), { env });
  const cwd = await withTempCwd(t);
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    makeFakeUiCtx(cwd, "s1"),
  );
  assert.ok(!registeredTools.some((tool) => tool.name === "run"));
});

test("ctrl+b falls through when no foreground run is awaiting", async (t) => {
  const { env } = await withTempEnv(t);
  const { pi, handlers } = makeFakePi();
  registerBackground(pi, makeConfig(env), { env });
  const cwd = await withTempCwd(t);
  const uiCtx = makeFakeUiCtx(cwd, "s1");
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, uiCtx);

  const results = [...uiCtx.terminalInputHandlers].map((handler) => handler(""));
  assert.deepEqual(results, [undefined]);
});

test("registerBackground returns a MonitorManager alongside the registry", async (t) => {
  const { env } = await withTempEnv(t);
  const { pi } = makeFakePi();
  const { monitors } = registerBackground(pi, makeConfig(env), { env });
  assert.ok(monitors instanceof MonitorManager);
});
