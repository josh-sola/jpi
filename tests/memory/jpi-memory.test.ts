import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/index.ts";
import { test } from "vite-plus/test";

import { createMemoryExtension } from "../../modules/memory/extension.ts";
import {
  capacityStatus,
  entryCount,
  readMemoryIndex,
  WARN_BYTES,
  OVER_BYTES,
} from "../../modules/memory/memory-index.ts";
import { getMemoryDirectory, projectSlug } from "../../modules/memory/paths.ts";
import { buildMemorySection } from "../../modules/memory/prompt.ts";

async function tempDir(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-memory-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("projectSlug replaces every path separator with a dash", () => {
  assert.equal(projectSlug("/Users/josh/repos/x"), "-Users-josh-repos-x");
  assert.equal(projectSlug("relative/path"), "relative-path");
});

test("projectSlug dashes characters outside the allowed name set", () => {
  assert.equal(projectSlug("/Users/josh/my project"), "-Users-josh-my-project");
});

test("getMemoryDirectory nests under the Pi agent directory by project slug", () => {
  assert.equal(
    getMemoryDirectory("/Users/josh/repos/x", {}, "/Users/tester"),
    "/Users/tester/.pi/agent/jpi/memories/-Users-josh-repos-x",
  );
  assert.equal(
    getMemoryDirectory(
      "/Users/josh/repos/x",
      { PI_CODING_AGENT_DIR: "~/custom-agent" },
      "/Users/tester",
    ),
    "/Users/tester/custom-agent/jpi/memories/-Users-josh-repos-x",
  );
  assert.equal(
    getMemoryDirectory("/repo", { PI_CODING_AGENT_DIR: "/tmp/pi-agent" }, "/Users/tester"),
    "/tmp/pi-agent/jpi/memories/-repo",
  );
});

test("readMemoryIndex reports missing for an absent file and content otherwise", async (t) => {
  const home = await tempDir(t);
  const store = new Store("memories", {}, home);

  const missing = await readMemoryIndex(store, "proj");
  assert.deepEqual(missing, { missing: true });

  await store.writeText(
    "proj/MEMORY.md",
    "- [Title](file.md) — hook\n- [Other](other.md) — hook\n",
  );
  const present = await readMemoryIndex(store, "proj");
  assert.equal(present.missing, false);
  assert.match((present as { content: string }).content, /Title/);
});

test("entryCount counts index lines that start a link entry", () => {
  assert.equal(entryCount(""), 0);
  assert.equal(entryCount("- [A](a.md) — hook\n- [B](b.md) — hook\nnot an entry\n"), 2);
});

test("capacityStatus thresholds at 20KB and 25KB", () => {
  assert.equal(capacityStatus(0), "ok");
  assert.equal(capacityStatus(WARN_BYTES), "ok");
  assert.equal(capacityStatus(WARN_BYTES + 1), "warn");
  assert.equal(capacityStatus(OVER_BYTES), "warn");
  assert.equal(capacityStatus(OVER_BYTES + 1), "over");
});

test("buildMemorySection includes the dir path, schema fence, and index content", () => {
  const section = buildMemorySection(
    "/memories/proj",
    { missing: false, content: "- [Title](file.md) — hook\n" },
    "ok",
  );
  assert.match(section, /# Memory/);
  assert.match(section, /\/memories\/proj/);
  assert.match(section, /metadata:\s*\n\s*type: user \| feedback \| project \| reference/);
  assert.match(section, /- \[Title\]\(file\.md\) — hook/);
  assert.doesNotMatch(section, /Compact it soon|now oversized/);
});

test("buildMemorySection notes an empty index when missing", () => {
  const section = buildMemorySection("/memories/proj", { missing: true }, "ok");
  assert.match(section, /index is empty/i);
});

test("buildMemorySection surfaces capacity warnings only above threshold", () => {
  const content = "- [Title](file.md) — hook\n";
  const ok = buildMemorySection("/memories/proj", { missing: false, content }, "ok");
  const warn = buildMemorySection("/memories/proj", { missing: false, content }, "warn");
  const over = buildMemorySection("/memories/proj", { missing: false, content }, "over");

  assert.doesNotMatch(ok, /Compact it soon|now oversized/);
  assert.match(warn, /Compact it soon/);
  assert.match(over, /now oversized/);
  assert.match(over, /rewrite it now/);
});

test("session_start creates the memory directory", async (t) => {
  const home = await tempDir(t);
  const extension = createMemoryExtension({ env: {}, homeDirectory: home });

  await extension.onSessionStart({}, { cwd: "/repo/project" });

  const memoryDir = join(home, ".pi", "agent", "jpi", "memories", "-repo-project");
  await writeFile(join(memoryDir, "probe.txt"), "ok");
});

test("before_agent_start appends the memory section and keeps the incoming prefix", async (t) => {
  const home = await tempDir(t);
  const env = {};
  const cwd = "/repo/project";
  const memoryDir = getMemoryDirectory(cwd, env, home);
  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, "MEMORY.md"), "- [Title](file.md) — hook\n");

  const extension = createMemoryExtension({ env, homeDirectory: home });

  const result = await extension.onBeforeAgentStart({ systemPrompt: "BASE PROMPT" }, { cwd });

  assert.ok(result.systemPrompt.startsWith("BASE PROMPT\n\n"));
  assert.match(result.systemPrompt, /# Memory/);
  assert.match(result.systemPrompt, /- \[Title\]\(file\.md\) — hook/);
});

test("/jpi-memory command reports dir, existence, size, entry and file counts, and capacity", async (t) => {
  const agentDir = await tempDir(t);
  const env = { PI_CODING_AGENT_DIR: agentDir };
  const cwd = "/repo/project";
  const memoryDir = getMemoryDirectory(cwd, env);

  await mkdir(memoryDir, { recursive: true });
  await writeFile(join(memoryDir, "MEMORY.md"), "- [A](a.md) — hook\n- [B](b.md) — hook\n");
  await writeFile(join(memoryDir, "a.md"), "---\nname: a\n---\nfact");
  await writeFile(join(memoryDir, "b.md"), "---\nname: b\n---\nfact");

  const extension = createMemoryExtension({ env });
  const notifications: { message: string; level?: string }[] = [];
  const ctx = {
    cwd,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, ...(level !== undefined && { level }) });
      },
    },
  };

  await extension.onCommand("", ctx);

  const report = notifications.at(-1);
  assert.ok(report);
  assert.match(report.message, new RegExp(`Memory directory: ${memoryDir}`));
  assert.match(report.message, /exists: yes/);
  assert.match(report.message, /Index entries: 2/);
  assert.match(report.message, /Memory files: 2/);
  assert.match(report.message, /Capacity status: ok/);
  assert.equal(report.level, "info");
});

test("/jpi-memory command reports a not-yet-created index without failing", async (t) => {
  const agentDir = await tempDir(t);
  const env = { PI_CODING_AGENT_DIR: agentDir };
  const cwd = "/repo/empty-project";
  const extension = createMemoryExtension({ env });
  const notifications: { message: string; level?: string }[] = [];
  const ctx = {
    cwd,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, ...(level !== undefined && { level }) });
      },
    },
  };

  await extension.onCommand("", ctx);

  const report = notifications.at(-1);
  assert.ok(report);
  assert.match(report.message, /exists: no/);
  assert.match(report.message, /Index entries: 0/);
  assert.match(report.message, /Memory files: 0/);
});
