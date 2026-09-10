import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { createHerdrStatusExtension } from "../../modules/herdr-status/extension.ts";

class FakeEventBus {
  handlers = new Map<string, Set<(data: unknown) => void>>();

  on(channel: string, handler: (data: unknown) => void) {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
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

const ENV = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "w1:p1" };

/** Two microtask ticks let one awaited send inside the sender settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function withoutSeq(params: Record<string, unknown>) {
  const { seq: _seq, ...rest } = params;
  return rest;
}

function harness(
  overrides: {
    env?: Record<string, string | undefined>;
    fileExists?: (path: string) => boolean;
    labels?: ReadonlyMap<string, string>;
  } = {},
) {
  const events = new FakeEventBus();
  const scheduler = new ManualScheduler();
  const requests: Array<{ id: string; method: string; params: Record<string, unknown> }> = [];
  const notices: Array<{ message: string; level?: string }> = [];
  const send = async (request: unknown) => {
    requests.push(request as (typeof requests)[number]);
    return true;
  };
  const sessionManager = {
    getSessionFile: (): string | undefined => "/abs/session.json",
    getSessionId: (): string | undefined => "sess-1",
  };
  const context = {
    mode: "tui",
    model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" } as
      | { provider: string; id: string; name: string }
      | undefined,
    ui: {
      notify: (message: string, level?: string) =>
        notices.push(level === undefined ? { message } : { message, level }),
    },
    sessionManager,
  };
  const extension = createHerdrStatusExtension({
    events,
    env: overrides.env ?? ENV,
    send,
    now: () => 1234,
    scheduler,
    fileExists: overrides.fileExists ?? (() => false),
    agentDirectory: "/agent-dir",
    labels: overrides.labels ?? new Map([["openai-codex/gpt-5.6-sol", "codex sol"]]),
  });
  const stateRequests = () => requests.filter((r) => r.method === "pane.report_agent");
  const sessionRequests = () => requests.filter((r) => r.method === "pane.report_agent_session");
  const metadataRequests = () => requests.filter((r) => r.method === "pane.report_metadata");
  return {
    events,
    scheduler,
    requests,
    notices,
    extension,
    context,
    sessionManager,
    stateRequests,
    sessionRequests,
    metadataRequests,
  };
}

test("inactive outside TUI or without every herdr env var", async () => {
  const notTui = harness();
  notTui.context.mode = "print";
  notTui.extension.onSessionStart({ reason: "startup" }, notTui.context);
  notTui.extension.onAgentStart({}, notTui.context);
  await flush();
  assert.deepEqual(notTui.requests, []);

  const missingPane = harness({ env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/x.sock" } });
  missingPane.extension.onSessionStart({ reason: "startup" }, missingPane.context);
  await flush();
  assert.deepEqual(missingPane.requests, []);

  const wrongEnvValue = harness({ env: { ...ENV, HERDR_ENV: "true" } });
  wrongEnvValue.extension.onSessionStart({ reason: "startup" }, wrongEnvValue.context);
  await flush();
  assert.deepEqual(wrongEnvValue.requests, []);
});

test("warns and sends nothing when herdr's own Pi integration is installed", async () => {
  const h = harness({
    fileExists: (path) => path === "/agent-dir/extensions/herdr-agent-state.ts",
  });
  h.extension.onSessionStart({ reason: "startup" }, h.context);
  h.extension.onAgentStart({}, h.context);
  await flush();
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.notices, [
    {
      message:
        "JPI herdr status is disabled because herdr's own Pi integration is installed; run `herdr integration uninstall pi` to use JPI aggregate status.",
      level: "warning",
    },
  ]);
});

test("session report on start prefers the session file path over the session id", async () => {
  const h = harness();
  h.extension.onSessionStart({ reason: "resume" }, h.context);
  await flush();
  const report = h.sessionRequests().at(-1)!;
  assert.deepEqual(withoutSeq(report.params), {
    pane_id: "w1:p1",
    source: "herdr:pi",
    agent: "pi",
    session_start_source: "resume",
    agent_session_path: "/abs/session.json",
  });
});

test("agent_start refreshes and re-sends the session ref without a session_start_source", async () => {
  const h = harness();
  h.extension.onSessionStart({ reason: "startup" }, h.context);
  await flush();
  h.extension.onAgentStart({}, h.context);
  await flush();
  const report = h.sessionRequests().at(-1)!;
  assert.deepEqual(withoutSeq(report.params), {
    pane_id: "w1:p1",
    source: "herdr:pi",
    agent: "pi",
    agent_session_path: "/abs/session.json",
  });
});

test("falls back to the session id when no session file path is available", async () => {
  const h = harness();
  h.sessionManager.getSessionFile = () => undefined;
  h.extension.onSessionStart({ reason: "new" }, h.context);
  await flush();
  const report = h.sessionRequests().at(-1)!;
  assert.deepEqual(withoutSeq(report.params), {
    pane_id: "w1:p1",
    source: "herdr:pi",
    agent: "pi",
    session_start_source: "new",
    agent_session_id: "sess-1",
  });
});

test("maps activity state to herdr's working, blocked, and idle", async () => {
  const h = harness();
  h.extension.onSessionStart({ reason: "startup" }, h.context);
  await flush();
  assert.equal(h.stateRequests().at(-1)?.params.state, "idle");

  h.extension.onAgentStart({}, h.context);
  await flush();
  assert.equal(h.stateRequests().at(-1)?.params.state, "working");

  h.extension.onUiPromptStart({}, h.context);
  await flush();
  assert.equal(h.stateRequests().at(-1)?.params.state, "blocked");

  h.extension.onUiPromptEnd({}, h.context);
  await flush();
  assert.equal(h.stateRequests().at(-1)?.params.state, "working");

  h.extension.onAgentSettled({}, h.context);
  await flush();
  assert.equal(h.stateRequests().at(-1)?.params.state, "idle");
});

test("detached work holds working through the grace period, then reports idle", async () => {
  const h = harness();
  h.extension.onSessionStart({ reason: "startup" }, h.context);
  await flush();
  h.events.emit("subagents:started", { id: "a" });
  await flush();
  assert.equal(h.stateRequests().at(-1)?.params.state, "working");

  h.events.emit("subagents:completed", { id: "a" });
  await flush();
  assert.equal(h.stateRequests().at(-1)?.params.state, "working");
  const grace = h.scheduler.active(250)[0];
  assert.ok(grace);

  h.scheduler.fire(grace);
  await flush();
  assert.equal(h.stateRequests().at(-1)?.params.state, "idle");
});

test("seq strictly increases across requests", async () => {
  const h = harness();
  h.extension.onSessionStart({ reason: "startup" }, h.context);
  await flush();
  h.extension.onAgentStart({}, h.context);
  await flush();
  h.extension.onAgentSettled({}, h.context);
  await flush();

  const seqs = h.requests.map((request) => request.params.seq as number);
  assert.ok(seqs.length > 1);
  for (let index = 1; index < seqs.length; index += 1) {
    assert.ok(
      seqs[index]! > seqs[index - 1]!,
      `seq ${seqs[index]} did not increase past ${seqs[index - 1]}`,
    );
  }
});

type ControllableCall = {
  request: { method: string; params: Record<string, unknown> };
  resolve: (v: boolean) => void;
};

/** A `send` whose promises stay pending until the test resolves them, to inspect what's queued mid-flight. */
function controllableSend() {
  const calls: ControllableCall[] = [];
  const send = (request: unknown) =>
    new Promise<boolean>((resolve) => {
      calls.push({ request: request as ControllableCall["request"], resolve });
    });
  return {
    send,
    calls,
    byMethod: (method: string) => calls.filter((c) => c.request.method === method),
  };
}

test("the session report is sent before the first state report", async () => {
  const events = new FakeEventBus();
  const scheduler = new ManualScheduler();
  const { send, calls } = controllableSend();
  const extension = createHerdrStatusExtension({
    events,
    env: ENV,
    send,
    now: () => 1234,
    scheduler,
    fileExists: () => false,
  });
  const context = {
    mode: "tui",
    model: undefined,
    ui: { notify: () => {} },
    sessionManager: { getSessionFile: () => "/abs/session.json", getSessionId: () => undefined },
  };

  extension.onSessionStart({ reason: "startup" }, context);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.request.method, "pane.report_agent_session");

  calls[0]!.resolve(true);
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.request.method, "pane.report_agent");
  assert.ok((calls[1]!.request.params.seq as number) > (calls[0]!.request.params.seq as number));
});

