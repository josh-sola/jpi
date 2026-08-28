import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { test, type TestContext } from "vite-plus/test";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Config, injectEnabled, type ModuleContext } from "../../src/core/index.ts";
import { btwSchema } from "../../modules/btw/config.ts";
import { registerBtw } from "../../modules/btw/index.ts";
import { flush, mockPi, mockSessionCtx } from "../tasks/helpers/mock-pi.ts";

type CompleteFn = (
  model: unknown,
  context: { messages: { content: unknown }[] },
  options: { signal: AbortSignal },
) => Promise<AssistantMessage>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
  } as unknown as AssistantMessage;
}

async function withTempEnv(t: TestContext): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "btw-command-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { PI_CODING_AGENT_DIR: dir };
}

function fakeTheme() {
  return { fg: (_color: string, text: string) => text, bold: (text: string) => text };
}

/** Captures the panel the command wiring opens, so tests can read its rendered state without a real TUI. */
function fakeCustom() {
  let overlay: { render(width: number): string[] } | undefined;
  return {
    custom: (factory: (...args: unknown[]) => { render(width: number): string[] }) =>
      new Promise((resolve) => {
        const tui = { requestRender: () => {}, terminal: { rows: 40 } };
        overlay = factory(tui, fakeTheme(), new KeybindingsManager(TUI_KEYBINDINGS), resolve);
      }),
    getOverlay: () => overlay,
  };
}

function renderedText(overlay: { render(width: number): string[] } | undefined): string {
  return overlay ? overlay.render(80).join("\n") : "";
}

function setup(env: NodeJS.ProcessEnv, complete: CompleteFn) {
  const mock = mockPi();
  const custom = fakeCustom();
  const registry = { complete };
  const ctx = {
    ...mockSessionCtx("s1", { modelRegistry: registry }),
    hasUI: true,
    getSystemPrompt: () => "system prompt",
    sessionManager: {
      getSessionId: () => "s1",
      buildContextEntries: () => [],
    },
    ui: { ...mockSessionCtx("s1").ui, custom: custom.custom },
  };

  const moduleCtx = {
    config: new Config("btw", injectEnabled("btw", btwSchema), env),
  } as unknown as ModuleContext<typeof btwSchema>;

  registerBtw(mock.pi as unknown as ExtensionAPI, moduleCtx);

  return { mock, ctx, getOverlay: custom.getOverlay };
}

test("bare /btw with no prior exchange notifies usage instead of opening a panel", async (t) => {
  const env = await withTempEnv(t);
  const { mock, ctx, getOverlay } = setup(env, async () => assistantMessage("unused"));

  await mock.runCommand("btw", "", ctx);

  assert.equal(getOverlay(), undefined);
  assert.equal(ctx.ui.notify.mock.calls.length, 1);
  assert.match(ctx.ui.notify.mock.calls[0]![0] as string, /usage/i);
});

test("bare /btw with a prior exchange reopens it without asking again", async (t) => {
  const env = await withTempEnv(t);
  let completeCalls = 0;
  const { mock, ctx, getOverlay } = setup(env, async () => {
    completeCalls++;
    return assistantMessage("first answer");
  });

  await mock.runCommand("btw", "first question", ctx);
  await flush();
  assert.equal(completeCalls, 1);

  await mock.runCommand("btw", "", ctx);

  assert.equal(completeCalls, 1, "bare /btw must not fire a new ask");
  const text = renderedText(getOverlay());
  assert.ok(text.includes("first answer"));
  assert.ok(text.includes("first question"));
});

test("/btw during compaction shows a busy message instead of asking", async (t) => {
  const env = await withTempEnv(t);
  let completeCalls = 0;
  const { mock, ctx, getOverlay } = setup(env, async () => {
    completeCalls++;
    return assistantMessage("answer");
  });

  await mock.fireLifecycle("session_before_compact", {}, ctx);
  await mock.runCommand("btw", "question", ctx);

  assert.equal(completeCalls, 0);
  assert.ok(renderedText(getOverlay()).includes("busy compacting"));

  await mock.fireLifecycle("session_compact", {}, ctx);
  await mock.runCommand("btw", "question", ctx);
  await flush();

  assert.equal(completeCalls, 1, "compaction ending must clear the guard");
});

test("the handler returns without waiting for the model call to resolve", async (t) => {
  const env = await withTempEnv(t);
  const gate = deferred<AssistantMessage>();
  let completeStarted = false;
  const { mock, ctx } = setup(env, async () => {
    completeStarted = true;
    return gate.promise;
  });

  await mock.runCommand("btw", "question", ctx);

  assert.equal(completeStarted, true, "expected the ask to have started");

  gate.resolve(assistantMessage("answer"));
  await flush();
});

test("a second /btw aborts the first ask; its late result is dropped", async (t) => {
  const env = await withTempEnv(t);
  const first = deferred<AssistantMessage>();
  let firstSignal: AbortSignal | undefined;
  let call = 0;
  const { mock, ctx, getOverlay } = setup(env, async (_model, _context, options) => {
    call++;
    if (call === 1) {
      firstSignal = options.signal;
      return first.promise;
    }
    return assistantMessage("answer to the second question");
  });

  await mock.runCommand("btw", "first question", ctx);
  await mock.runCommand("btw", "second question", ctx);
  await flush();

  assert.equal(firstSignal?.aborted, true, "the first ask should be aborted by the second");
  assert.ok(renderedText(getOverlay()).includes("answer to the second question"));

  first.resolve(assistantMessage("late answer to the first question"));
  await flush();

  assert.ok(
    !renderedText(getOverlay()).includes("late answer"),
    "a stale result must not overwrite the newer exchange",
  );
});

test("session_start aborts an in-flight ask and clears the ring", async (t) => {
  const env = await withTempEnv(t);
  const gate = deferred<AssistantMessage>();
  let signal: AbortSignal | undefined;
  const { mock, ctx } = setup(env, async (_model, _context, options) => {
    signal = options.signal;
    return gate.promise;
  });

  await mock.runCommand("btw", "first question", ctx);
  assert.equal(signal?.aborted, false);

  await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
  assert.equal(signal?.aborted, true, "expected session_start to abort the in-flight ask");

  ctx.ui.notify.mockClear();
  await mock.runCommand("btw", "", ctx);
  assert.ok(
    ctx.ui.notify.mock.calls.some((call: unknown[]) => /usage/i.test(call[0] as string)),
    "expected the ring to have been cleared by session_start",
  );

  gate.resolve(assistantMessage("late"));
  await flush();
});
