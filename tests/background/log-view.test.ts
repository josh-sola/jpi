import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/index.ts";
import { afterAll, test } from "vite-plus/test";

import {
  createBgCommand,
  formatDuration,
  formatPickerRow,
  MAX_BUFFER_LINES,
  OutputBuffer,
  statusGlyph,
} from "../../modules/background/log-view.ts";
import { MonitorManager } from "../../modules/background/monitor.ts";
import { BackgroundTaskRegistry, type BgTaskSnapshot } from "../../modules/background/registry.ts";

const agentDir = await mkdtemp(join(tmpdir(), "jpi-background-log-view-agent-"));
const store = new Store("background", { PI_CODING_AGENT_DIR: agentDir });
afterAll(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

async function withTempCwd(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-background-log-view-"));
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

// -- formatDuration --------------------------------------------------------

test("formatDuration: seconds only under a minute", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "1s");
  assert.equal(formatDuration(45_000), "45s");
});

test("formatDuration: minutes and seconds, zero-padded", () => {
  assert.equal(formatDuration(65_000), "1m05s");
  assert.equal(formatDuration(9 * 60_000 + 3_000), "9m03s");
});

test("formatDuration: hours and minutes", () => {
  assert.equal(formatDuration(3661_000), "1h01m");
});

test("formatDuration: clamps negative input to zero", () => {
  assert.equal(formatDuration(-500), "0s");
});

// -- statusGlyph -------------------------------------------------------------

test("statusGlyph: covers task and monitor statuses", () => {
  assert.equal(statusGlyph("running"), "●");
  assert.equal(statusGlyph("completed"), "✓");
  assert.equal(statusGlyph("exited"), "✓");
  assert.equal(statusGlyph("failed"), "✗");
  assert.equal(statusGlyph("killed"), "⏹");
  assert.equal(statusGlyph("cancelled"), "⏹");
  assert.equal(statusGlyph("timeout"), "⏱");
});

// -- formatPickerRow ---------------------------------------------------------

function makeTaskSnapshot(overrides: Partial<BgTaskSnapshot> = {}): BgTaskSnapshot {
  return {
    kind: "task",
    id: "b1a2c3d4",
    name: "npm test",
    command: "npm test",
    cwd: "/tmp",
    status: "running",
    outputPath: "/tmp/out",
    startTime: 0,
    endTime: undefined,
    exitCode: undefined,
    signal: undefined,
    pid: 123,
    bytesWritten: 0,
    error: undefined,
    notified: false,
    wakeOnCompletion: true,
    timeoutSeconds: undefined,
    killKind: undefined,
    ...overrides,
  };
}

test("formatPickerRow: task row has no monitor tag, shows glyph/name/runtime/id", () => {
  const row = formatPickerRow(makeTaskSnapshot({ endTime: 12_000, status: "completed" }), 12_000);
  assert.equal(row, "✓ npm test  ·  12s  ·  b1a2c3d4");
});

test("formatPickerRow: monitor row is tagged", () => {
  const row = formatPickerRow(
    {
      kind: "monitor",
      id: "c5d6e7f8",
      description: "watch for errors",
      command: "tail -f app.log",
      status: "running",
      outputPath: "/tmp/out2",
      startTime: 0,
      endTime: undefined,
      exitCode: undefined,
      persistent: false,
      eventCount: 3,
      error: undefined,
    },
    5_000,
  );
  assert.equal(row, "● [monitor] watch for errors  ·  5s  ·  c5d6e7f8");
});

test("formatPickerRow: truncates a long name with an ellipsis", () => {
  const longName = "x".repeat(80);
  const row = formatPickerRow(makeTaskSnapshot({ name: longName }), 0);
  assert.ok(row.includes("…"));
  assert.ok(!row.includes(longName));
});

// -- OutputBuffer --------------------------------------------------------

test("OutputBuffer: seed lines are tagged 'seed' and split on newlines", () => {
  const buffer = new OutputBuffer();
  buffer.seed("first\nsecond\n");
  const lines = buffer.getLines();
  assert.deepEqual(
    lines.map((l) => l.text),
    ["first", "second"],
  );
  assert.ok(lines.every((l) => l.source === "seed"));
});

test("OutputBuffer: seed without a trailing newline leaves a pending line", () => {
  const buffer = new OutputBuffer();
  buffer.seed("first\npartial");
  const lines = buffer.getLines();
  assert.deepEqual(
    lines.map((l) => l.text),
    ["first", "partial"],
  );
});

