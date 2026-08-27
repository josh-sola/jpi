import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { getSystemPromptPath } from "../../modules/prompt/paths.ts";
import { seedIfMissing } from "../../modules/prompt/seed.ts";

async function tempAgentDir(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-prompt-test-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("seedIfMissing writes the default template when JPI-SYSTEM.md does not exist", async (t) => {
  const agentDir = await tempAgentDir(t);
  const targetPath = getSystemPromptPath({ PI_CODING_AGENT_DIR: agentDir });

  await seedIfMissing(targetPath, "default template body");

  assert.equal(await readFile(targetPath, "utf8"), "default template body");
});

test("seedIfMissing never touches an existing JPI-SYSTEM.md", async (t) => {
  const agentDir = await tempAgentDir(t);
  const targetPath = getSystemPromptPath({ PI_CODING_AGENT_DIR: agentDir });

  await seedIfMissing(targetPath, "first write");
  await seedIfMissing(targetPath, "second write should be ignored");

  assert.equal(await readFile(targetPath, "utf8"), "first write");
});

test("seedIfMissing preserves a file the user wrote before the extension ever ran", async (t) => {
  const agentDir = await tempAgentDir(t);
  const targetPath = getSystemPromptPath({ PI_CODING_AGENT_DIR: agentDir });
  await mkdir(agentDir, { recursive: true });
  await writeFile(targetPath, "user-authored content", "utf8");

  await seedIfMissing(targetPath, "bundled default");

  assert.equal(await readFile(targetPath, "utf8"), "user-authored content");
});
