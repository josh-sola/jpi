import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  createOrcaStatusExtension,
  encodeOrcaStatus,
  type OrcaStatusPayload,
} from "../../modules/orca-status/extension.ts";

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

function harness(env: Record<string, string | undefined> = { ORCA_PANE_KEY: "pane" }) {
  const events = new FakeEventBus();
  const scheduler = new ManualScheduler();
  const output: string[] = [];
  const notices: Array<{ message: string; level: string | undefined }> = [];
  const context = {
    mode: "tui",
    ui: { notify: (message: string, level?: string) => notices.push({ message, level }) },
  };
  const extension = createOrcaStatusExtension({
    events,
    env,
    write: (value) => output.push(value),
    now: () => 1234,
    scheduler,
  });
  const payloads = () =>
    output.map((value) => JSON.parse(value.slice("\x1b]9999;".length, -2)) as OrcaStatusPayload);
  return { events, scheduler, output, notices, context, extension, payloads };
}

test("encodes Orca status as its structured OSC sequence", () => {
  assert.equal(
    encodeOrcaStatus({ state: "working", workingMode: "monitoring" }),
    '\x1b]9999;{"state":"working","workingMode":"monitoring"}\x1b\\',
  );
});

test("does nothing outside an Orca-managed TUI", () => {
  const noTui = harness();
  noTui.context.mode = "print";
  noTui.extension.onSessionStart({}, noTui.context);
  noTui.extension.onAgentStart({}, noTui.context);
  assert.deepEqual(noTui.output, []);

  const noPane = harness({});
  noPane.extension.onSessionStart({}, noPane.context);
  noPane.extension.onAgentStart({}, noPane.context);
  assert.deepEqual(noPane.output, []);
});

test("managed Pi hooks disable JPI status and show one startup warning", () => {
  const { extension, context, output, notices } = harness({
    ORCA_PANE_KEY: "pane",
    ORCA_AGENT_HOOK_ENDPOINT: "http://hook",
  });
  extension.onSessionStart({}, context);
  assert.deepEqual(output, []);
  assert.deepEqual(notices, [
    {
      message:
        "Aggregate JPI Orca status is disabled because Orca's managed Pi hook is active; disable managed hooks to use JPI aggregate status.",
      level: "warning",
    },
  ]);
});

test("publishes a done session boundary after subscribing", () => {
  const { extension, context, payloads } = harness();
  extension.onSessionStart({}, context);
  assert.deepEqual(payloads(), [{ state: "done", sessionBoundary: true }]);
});

test("foreground stays working until agent_settled", () => {
  const { extension, context, events, payloads } = harness();
  extension.onSessionStart({}, context);
  extension.onAgentStart({}, context);
  events.emit("subagents:started", { id: "a", type: "explore", description: "Inspect" });
  events.emit("subagents:completed", { id: "a" });
  assert.equal(payloads().at(-1)?.state, "working");
  assert.equal(payloads().at(-1)?.workingMode, undefined);
  extension.onAgentSettled({}, context);
  assert.deepEqual(payloads().at(-1), { state: "done" });
});

test("UI prompts block and then restore the underlying aggregate state", () => {
  const { extension, context, events, payloads } = harness();
  extension.onSessionStart({}, context);
  events.emit("subagents:started", { id: "a" });
  extension.onUiPromptStart({}, context);
  assert.equal(payloads().at(-1)?.state, "blocked");
  extension.onUiPromptEnd({}, context);
  assert.deepEqual(payloads().at(-1), {
    state: "working",
    workingMode: "monitoring",
    subagents: [{ id: "a", state: "working", startedAt: 1234 }],
  });
});

test("reports active top-level subagent snapshots", () => {
  const { extension, context, events, payloads } = harness();
  extension.onSessionStart({}, context);
  events.emit("subagents:started", {
    id: "a",
    startedAt: 7,
    type: "general-purpose",
    description: "Review code",
  });
  assert.deepEqual(payloads().at(-1), {
    state: "working",
    workingMode: "monitoring",
    subagents: [
      {
        id: "a",
        state: "working",
        startedAt: 7,
        agentType: "general-purpose",
        description: "Review code",
      },
    ],
  });
});

test("uses jpi-background tasks as a replace-set", () => {
  const { extension, context, events, payloads, scheduler } = harness();
  extension.onSessionStart({}, context);
  events.emit("jpi-background:tasks:v1", taskSet(["one"]));
  assert.deepEqual(payloads().at(-1), { state: "working", workingMode: "monitoring" });
  events.emit("jpi-background:tasks:v1", taskSet([]));
  assert.equal(payloads().at(-1)?.state, "working");
  assert.equal(scheduler.active(250).length, 1);
});

test("holds monitoring through the final detached completion before publishing done", () => {
  const { extension, context, events, payloads, scheduler } = harness();
  extension.onSessionStart({}, context);
  events.emit("subagents:started", { id: "a" });
  const beforeCompletion = payloads().length;
  events.emit("subagents:failed", { id: "a" });
  assert.equal(payloads().length, beforeCompletion);
  const grace = scheduler.active(250)[0];
  assert.ok(grace);
  scheduler.fire(grace);
  assert.deepEqual(payloads().at(-1), { state: "done" });
});

test("a foreground turn during grace cancels delayed done", () => {
  const { extension, context, events, payloads, scheduler } = harness();
  extension.onSessionStart({}, context);
  events.emit("subagents:started", { id: "a" });
  events.emit("subagents:completed", { id: "a" });
  const grace = scheduler.active(250)[0];
  assert.ok(grace);
  extension.onAgentStart({}, context);
  assert.equal(grace.cleared, true);
  assert.deepEqual(payloads().at(-1), { state: "working" });
  scheduler.fire(grace);
  assert.deepEqual(payloads().at(-1), { state: "working" });
});

test("session shutdown removes listeners and emits no final done", () => {
  const { extension, context, events, payloads, scheduler } = harness();
  extension.onSessionStart({}, context);
  events.emit("subagents:started", { id: "a" });
  events.emit("subagents:completed", { id: "a" });
  const grace = scheduler.active(250)[0];
  assert.ok(grace);
  const beforeShutdown = payloads().length;
  extension.onSessionShutdown({}, context);
  assert.equal(grace.cleared, true);
  assert.equal(events.unsubscribed, 4);
  scheduler.fire(grace);
  assert.equal(payloads().length, beforeShutdown);
});

test("suppresses exact duplicate payloads", () => {
  const { extension, context, events, payloads } = harness();
  extension.onSessionStart({}, context);
  extension.onAgentStart({}, context);
  extension.onAgentStart({}, context);
  events.emit("jpi-background:tasks:v1", taskSet(["one"]));
  events.emit("jpi-background:tasks:v1", taskSet(["one", "two"]));
  assert.deepEqual(payloads(), [{ state: "done", sessionBoundary: true }, { state: "working" }]);
});