test("OutputBuffer: append tags lines by stream and completes a pending seed line", () => {
  const buffer = new OutputBuffer();
  buffer.seed("prefix-");
  buffer.append("suffix\nerror line\n", "stderr");
  const lines = buffer.getLines();
  assert.deepEqual(
    lines.map((l) => [l.text, l.source]),
    [
      ["prefix-suffix", "stderr"],
      ["error line", "stderr"],
    ],
  );
});

test("OutputBuffer: append splits a chunk spanning multiple lines and keeps the tail pending", () => {
  const buffer = new OutputBuffer();
  buffer.append("a\nb\nc\nd", "stdout");
  const lines = buffer.getLines();
  assert.deepEqual(
    lines.map((l) => l.text),
    ["a", "b", "c", "d"],
  );
  assert.ok(lines.every((l) => l.source === "stdout"));
});

test("OutputBuffer: chunks with no newline accumulate into one pending line", () => {
  const buffer = new OutputBuffer();
  buffer.append("ab", "stdout");
  buffer.append("cd", "stdout");
  assert.deepEqual(buffer.getLines(), [{ text: "abcd", source: "stdout" }]);
});

test("OutputBuffer: an empty buffer reports no lines", () => {
  assert.deepEqual(new OutputBuffer().getLines(), []);
});

test("OutputBuffer: trims old lines once the buffer grows well past MAX_BUFFER_LINES, keeping the most recent", () => {
  const buffer = new OutputBuffer();
  // Trimming batches (a fixed margin past the cap) rather than shifting on
  // every push, so the size bound is generous rather than exact.
  const total = MAX_BUFFER_LINES * 2;
  for (let i = 0; i < total; i++) buffer.append(`line-${i}\n`, "stdout");
  const lines = buffer.getLines();
  assert.ok(lines.length < total);
  assert.ok(lines.length <= MAX_BUFFER_LINES * 1.3);
  assert.equal(lines[lines.length - 1]?.text, `line-${total - 1}`);
  assert.ok(!lines.some((l) => l.text === "line-0"));
});

// -- createBgCommand ----------------------------------------------------------

function makeDeps() {
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
  return { registry, monitors };
}

function makeUiCtx(overrides: Partial<{ hasUI: boolean; mode: string }> = {}) {
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const customCalls: Array<{ options: unknown }> = [];
  const ctx = {
    hasUI: overrides.hasUI ?? true,
    mode: overrides.mode ?? "tui",
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
      select: async (_title: string, options: string[]) => options[0],
      custom: async (_factory: unknown, options: unknown) => {
        customCalls.push({ options });
        return undefined;
      },
    },
  };
  return { ctx, notifications, customCalls };
}

test("createBgCommand: notifies when there are no background tasks or monitors", async () => {
  const deps = makeDeps();
  const command = createBgCommand(deps);
  const { ctx, notifications, customCalls } = makeUiCtx();

  await command.handler("", ctx as never);

  assert.deepEqual(notifications, [{ message: "No background tasks", type: "info" }]);
  assert.equal(customCalls.length, 0);
});

test("createBgCommand: guards on missing UI and non-tui mode without touching the registry", async () => {
  const deps = makeDeps();
  const command = createBgCommand(deps);

  const noUi = makeUiCtx({ hasUI: false });
  await command.handler("", noUi.ctx as never);
  assert.equal(noUi.notifications.length, 1);
  assert.equal(noUi.customCalls.length, 0);

  const nonTui = makeUiCtx({ mode: "print" });
  await command.handler("", nonTui.ctx as never);
  assert.equal(nonTui.notifications.length, 1);
  assert.equal(nonTui.customCalls.length, 0);
});

test("createBgCommand: notifies an error for an unknown id prefix", async () => {
  const deps = makeDeps();
  const command = createBgCommand(deps);
  const { ctx, notifications, customCalls } = makeUiCtx();

  await command.handler("nosuchtask", ctx as never);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.type, "error");
  assert.equal(customCalls.length, 0);
});

test("createBgCommand: an unambiguous id prefix opens the view directly, skipping the picker", async (t) => {
  const deps = makeDeps();
  const command = createBgCommand(deps);
  const cwd = await withTempCwd(t);
  const task = await deps.registry.start({ cwd, sessionId: "s1" }, "exit 0");
  await waitForStatus(deps.registry, task.id);
  const { ctx, customCalls } = makeUiCtx();

  await command.handler(task.id.slice(0, 4), ctx as never);

  assert.equal(customCalls.length, 1);
});