test("a latest-wins queue coalesces state changes while a send is in flight", async () => {
  const events = new FakeEventBus();
  const scheduler = new ManualScheduler();
  const { send, calls, byMethod } = controllableSend();
  const extension = createHerdrStatusExtension({
    events,
    env: ENV,
    send,
    now: () => 1234,
    scheduler,
    fileExists: () => false,
  });
  const context = {
    mode: "tui",
    model: undefined,
    ui: { notify: () => {} },
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => undefined },
  };

  extension.onSessionStart({ reason: "startup" }, context);
  await flush();
  // No session ref, so only the initial idle state and the label clear are queued.
  assert.equal(byMethod("pane.report_agent").length, 1);
  assert.equal(byMethod("pane.report_agent")[0]!.request.params.state, "idle");

  events.emit("subagents:started", { id: "a" });
  extension.onUiPromptStart({}, context);
  await flush();
  assert.equal(
    byMethod("pane.report_agent").length,
    1,
    "no new send starts while one is in flight",
  );

  calls[0]!.resolve(true);
  await flush();
  // The session-start label clear is FIFO-ahead of the coalesced state change.
  const metadataCall = byMethod("pane.report_metadata")[0]!;
  metadataCall.resolve(true);
  await flush();

  assert.equal(
    byMethod("pane.report_agent").length,
    2,
    "only the coalesced latest value is sent, not the dropped intermediate one",
  );
  assert.equal(byMethod("pane.report_agent")[1]!.request.params.state, "blocked");
});

