import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { isPidAlive, sweepStaleSessions } from "../../modules/background/sweep.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

async function tempDir(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-background-sweep-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function touch(dir: string, ageMs: number, now: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const seconds = (now - ageMs) / 1000;
  await utimes(dir, seconds, seconds);
}

const alwaysAlive = () => true;
const alwaysDead = () => false;

test("isPidAlive is true for the current process", () => {
  assert.equal(isPidAlive(process.pid), true);
});

test("a dead pid past the TTL is removed", async (t) => {
  const root = await tempDir(t);
  const now = Date.now();
  const dir = join(root, "-repo-a", `session-a-4242`);
  await touch(dir, 8 * DAY_MS, now);

  await sweepStaleSessions(root, 7, now, "/keep", alwaysDead);

  await assert.rejects(stat(dir));
});

test("an alive pid past the TTL is kept", async (t) => {
  const root = await tempDir(t);
  const now = Date.now();
  const dir = join(root, "-repo-a", `session-a-${process.pid}`);
  await touch(dir, 8 * DAY_MS, now);

  await sweepStaleSessions(root, 7, now, "/keep", () => isPidAlive(process.pid));

  assert.ok((await stat(dir)).isDirectory());
});

test("a dead pid within the TTL is kept", async (t) => {
  const root = await tempDir(t);
  const now = Date.now();
  const dir = join(root, "-repo-a", `session-a-4242`);
  await touch(dir, 1 * DAY_MS, now);

  await sweepStaleSessions(root, 7, now, "/keep", alwaysDead);

  assert.ok((await stat(dir)).isDirectory());
});

test("the current session's own dir is always kept, even when stale and dead", async (t) => {
  const root = await tempDir(t);
  const now = Date.now();
  const dir = join(root, "-repo-a", `session-a-4242`);
  await touch(dir, 8 * DAY_MS, now);

  await sweepStaleSessions(root, 7, now, dir, alwaysDead);

  assert.ok((await stat(dir)).isDirectory());
});

test("a dir name with no parsable trailing pid is left alone", async (t) => {
  const root = await tempDir(t);
  const now = Date.now();
  const dir = join(root, "-repo-a", "session-with-no-pid");
  await touch(dir, 8 * DAY_MS, now);

  await sweepStaleSessions(root, 7, now, "/keep", alwaysDead);

  assert.ok((await stat(dir)).isDirectory());
});

test("removes emptied slug dirs and tolerates a nonexistent root", async (t) => {
  const root = await tempDir(t);
  const now = Date.now();
  const dir = join(root, "-repo-a", "session-a-4242");
  await touch(dir, 8 * DAY_MS, now);

  await sweepStaleSessions(root, 7, now, "/keep", alwaysDead);

  const remainingSlugs = await readdir(root);
  assert.deepEqual(remainingSlugs, []);

  await assert.doesNotReject(
    sweepStaleSessions(join(root, "does-not-exist"), 7, now, "/keep", alwaysDead),
  );
});

test("ignores stray plain files at either level", async (t) => {
  const root = await tempDir(t);
  const now = Date.now();

  await writeFile(join(root, "stray-root-file"), "not a slug dir");

  const slugDir = join(root, "-repo-a");
  await mkdir(slugDir, { recursive: true });
  await writeFile(join(slugDir, "stray-session-file-4242"), "not a session dir");

  const sessionDir = join(slugDir, "session-a-4242");
  await touch(sessionDir, 8 * DAY_MS, now);

  await assert.doesNotReject(sweepStaleSessions(root, 7, now, "/keep", alwaysDead));
  await assert.rejects(stat(sessionDir));
});
