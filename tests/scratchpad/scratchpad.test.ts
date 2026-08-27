import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { Config, injectEnabled } from "../../src/core/index.ts";
import { scratchpadSchema } from "../../modules/scratchpad/module.ts";
import {
  buildScratchpadSection,
  ensureScratchpadDir,
  sweepStale,
} from "../../modules/scratchpad/scratchpad.ts";

async function tempDir(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-scratchpad-test-"));
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

test("buildScratchpadSection includes the dir and the IMPORTANT line", () => {
  const section = buildScratchpadSection("/tmp/jpi-scratchpad-501/-repo-project/abc123");
  assert.match(section, /# Scratchpad Directory/);
  assert.match(section, /IMPORTANT: Always use this scratchpad directory/);
  assert.match(section, /`\/tmp\/jpi-scratchpad-501\/-repo-project\/abc123`/);
  assert.match(section, /Only use `\/tmp` if the user explicitly requests it\./);
});

test("ensureScratchpadDir creates nested dirs idempotently", async (t) => {
  const root = await tempDir(t);
  const dir = join(root, "a", "b", "c");

  await ensureScratchpadDir(dir);
  await ensureScratchpadDir(dir);

  const info = await stat(dir);
  assert.ok(info.isDirectory());
});

test("sweepStale deletes only session dirs older than the TTL, never keepDir", async (t) => {
  const root = await tempDir(t);
  const now = Date.now();
  const ttlDays = 7;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;

  const staleDir = join(root, "-repo-a", "old-session");
  const freshDir = join(root, "-repo-a", "new-session");
  const staleKeepDir = join(root, "-repo-b", "kept-session");

  await touch(staleDir, ttlMs + DAY(1), now);
  await touch(freshDir, ttlMs - DAY(1), now);
  await touch(staleKeepDir, ttlMs + DAY(1), now);

  await sweepStale(root, ttlDays, now, staleKeepDir);

  await assert.rejects(stat(staleDir));
  assert.ok((await stat(freshDir)).isDirectory());
  assert.ok((await stat(staleKeepDir)).isDirectory(), "keepDir must survive even when stale");
});

test("sweepStale removes emptied slug dirs and tolerates a nonexistent root", async (t) => {
  const root = await tempDir(t);
  const now = Date.now();
  const ttlDays = 7;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;

  const staleDir = join(root, "-repo-a", "old-session");
  await touch(staleDir, ttlMs + DAY(1), now);

  await sweepStale(root, ttlDays, now, join(root, "-repo-a", "keep"));

  const remainingSlugs = await readdir(root);
  assert.deepEqual(remainingSlugs, []);

  await assert.doesNotReject(sweepStale(join(root, "does-not-exist"), ttlDays, now, "/keep"));
});

test("sweepStale ignores stray plain files at either level", async (t) => {
  const root = await tempDir(t);
  const now = Date.now();
  const ttlDays = 7;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;

  // A stray file directly under root, alongside a real slug dir.
  await writeFile(join(root, "stray-root-file"), "not a slug dir");

  const slugDir = join(root, "-repo-a");
  await mkdir(slugDir, { recursive: true });
  // A stray file inside a slug dir, alongside a real session dir.
  await writeFile(join(slugDir, "stray-session-file"), "not a session dir");

  const staleDir = join(slugDir, "old-session");
  await touch(staleDir, ttlMs + DAY(1), now);

  await assert.doesNotReject(sweepStale(root, ttlDays, now, "/keep"));

  await assert.rejects(stat(staleDir));
  assert.ok((await stat(join(root, "stray-root-file"))).isFile());
  assert.ok((await stat(join(slugDir, "stray-session-file"))).isFile());
});

function DAY(count: number): number {
  return count * 24 * 60 * 60 * 1000;
}

test("scratchpad config defaults load as enabled with a 7 day TTL", async (t) => {
  const home = await tempDir(t);
  const config = new Config("scratchpad", injectEnabled("scratchpad", scratchpadSchema), {}, home);

  const { value, issues } = await config.load();

  assert.deepEqual(issues, []);
  assert.equal(value.enabled, true);
  assert.equal(value.ttlDays, 7);
});