test("model_select re-sends the sidebar label for the new model", async () => {
  const h = harness();
  h.extension.onSessionStart({ reason: "startup" }, h.context);
  await flush();
  const before = h.metadataRequests().length;

  h.extension.onModelSelect(
    { model: { provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra" } },
    h.context,
  );
  await flush();
  assert.equal(h.metadataRequests().length, before + 1);
  assert.equal(h.metadataRequests().at(-1)?.params.display_agent, "gpt-6 astra");
});

test("label uses the configured entry over the model name when one matches", async () => {
  const h = harness();
  h.extension.onSessionStart({ reason: "startup" }, h.context);
  await flush();
  assert.equal(h.metadataRequests().at(-1)?.params.display_agent, "codex sol");
});

test("label falls back to the lowercased model name, stripping one leading vendor prefix", async () => {
  const h = harness();
  h.context.model = {
    provider: "openrouter",
    id: "~moonshotai/kimi-latest",
    name: "MoonshotAI: Kimi K3",
  };
  h.extension.onSessionStart({ reason: "startup" }, h.context);
  await flush();
  assert.equal(h.metadataRequests().at(-1)?.params.display_agent, "kimi k3");
});

test("label falls back to the whole lowercased name when the prefix strip leaves nothing", async () => {
  const h = harness();
  h.context.model = { provider: "openrouter", id: "~vendor/only", name: "Vendor:" };
  h.extension.onSessionStart({ reason: "startup" }, h.context);
  await flush();
  assert.equal(h.metadataRequests().at(-1)?.params.display_agent, "vendor:");
});

test("no model sends clear_display_agent instead of a label", async () => {
  const h = harness();
  h.context.model = undefined;
  h.extension.onSessionStart({ reason: "startup" }, h.context);
  await flush();
  const report = h.metadataRequests().at(-1)!;
  assert.equal(report.params.clear_display_agent, true);
  assert.equal("display_agent" in report.params, false);
});

test("shutdown clears the sidebar label and sends no further state", async () => {
  const h = harness();
  h.extension.onSessionStart({ reason: "startup" }, h.context);
  await flush();

  h.extension.onSessionShutdown({}, h.context);
  await flush();
  const report = h.metadataRequests().at(-1)!;
  assert.equal(report.params.clear_display_agent, true);

  const stateCountAfterShutdown = h.stateRequests().length;
  h.events.emit("subagents:started", { id: "a" });
  await flush();
  assert.equal(h.stateRequests().length, stateCountAfterShutdown);
});
