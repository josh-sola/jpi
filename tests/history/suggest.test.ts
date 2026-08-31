import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { AssistantMessage } from "@earendil-works/pi-ai";

import {
  generateSuggestion,
  parseModel,
  renderTranscript,
  sanitizeSuggestion,
  type PiModel,
} from "../../modules/history/suggest.ts";
import type { TranscriptEntryLike } from "../../src/pi/index.ts";

// generateSuggestion never inspects the model beyond passing it through, so
// a bare stub cast is enough here.
const fakeModel = {} as unknown as PiModel;

test("sanitizeSuggestion strips one layer of wrapping quotes", () => {
  assert.equal(sanitizeSuggestion('"run the tests"'), "run the tests");
  assert.equal(sanitizeSuggestion("'run the tests'"), "run the tests");
  assert.equal(sanitizeSuggestion("`run the tests`"), "run the tests");
});

test("sanitizeSuggestion takes only the first non-empty line", () => {
  assert.equal(sanitizeSuggestion("run the tests\nthen commit"), "run the tests");
  assert.equal(sanitizeSuggestion("\n\nrun the tests\nmore"), "run the tests");
});

test("sanitizeSuggestion rejects more than 12 words", () => {
  const raw = Array.from({ length: 13 }, (_unused, index) => `word${index}`).join(" ");
  assert.equal(sanitizeSuggestion(raw), undefined);
});

test("sanitizeSuggestion accepts exactly 12 words", () => {
  const raw = Array.from({ length: 12 }, (_unused, index) => `word${index}`).join(" ");
  assert.equal(sanitizeSuggestion(raw), raw);
});

test("sanitizeSuggestion rejects assistant-voice openers", () => {
  for (const raw of [
    "Let me run the tests",
    "I'll run the tests",
    "I will run the tests",
    "Here's the plan",
    "Here is the plan",
  ]) {
    assert.equal(sanitizeSuggestion(raw), undefined, `expected rejection for: ${raw}`);
  }
});

test("sanitizeSuggestion rejects empty or whitespace-only input", () => {
  assert.equal(sanitizeSuggestion(""), undefined);
  assert.equal(sanitizeSuggestion("   "), undefined);
  assert.equal(sanitizeSuggestion('""'), undefined);
});

test("sanitizeSuggestion trims surrounding whitespace", () => {
  assert.equal(sanitizeSuggestion("  run the tests  "), "run the tests");
});

function messageEntry(role: "user" | "assistant", text: string): TranscriptEntryLike {
  return { type: "message", message: { role, content: [{ type: "text", text }] } };
}

test("renderTranscript keeps user and assistant text, oldest first", () => {
  const rendered = renderTranscript([
    messageEntry("user", "fix the bug"),
    messageEntry("assistant", "done"),
  ]);

  assert.equal(rendered, "[user]\nfix the bug\n\n[assistant]\ndone");
});

test("renderTranscript ignores entries without user/assistant text", () => {
  const entries: TranscriptEntryLike[] = [
    { type: "thinking_level_change" },
    messageEntry("user", "fix the bug"),
    { type: "message", message: { role: "toolResult", content: "irrelevant" } },
  ];

  assert.equal(renderTranscript(entries), "[user]\nfix the bug");
});

test("renderTranscript truncates a single message to its per-message cap", () => {
  const huge = "x".repeat(5_000);
  const rendered = renderTranscript([messageEntry("user", huge)]);

  // Well under the raw 5,000 chars, and short of the ~8,000 total cap too.
  assert.ok(rendered.length < 1_100, `expected a truncated message, got ${rendered.length} chars`);
  assert.ok(rendered.includes("…"), "expected a truncation marker");
});

test("renderTranscript drops the oldest messages first when over the total cap, keeping the newest", () => {
  const entries = Array.from({ length: 20 }, (_unused, index) =>
    messageEntry("user", `message ${index} ${"x".repeat(500)}`),
  );

  const rendered = renderTranscript(entries);

  assert.ok(rendered.includes("message 19"), "expected the newest message to survive");
  assert.ok(!rendered.includes("message 0 "), "expected the oldest message to be dropped");
});

test("renderTranscript returns an empty string when there is nothing to show", () => {
  assert.equal(renderTranscript([]), "");
  assert.equal(renderTranscript([{ type: "thinking_level_change" }]), "");
});

test("parseModel splits provider and model id on the first slash", () => {
  assert.deepEqual(parseModel("openai-codex/gpt-5.6-luna"), {
    provider: "openai-codex",
    modelId: "gpt-5.6-luna",
  });
  assert.deepEqual(parseModel("anthropic/claude/extra"), {
    provider: "anthropic",
    modelId: "claude/extra",
  });
});

test("parseModel rejects specs without a usable provider and model id", () => {
  for (const spec of ["", "no-slash", "/missing-provider", "missing-model/", "  "]) {
    assert.equal(parseModel(spec), undefined, `expected rejection for: ${JSON.stringify(spec)}`);
  }
});

// Only `content` and `stopReason` matter to generateSuggestion; the rest of
// AssistantMessage's shape is irrelevant to these tests.
function assistantMessage(overrides: { text?: string; stopReason?: string }): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: overrides.text ?? "run the tests" }],
    stopReason: overrides.stopReason ?? "stop",
  } as unknown as AssistantMessage;
}

test("generateSuggestion returns a sanitized suggestion on a clean completion", async () => {
  const result = await generateSuggestion(
    {
      model: fakeModel,
      transcriptEntries: [messageEntry("user", "fix the bug and run tests")],
      timeoutMs: 1_000,
      modelRegistry: {
        complete: async () => assistantMessage({}),
      },
    },
    new AbortController().signal,
  );

  assert.equal(result, "run the tests");
});

test("generateSuggestion discards a non-stop completion", async () => {
  const result = await generateSuggestion(
    {
      model: fakeModel,
      transcriptEntries: [messageEntry("user", "fix the bug")],
      timeoutMs: 1_000,
      modelRegistry: {
        complete: async () => assistantMessage({ stopReason: "length" }),
      },
    },
    new AbortController().signal,
  );

  assert.equal(result, undefined);
});

test("generateSuggestion never throws when the model call rejects", async () => {
  const result = await generateSuggestion(
    {
      model: fakeModel,
      transcriptEntries: [messageEntry("user", "fix the bug")],
      timeoutMs: 1_000,
      modelRegistry: {
        complete: async () => {
          throw new Error("boom");
        },
      },
    },
    new AbortController().signal,
  );

  assert.equal(result, undefined);
});

test("generateSuggestion skips the model call when there is no transcript", async () => {
  let called = false;
  const result = await generateSuggestion(
    {
      model: fakeModel,
      transcriptEntries: [],
      timeoutMs: 1_000,
      modelRegistry: {
        complete: async () => {
          called = true;
          return assistantMessage({});
        },
      },
    },
    new AbortController().signal,
  );

  assert.equal(result, undefined);
  assert.equal(called, false);
});
