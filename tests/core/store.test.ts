import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { sanitizeStoreSegment, Store } from "../../src/core/store.ts";

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "jpi-base-store-"));
  return { PI_CODING_AGENT_DIR: directory };
}

test("path resolves under the extension's own directory", async () => {
  const store = new Store("guardian", await tempEnv());
  assert.match(store.path("state.json"), /\/jpi\/guardian\/state\.json$/);
});

test("path resolves a nested, slash-separated file", async () => {
  const store = new Store("guardian", await tempEnv());
  assert.match(
    store.path("my-slug/session-abc.json"),
    /\/jpi\/guardian\/my-slug\/session-abc\.json$/,
  );
});

test("reading a missing file reports missing rather than a problem", async () => {
  const store = new Store("guardian", await tempEnv());
  assert.deepEqual(await store.read("state.json"), { missing: true });
});

test("reading malformed JSON reports a problem", async () => {
  const env = await tempEnv();
  const store = new Store("guardian", env);
  await mkdir(join(env.PI_CODING_AGENT_DIR as string, "jpi", "guardian"), { recursive: true });
  await writeFile(store.path("state.json"), "{not json", "utf8");

  const result = await store.read("state.json");
  assert.ok("problem" in result);
  assert.match((result as { problem: string }).problem, /^invalid JSON: /);
});

test("write then read round-trips the value, and remove deletes it", async () => {
  const store = new Store("guardian", await tempEnv());
  const value = { enabled: true, items: ["a", "b"] };

  await store.write("state.json", value);
  assert.deepEqual(await store.read("state.json"), { value });

  const written = await readFile(store.path("state.json"), "utf8");
  assert.equal(written, `${JSON.stringify(value, null, 2)}\n`);

  assert.equal(await store.remove("state.json"), undefined);
  assert.deepEqual(await store.read("state.json"), { missing: true });
});

test("removing a file that doesn't exist is a no-op", async () => {
  const store = new Store("guardian", await tempEnv());
  assert.equal(await store.remove("state.json"), undefined);
});

test("write cleans up its temp file when the final rename fails", async () => {
  const env = await tempEnv();
  const store = new Store("guardian", env);

  // Pre-create the target as a directory so the rename in write() fails.
  await mkdir(store.path("state.json"), { recursive: true });

  await assert.rejects(() => store.write("state.json", { a: 1 }));

  const entries = await readdir(join(env.PI_CODING_AGENT_DIR as string, "jpi", "guardian"));
  assert.deepEqual(entries, ["state.json"]);
});

test("extension and file names are validated", async () => {
  const env = await tempEnv();
  assert.throws(() => new Store(".hidden", env), /invalid extension name/);
  assert.throws(() => new Store("has space", env), /invalid extension name/);

  const store = new Store("guardian", env);
  assert.throws(() => store.path(".hidden"), /invalid file name/);
  assert.throws(() => store.path("has space"), /invalid file name/);
});

test("write creates missing parent directories for a nested path, and round-trips through it", async () => {
  const store = new Store("guardian", await tempEnv());
  const value = { session: "abc" };

  await store.write("my-slug/session-abc.json", value);
  assert.deepEqual(await store.read("my-slug/session-abc.json"), { value });

  assert.equal(await store.remove("my-slug/session-abc.json"), undefined);
  assert.deepEqual(await store.read("my-slug/session-abc.json"), { missing: true });
});

test("write puts its temp file in the target's own directory, dot-prefixed", async () => {
  const env = await tempEnv();
  const store = new Store("guardian", env);
  await store.write("my-slug/session-abc.json", { a: 1 });

  const entries = await readdir(
    join(env.PI_CODING_AGENT_DIR as string, "jpi", "guardian", "my-slug"),
  );
  assert.deepEqual(entries, ["session-abc.json"]);
});

