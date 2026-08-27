import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vite-plus/test";

import { Store } from "../../src/core/index.ts";

import { appendPrompt, readPrompts, trimLog } from "../../modules/history/store.ts";

async function tempStore(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<Store> {
  const directory = await mkdtemp(join(tmpdir(), "jpi-history-store-test-"));
  t.onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return new Store("history", { PI_CODING_AGENT_DIR: directory });
}

/** Writes the log file directly, bypassing appendPrompt's own directory creation. */
async function writeRawLog(store: Store, contents: string): Promise<void> {
  await mkdir(dirname(store.path("prompts.jsonl")), { recursive: true });
  await appendFile(store.path("prompts.jsonl"), contents, "utf8");
}

test("appendPrompt + readPrompts round-trip newest first, deduped by exact text", async (t) => {
  const store = await tempStore(t);

  await appendPrompt(
    { text: "first", timestamp: "2024-01-01T00:00:01.000Z", cwd: "/repo/a" },
    store,
  );
  await appendPrompt(
    { text: "second", timestamp: "2024-01-01T00:00:02.000Z", cwd: "/repo/a" },
    store,
  );
  await appendPrompt(
    { text: "first", timestamp: "2024-01-01T00:00:03.000Z", cwd: "/repo/a" },
    store,
  );

  assert.deepEqual(await readPrompts(store), [
    { text: "first", timestamp: "2024-01-01T00:00:03.000Z", cwd: "/repo/a" },
    { text: "second", timestamp: "2024-01-01T00:00:02.000Z", cwd: "/repo/a" },
  ]);
});

test("readPrompts skips a malformed hand-written line", async (t) => {
  const store = await tempStore(t);

  await appendPrompt(
    { text: "before", timestamp: "2024-01-01T00:00:01.000Z", cwd: "/repo/a" },
    store,
  );
  await appendFile(store.path("prompts.jsonl"), "not json at all\n", "utf8");
  await appendPrompt(
    { text: "after", timestamp: "2024-01-01T00:00:02.000Z", cwd: "/repo/a" },
    store,
  );

  assert.deepEqual(
    (await readPrompts(store)).map((p) => p.text),
    ["after", "before"],
  );
});

test("readPrompts returns an empty list when the log file doesn't exist yet", async (t) => {
  const store = await tempStore(t);
  assert.deepEqual(await readPrompts(store), []);
});

test("trimLog rewrites an over-full log to its newest maxSize lines, verbatim", async (t) => {
  const store = await tempStore(t);
  const lines = [
    "not json at all",
    ...Array.from({ length: 6 }, (_, i) => JSON.stringify({ text: `p${i}` })),
  ];
  await writeRawLog(store, `${lines.join("\n")}\n`);

  await trimLog(5, store);

  const contents = await readFile(store.path("prompts.jsonl"), "utf8");
  assert.deepEqual(
    contents.split("\n").filter((line) => line !== ""),
    lines.slice(-5),
  );
});

test("trimLog leaves an at-or-under-cap log untouched (no rewrite)", async (t) => {
  const store = await tempStore(t);
  const original = `${JSON.stringify({ text: "a" })}\n${JSON.stringify({ text: "b" })}\n`;
  await writeRawLog(store, original);
  const before = await readFile(store.path("prompts.jsonl"));
  const statBefore = await stat(store.path("prompts.jsonl"));

  await trimLog(2, store);

  const after = await readFile(store.path("prompts.jsonl"));
  const statAfter = await stat(store.path("prompts.jsonl"));
  assert.deepEqual(after, before);
  // Same inode and mtime proves trimLog skipped the write entirely rather
  // than rewriting identical content.
  assert.equal(statAfter.ino, statBefore.ino);
  assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
});

test("trimLog is a no-op when the log file doesn't exist yet", async (t) => {
  const store = await tempStore(t);
  await assert.doesNotReject(trimLog(10, store));
});
