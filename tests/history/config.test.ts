import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { Config, injectEnabled } from "../../src/core/index.ts";
import { historySchema } from "../../modules/history/config.ts";

function makeConfig(env: NodeJS.ProcessEnv) {
  return new Config("history", injectEnabled("history", historySchema), env);
}

async function tempEnv(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "jpi-history-config-test-"));
  t.onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return { PI_CODING_AGENT_DIR: directory };
}

test("history config defaults max-size to 1000 when the section is absent", async (t) => {
  const config = makeConfig(await tempEnv(t));

  const { value, issues } = await config.load();

  assert.deepEqual(issues, []);
  assert.equal(value.maxSize, 1000);
});

test("history config honors a configured max-size", async (t) => {
  const config = makeConfig(await tempEnv(t));
  await writeFile(config.path, ["history {", "  max-size 250", "}"].join("\n"), "utf8");

  const { value, issues } = await config.load();

  assert.deepEqual(issues, []);
  assert.equal(value.maxSize, 250);
});

test("history config falls back to the default for a nonsense max-size", async (t) => {
  for (const rawMaxSize of ["-5", "0", "3.5", '"abc"']) {
    const config = makeConfig(await tempEnv(t));
    await writeFile(config.path, ["history {", `  max-size ${rawMaxSize}`, "}"].join("\n"), "utf8");

    const { value, issues } = await config.load();

    assert.ok(issues.length > 0, `expected an issue for max-size ${rawMaxSize}`);
    assert.equal(value.maxSize, 1000);
  }
});
