/**
 * One genuine end-to-end run per language, exercising the real `zsh`/`uv`/
 * `pnpm`+`tsx` binaries instead of a fake spawn. Skipped when the binary
 * isn't on PATH — dev machines and CI here are expected to have all three,
 * but a run must never fail the suite just because one is missing.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/index.ts";
import { afterAll, test } from "vite-plus/test";

import { DetachRegistry } from "../../modules/background/detach.ts";
import { BackgroundTaskRegistry } from "../../modules/background/registry.ts";
import { createRunTool } from "../../modules/background/tools.ts";

function hasBinary(name: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function withTempCwd(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-background-run-e2e-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const agentDir = await mkdtemp(join(tmpdir(), "jpi-background-run-e2e-agent-"));
const store = new Store("background", { PI_CODING_AGENT_DIR: agentDir });
afterAll(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

function makeFakeCtx(cwd: string) {
  return { cwd, sessionManager: { getSessionId: () => "session-e2e" } } as never;
}

function setUpRun() {
  const registry = new BackgroundTaskRegistry({
    store,
    sendNotification: () => undefined,
    stopWaitMs: 5000,
    logger: { error: () => undefined },
  });
  const runTool = createRunTool({
    registry,
    detach: new DetachRegistry(),
    defaultTimeoutSeconds: 100,
  });
  return { registry, runTool };
}

test.skipIf(!hasBinary("zsh"))(
  "zsh: an inline script runs and its output comes back",
  async (t) => {
    const cwd = await withTempCwd(t);
    const { runTool } = setUpRun();
    const result = await runTool.execute(
      "call-1",
      { language: "zsh", script: "echo hello-from-zsh" },
      undefined,
      undefined,
      makeFakeCtx(cwd),
    );
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    assert.match(text, /completed/);
    assert.match(text, /hello-from-zsh/);
  },
);

test.skipIf(!hasBinary("uv"))(
  "python: an inline script with a dependency runs via uv",
  async (t) => {
    const cwd = await withTempCwd(t);
    const { runTool } = setUpRun();
    const result = await runTool.execute(
      "call-1",
      {
        language: "python",
        script: "import sys\nprint('hello-from-python', sys.version_info.major)",
        dependencies: [],
      },
      undefined,
      undefined,
      makeFakeCtx(cwd),
    );
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    assert.match(text, /completed/);
    assert.match(text, /hello-from-python/);
  },
  60_000,
);

test.skipIf(!hasBinary("pnpm"))(
  "typescript: an inline script runs via a staged pnpm install and tsx",
  async (t) => {
    const cwd = await withTempCwd(t);
    const { runTool } = setUpRun();
    const result = await runTool.execute(
      "call-1",
      {
        language: "typescript",
        script: "const x: number = 40 + 2;\nconsole.log('hello-from-typescript', x);",
      },
      undefined,
      undefined,
      makeFakeCtx(cwd),
    );
    const text = result.content[0]!.type === "text" ? result.content[0]!.text : "";
    assert.match(text, /completed/);
    assert.match(text, /hello-from-typescript 42/);
  },
  120_000,
);
