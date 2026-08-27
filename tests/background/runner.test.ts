import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { mapSpawnError, prepareRun, splitDependencySpec } from "../../modules/background/runner.ts";

async function withTempCwd(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-background-runner-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("splitDependencySpec splits on the last @ past position 0", () => {
  assert.deepEqual(splitDependencySpec("requests==2.32"), {
    name: "requests==2.32",
    version: undefined,
  });
  assert.deepEqual(splitDependencySpec("zod@^4"), { name: "zod", version: "^4" });
  assert.deepEqual(splitDependencySpec("@types/node@^24"), { name: "@types/node", version: "^24" });
  assert.deepEqual(splitDependencySpec("@scope/pkg"), { name: "@scope/pkg", version: undefined });
});

test("mapSpawnError maps a known binary's ENOENT to an install hint, passes through otherwise", () => {
  assert.match(mapSpawnError("spawn uv ENOENT", "uv") ?? "", /uv was not found on PATH/);
  assert.match(
    mapSpawnError("spawn pnpm ENOENT", "/some/stage/node_modules/.bin/pnpm") ?? "",
    /pnpm/,
  );
  assert.equal(mapSpawnError(undefined, "uv"), undefined);
  assert.equal(mapSpawnError("Exited with code 1", "uv"), "Exited with code 1");
  assert.equal(
    mapSpawnError("spawn made-up-binary ENOENT", "made-up-binary"),
    "spawn made-up-binary ENOENT",
  );
});

test("zsh: stages script.zsh and resolves a plain zsh argv", async (t) => {
  const sessionDir = await withTempCwd(t);
  const ctxCwd = await withTempCwd(t);
  const prepared = await prepareRun(
    {
      language: "zsh",
      script: "echo hi",
      file: undefined,
      dependencies: undefined,
      path: undefined,
    },
    { ctxCwd, sessionDir, makeStageId: () => "abc123" },
  );
  assert.equal(prepared.stageDir, join(sessionDir, "run-abc123"));
  assert.deepEqual(prepared.argv, ["zsh", join(prepared.stageDir, "script.zsh")]);
  assert.equal(prepared.cwd, ctxCwd);
  assert.equal(prepared.displayCommand, "zsh script.zsh");
  assert.equal(await readFile(join(prepared.stageDir, "script.zsh"), "utf8"), "echo hi");
});

test("python: --with flags in order, uv run with no deps needs no flags", async (t) => {
  const sessionDir = await withTempCwd(t);
  const ctxCwd = await withTempCwd(t);

  const withDeps = await prepareRun(
    {
      language: "python",
      script: "print(1)",
      file: undefined,
      dependencies: ["requests==2.32", "rich"],
      path: undefined,
    },
    { ctxCwd, sessionDir, makeStageId: () => "py1" },
  );
  assert.deepEqual(withDeps.argv, [
    "uv",
    "run",
    "--with",
    "requests==2.32",
    "--with",
    "rich",
    join(withDeps.stageDir, "script.py"),
  ]);
  assert.equal(withDeps.displayCommand, "uv run --with requests==2.32 --with rich script.py");

  const noDeps = await prepareRun(
    {
      language: "python",
      script: "print(1)",
      file: undefined,
      dependencies: undefined,
      path: undefined,
    },
    { ctxCwd, sessionDir, makeStageId: () => "py2" },
  );
  assert.deepEqual(noDeps.argv, ["uv", "run", join(noDeps.stageDir, "script.py")]);
  assert.equal(noDeps.displayCommand, "uv run script.py");
});

test("typescript: stages package.json with tsx plus user deps, runs the injected installer, argv points at the stage's tsx", async (t) => {
  const sessionDir = await withTempCwd(t);
  const ctxCwd = await withTempCwd(t);
  const installCalls: Array<{ command: string; args: string[]; cwd: string }> = [];

  const prepared = await prepareRun(
    {
      language: "typescript",
      script: "console.log(1)",
      file: undefined,
      dependencies: ["zod@^4", "@types/node@^24"],
      path: undefined,
    },
    {
      ctxCwd,
      sessionDir,
      makeStageId: () => "ts1",
      runInstall: async (command, args, options) => {
        installCalls.push({ command, args, cwd: options.cwd });
        return { code: 0, stderr: "" };
      },
    },
  );

  assert.deepEqual(installCalls, [{ command: "pnpm", args: ["install"], cwd: prepared.stageDir }]);
  assert.deepEqual(prepared.argv, [
    join(prepared.stageDir, "node_modules", ".bin", "tsx"),
    join(prepared.stageDir, "script.ts"),
  ]);
  assert.equal(prepared.displayCommand, "tsx script.ts");

  const packageJson = JSON.parse(await readFile(join(prepared.stageDir, "package.json"), "utf8"));
  assert.deepEqual(packageJson, {
    type: "module",
    devDependencies: { tsx: "latest" },
    dependencies: { zod: "^4", "@types/node": "^24" },
  });
  const workspaceYaml = await readFile(join(prepared.stageDir, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspaceYaml, /allowBuilds:\s*\n\s*esbuild: true/);
});

test("typescript: no user dependencies omits the dependencies field", async (t) => {
  const sessionDir = await withTempCwd(t);
  const ctxCwd = await withTempCwd(t);
  const prepared = await prepareRun(
    {
      language: "typescript",
      script: "1",
      file: undefined,
      dependencies: undefined,
      path: undefined,
    },
    {
      ctxCwd,
      sessionDir,
      makeStageId: () => "ts2",
      runInstall: async () => ({ code: 0, stderr: "" }),
    },
  );
  const packageJson = JSON.parse(await readFile(join(prepared.stageDir, "package.json"), "utf8"));
  assert.deepEqual(packageJson, { type: "module", devDependencies: { tsx: "latest" } });
});

test("typescript: a non-zero pnpm install exit throws with stderr", async (t) => {
  const sessionDir = await withTempCwd(t);
  const ctxCwd = await withTempCwd(t);
  await assert.rejects(
    prepareRun(
      {
        language: "typescript",
        script: "1",
        file: undefined,
        dependencies: undefined,
        path: undefined,
      },
      {
        ctxCwd,
        sessionDir,
        makeStageId: () => "ts3",
        runInstall: async () => ({ code: 1, stderr: "boom" }),
      },
    ),
    /pnpm install failed.*boom/s,
  );
});

test("typescript: a missing pnpm binary is mapped to an install hint", async (t) => {
  const sessionDir = await withTempCwd(t);
  const ctxCwd = await withTempCwd(t);
  await assert.rejects(
    prepareRun(
      {
        language: "typescript",
        script: "1",
        file: undefined,
        dependencies: undefined,
        path: undefined,
      },
      {
        ctxCwd,
        sessionDir,
        makeStageId: () => "ts4",
        runInstall: async () => {
          throw new Error("spawn pnpm ENOENT");
        },
      },
    ),
    /pnpm was not found on PATH/,
  );
});

test("file: copies the source file's bytes into the stage instead of the original path", async (t) => {
  const sessionDir = await withTempCwd(t);
  const ctxCwd = await withTempCwd(t);
  const sourcePath = join(ctxCwd, "existing.zsh");
  await writeFile(sourcePath, "echo from-file", "utf8");

  const prepared = await prepareRun(
    {
      language: "zsh",
      script: undefined,
      file: "existing.zsh",
      dependencies: undefined,
      path: undefined,
    },
    { ctxCwd, sessionDir, makeStageId: () => "file1" },
  );
  const stagedScript = join(prepared.stageDir, "script.zsh");
  assert.equal(prepared.argv[1], stagedScript);
  assert.equal(await readFile(stagedScript, "utf8"), "echo from-file");

  // The copy is independent of the original from this point on.
  await writeFile(sourcePath, "echo changed", "utf8");
  assert.equal(await readFile(stagedScript, "utf8"), "echo from-file");
});

test("requires exactly one of script or file", async (t) => {
  const sessionDir = await withTempCwd(t);
  const ctxCwd = await withTempCwd(t);
  await assert.rejects(
    prepareRun(
      {
        language: "zsh",
        script: undefined,
        file: undefined,
        dependencies: undefined,
        path: undefined,
      },
      { ctxCwd, sessionDir },
    ),
    /exactly one of script or file/,
  );
  await assert.rejects(
    prepareRun(
      { language: "zsh", script: "a", file: "b.zsh", dependencies: undefined, path: undefined },
      { ctxCwd, sessionDir },
    ),
    /exactly one of script or file/,
  );
});

test("rejects dependencies for zsh", async (t) => {
  const sessionDir = await withTempCwd(t);
  const ctxCwd = await withTempCwd(t);
  await assert.rejects(
    prepareRun(
      {
        language: "zsh",
        script: "echo hi",
        file: undefined,
        dependencies: ["curl"],
        path: undefined,
      },
      { ctxCwd, sessionDir },
    ),
    /does not support dependencies for zsh/,
  );
});

test("path must exist and must be a directory", async (t) => {
  const sessionDir = await withTempCwd(t);
  const ctxCwd = await withTempCwd(t);
  await assert.rejects(
    prepareRun(
      {
        language: "zsh",
        script: "echo hi",
        file: undefined,
        dependencies: undefined,
        path: "no-such-dir",
      },
      { ctxCwd, sessionDir },
    ),
    /does not exist/,
  );

  const filePath = join(ctxCwd, "not-a-dir");
  await writeFile(filePath, "x", "utf8");
  await assert.rejects(
    prepareRun(
      {
        language: "zsh",
        script: "echo hi",
        file: undefined,
        dependencies: undefined,
        path: "not-a-dir",
      },
      { ctxCwd, sessionDir },
    ),
    /not a directory/,
  );
});

test("path overrides cwd when given", async (t) => {
  const sessionDir = await withTempCwd(t);
  const ctxCwd = await withTempCwd(t);
  const otherDir = await withTempCwd(t);
  const prepared = await prepareRun(
    {
      language: "zsh",
      script: "echo hi",
      file: undefined,
      dependencies: undefined,
      path: otherDir,
    },
    { ctxCwd, sessionDir, makeStageId: () => "cwd1" },
  );
  assert.equal(prepared.cwd, otherDir);
});
