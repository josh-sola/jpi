import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  askBtw,
  type BtwExchange,
  buildBtwContext,
  parseModel,
  type PiModel,
  pushExchange,
  resolveAskModel,
} from "../../modules/btw/ask.ts";

// askBtw and buildBtwContext never inspect the model beyond passing it
// through (and, for replay messages, reading api/provider/id), so a plain
// stub is enough here.
const fakeModel = {
  id: "m1",
  api: "anthropic-messages",
  provider: "anthropic",
} as unknown as PiModel;

function messageEntry(
  id: string,
  role: "user" | "assistant" | "toolResult",
  text: string,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role, content: text, timestamp: 0 },
  } as SessionEntry;
}

function textOf(message: Message): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => ("text" in part ? part.text : "")).join("");
}

test("parseModel splits provider and model id on the first slash", () => {
  assert.deepEqual(parseModel("anthropic/claude-sonnet-5"), {
    provider: "anthropic",
    modelId: "claude-sonnet-5",
  });
});

test("parseModel rejects specs without a usable provider and model id", () => {
  for (const spec of ["", "no-slash", "/missing-provider", "missing-model/", "  "]) {
    assert.equal(parseModel(spec), undefined, `expected rejection for: ${JSON.stringify(spec)}`);
  }
});

test("resolveAskModel uses the configured model when it resolves and has auth", () => {
  const registry = {
    find: (provider: string, modelId: string) =>
      provider === "anthropic" && modelId === "claude-sonnet-5" ? fakeModel : undefined,
    hasConfiguredAuth: () => true,
  };
  assert.equal(resolveAskModel(registry, "anthropic/claude-sonnet-5", undefined), fakeModel);
});

test("resolveAskModel falls back to the session model on the empty default", () => {
  const registry = { find: () => undefined, hasConfiguredAuth: () => false };
  const sessionModel = { id: "session-model" } as unknown as PiModel;
  assert.equal(resolveAskModel(registry, "", sessionModel), sessionModel);
});

test("resolveAskModel falls back to the session model when the configured model has no auth", () => {
  const registry = { find: () => fakeModel, hasConfiguredAuth: () => false };
  const sessionModel = { id: "session-model" } as unknown as PiModel;
  assert.equal(resolveAskModel(registry, "anthropic/claude-sonnet-5", sessionModel), sessionModel);
});

test("resolveAskModel falls back to the session model when the configured model is unknown", () => {
  const registry = { find: () => undefined, hasConfiguredAuth: () => true };
  const sessionModel = { id: "session-model" } as unknown as PiModel;
  assert.equal(resolveAskModel(registry, "anthropic/does-not-exist", sessionModel), sessionModel);
});

test("pushExchange keeps the ring at maxExchanges, dropping the oldest first", () => {
  let ring: readonly BtwExchange[] = [];
  for (let i = 0; i < 5; i++) {
    ring = pushExchange(ring, { question: `q${i}`, answer: `a${i}` }, 3);
  }
  assert.deepEqual(
    ring.map((exchange) => exchange.question),
    ["q2", "q3", "q4"],
  );
});

test("pushExchange keeps everything under the cap", () => {
  const ring = pushExchange(
    [{ question: "q0", answer: "a0" }],
    { question: "q1", answer: "a1" },
    5,
  );
  assert.deepEqual(
    ring.map((exchange) => exchange.question),
    ["q0", "q1"],
  );
});

test("buildBtwContext orders the transcript, then replayed exchanges, then the reminder+question", () => {
  const context = buildBtwContext({
    systemPrompt: "the system prompt",
    sessionEntries: [messageEntry("1", "user", "earlier turn")],
    priorExchanges: [{ question: "first btw", answer: "first answer" }],
    question: "second btw",
    model: fakeModel,
  });

  assert.equal(context.systemPrompt, "the system prompt");
  assert.equal(context.messages.length, 4);

  assert.equal(context.messages[0]?.role, "user");
  assert.equal(textOf(context.messages[0]!), "earlier turn");

  assert.equal(context.messages[1]?.role, "user");
  assert.equal(textOf(context.messages[1]!), "first btw");

  assert.equal(context.messages[2]?.role, "assistant");
  assert.equal(textOf(context.messages[2]!), "first answer");

  const final = context.messages[3]!;
  assert.equal(final.role, "user");
  const finalText = textOf(final);
  assert.ok(finalText.includes("<system-reminder>"), "expected the btw reminder");
  assert.ok(finalText.includes("second btw"), "expected the question");
});

test("buildBtwContext drops non-message entries the way the main turn does", () => {
  const context = buildBtwContext({
    systemPrompt: "sys",
    sessionEntries: [
      {
        type: "thinking_level_change",
        id: "1",
        parentId: null,
        timestamp: "",
        thinkingLevel: "low",
      },
      messageEntry("2", "user", "kept"),
    ] as SessionEntry[],
    priorExchanges: [],
    question: "q",
    model: fakeModel,
  });

  assert.equal(context.messages.length, 2);
  assert.equal(textOf(context.messages[0]!), "kept");
});

test("askBtw returns the answer text on a clean completion", async () => {
  const result = await askBtw(
    {
      model: fakeModel,
      systemPrompt: "sys",
      sessionEntries: [],
      priorExchanges: [],
      question: "q",
      sessionId: "s1",
      timeoutMs: 1_000,
      modelRegistry: {
        complete: async () =>
          ({
            role: "assistant",
            content: [{ type: "text", text: "the answer" }],
            stopReason: "stop",
          }) as unknown as AssistantMessage,
      },
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, { answer: "the answer" });
});

test("askBtw returns an error on a non-stop completion", async () => {
  const result = await askBtw(
    {
      model: fakeModel,
      systemPrompt: "sys",
      sessionEntries: [],
      priorExchanges: [],
      question: "q",
      sessionId: "s1",
      timeoutMs: 1_000,
      modelRegistry: {
        complete: async () =>
          ({ role: "assistant", content: [], stopReason: "length" }) as unknown as AssistantMessage,
      },
    },
    new AbortController().signal,
  );

  assert.equal("error" in result, true);
});

test("askBtw never throws when the model call rejects", async () => {
  const result = await askBtw(
    {
      model: fakeModel,
      systemPrompt: "sys",
      sessionEntries: [],
      priorExchanges: [],
      question: "q",
      sessionId: "s1",
      timeoutMs: 1_000,
      modelRegistry: {
        complete: async () => {
          throw new Error("boom");
        },
      },
    },
    new AbortController().signal,
  );

  assert.deepEqual(result, { error: "boom" });
});

test("askBtw reports an error when the signal is already aborted once the call settles", async () => {
  const controller = new AbortController();
  const result = await askBtw(
    {
      model: fakeModel,
      systemPrompt: "sys",
      sessionEntries: [],
      priorExchanges: [],
      question: "q",
      sessionId: "s1",
      timeoutMs: 1_000,
      modelRegistry: {
        complete: async () => {
          controller.abort();
          return {
            role: "assistant",
            content: [{ type: "text", text: "late" }],
            stopReason: "stop",
          } as unknown as AssistantMessage;
        },
      },
    },
    controller.signal,
  );

  assert.deepEqual(result, { error: "aborted" });
});