test("nested path segments are validated, rejecting .., leading dots, and empty segments", async () => {
  const store = new Store("guardian", await tempEnv());
  assert.throws(() => store.path("../escape.json"), /invalid file name/);
  assert.throws(() => store.path("a/../b.json"), /invalid file name/);
  assert.throws(() => store.path(".hidden/state.json"), /invalid file name/);
  assert.throws(() => store.path("a//b.json"), /invalid file name/);
  assert.throws(() => store.path(""), /invalid file name/);
});

test("writeText then readText round-trips verbatim text, including a nested path", async () => {
  const store = new Store("memory", await tempEnv());

  await store.writeText("notes.md", "hello world");
  assert.deepEqual(await store.readText("notes.md"), { value: "hello world" });

  await store.writeText("a/b/c.md", "nested, no trailing newline");
  assert.deepEqual(await store.readText("a/b/c.md"), { value: "nested, no trailing newline" });

  const written = await readFile(store.path("notes.md"), "utf8");
  assert.equal(written, "hello world");
});

test("readText on a missing file reports missing rather than a problem", async () => {
  const store = new Store("memory", await tempEnv());
  assert.deepEqual(await store.readText("notes.md"), { missing: true });
});

test("writeText replaces existing content", async () => {
  const store = new Store("memory", await tempEnv());

  await store.writeText("notes.md", "first");
  await store.writeText("notes.md", "second");
  assert.deepEqual(await store.readText("notes.md"), { value: "second" });
});

test("ensureDirectory creates the directory, returns the absolute path, and is idempotent", async () => {
  const env = await tempEnv();
  const store = new Store("memory", env);

  const path = await store.ensureDirectory("notes/drafts");
  assert.match(path, /\/jpi\/memory\/notes\/drafts$/);
  assert.ok((await stat(path)).isDirectory());

  const again = await store.ensureDirectory("notes/drafts");
  assert.equal(again, path);
});

test("readText, writeText, ensureDirectory, and list validate segments like path()", async () => {
  const store = new Store("memory", await tempEnv());

  await assert.rejects(() => store.readText("../escape.md"), /invalid file name/);
  await assert.rejects(() => store.readText(".hidden.md"), /invalid file name/);
  await assert.rejects(() => store.readText(""), /invalid file name/);

  await assert.rejects(() => store.writeText("../escape.md", "x"), /invalid file name/);
  await assert.rejects(() => store.writeText(".hidden.md", "x"), /invalid file name/);
  await assert.rejects(() => store.writeText("", "x"), /invalid file name/);

  await assert.rejects(() => store.ensureDirectory("../escape"), /invalid file name/);
  await assert.rejects(() => store.ensureDirectory(".hidden"), /invalid file name/);
  await assert.rejects(() => store.ensureDirectory(""), /invalid file name/);

  await assert.rejects(() => store.list("../escape"), /invalid file name/);
  await assert.rejects(() => store.list(".hidden"), /invalid file name/);
  await assert.rejects(() => store.list(""), /invalid file name/);
});

test("sanitizeStoreSegment replaces every character outside the valid path segment class with -", () => {
  assert.equal(sanitizeStoreSegment("sess:2024/06/01@12:00"), "sess-2024-06-01-12-00");
  assert.equal(sanitizeStoreSegment("abc-123"), "abc-123");
  assert.equal(sanitizeStoreSegment(""), "");
});

test("list returns entry names, skips dot-prefixed entries, and returns [] for a missing directory", async () => {
  const env = await tempEnv();
  const store = new Store("memory", env);

  assert.deepEqual(await store.list("notes"), []);

  await store.writeText("notes/one.md", "1");
  await store.writeText("notes/two.md", "2");
  await writeFile(
    join(env.PI_CODING_AGENT_DIR as string, "jpi", "memory", "notes", ".hidden.md"),
    "3",
    "utf8",
  );

  const entries = await store.list("notes");
  assert.deepEqual(entries.sort(), ["one.md", "two.md"]);
});
