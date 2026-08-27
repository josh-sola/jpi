/**
 * Guardian's tool_result handler has two ways to hand off a reviewed call's
 * duration: pi's own appendEntry (a separate transcript entry, spaced away
 * from the tool call by pi's CustomEntryComponent) or the shared
 * review-annotation registry the style module renders inline. Which one runs
 * depends on whether a consumer has been marked — a one-way flip for the
 * process, so the "no consumer" case must run before the "consumer" case.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vite-plus/test";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  Config,
  getReviewAnnotation,
  injectEnabled,
  markReviewAnnotationConsumer,
  type ModuleContext,
} from "../../src/core/index.ts";
import autoReview, { guardianSchema, REVIEWED_ENTRY_TYPE } from "../../modules/guardian/index.ts";

async function withTempEnv(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "guardian-annotation-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { env: { PI_CODING_AGENT_DIR: dir } };
}

function fakeModuleCtx(env: NodeJS.ProcessEnv): ModuleContext<typeof guardianSchema> {
  const config = new Config("guardian", injectEnabled("guardian", guardianSchema), env);
  return { config } as unknown as ModuleContext<typeof guardianSchema>;
}

function makeUsage(): Usage {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function makeAllowResponse(): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "reviewer",
    content: [{ type: "text", text: '{"decision":"allow","reason":"routine"}' }],
    usage: makeUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

// Wires autoReview against a fake ExtensionAPI, drives one bash call through
// a review that allows it, then fires every registered tool_result handler
// for that call, returning what pi's appendEntry recorded.
async function driveOneReviewedCall(
  t: TestContext,
  toolCallId: string,
): Promise<{ customType: string; data: unknown }[]> {
  const { env } = await withTempEnv(t);
  const handlers: Record<string, ((event: unknown, ctx?: unknown) => unknown)[]> = {};
  const appendEntryCalls: { customType: string; data: unknown }[] = [];

  autoReview(
    {
      registerCommand() {},
      registerEntryRenderer() {},
      appendEntry(customType: string, data?: unknown) {
        appendEntryCalls.push({ customType, data });
      },
      on(name: string, handler: (event: unknown, ctx?: unknown) => unknown) {
        (handlers[name] ??= []).push(handler);
      },
    } as unknown as ExtensionAPI,
    fakeModuleCtx(env),
  );

  const reviewCtx = {
    cwd: "/repo",
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      find: () => ({}),
      hasConfiguredAuth: () => true,
      complete: async () => makeAllowResponse(),
    },
  };

  const callEvent = {
    type: "tool_call",
    toolCallId,
    toolName: "bash",
    input: { command: "npm test" },
  };
  for (const handler of handlers.tool_call ?? []) {
    const result = await handler(callEvent, reviewCtx);
    assert.equal(result, undefined);
  }

  const resultEvent = {
    type: "tool_result",
    toolCallId,
    toolName: "bash",
    input: { command: "npm test" },
    content: [],
    details: undefined,
    isError: false,
  };
  for (const handler of handlers.tool_result ?? []) {
    await handler(resultEvent);
  }

  return appendEntryCalls;
}

test("without a review-annotation consumer, a reviewed call appends the legacy entry", async (t) => {
  const appendEntryCalls = await driveOneReviewedCall(t, "no-consumer-call");

  assert.equal(appendEntryCalls.length, 1);
  assert.equal(appendEntryCalls[0]!.customType, REVIEWED_ENTRY_TYPE);
  assert.equal(typeof (appendEntryCalls[0]!.data as { durationMs: number }).durationMs, "number");
  assert.equal(getReviewAnnotation("no-consumer-call"), undefined);
});

test("with a review-annotation consumer marked, a reviewed call records the annotation instead", async (t) => {
  markReviewAnnotationConsumer();
  const appendEntryCalls = await driveOneReviewedCall(t, "with-consumer-call");

  assert.deepEqual(appendEntryCalls, []);
  const annotation = getReviewAnnotation("with-consumer-call");
  assert.ok(annotation);
  assert.equal(typeof annotation!.durationMs, "number");
});
