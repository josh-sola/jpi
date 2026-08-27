import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { RunLanguage } from "./registry.ts";

const SCRIPT_EXTENSION: Record<RunLanguage, string> = {
  zsh: "zsh",
  typescript: "ts",
  python: "py",
};

const TSX_VERSION = "latest";

const INSTALL_HINTS: Record<string, string> = {
  uv: "Install uv (https://docs.astral.sh/uv/) and put it on PATH.",
  pnpm: "Install pnpm (https://pnpm.io/installation) and put it on PATH.",
  zsh: "Install zsh and put it on PATH.",
  tsx: "pnpm install in the stage directory did not produce a tsx binary; check the stage's install log.",
};

export interface PrepareRunInput {
  readonly language: RunLanguage;
  readonly script: string | undefined;
  readonly file: string | undefined;
  readonly dependencies: readonly string[] | undefined;
  readonly path: string | undefined;
}

export interface PreparedRun {
  readonly argv: string[];
  readonly cwd: string;
  readonly stageDir: string;
  readonly displayCommand: string;
  readonly language: RunLanguage;
}

export type InstallRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<{ code: number | null; stderr: string }>;

export interface PrepareRunDeps {
  /** Session cwd, used to resolve a relative `path` or `file`. */
  readonly ctxCwd: string;
  /** Absolute session runtime dir, already created — the stage dir is `run-<id>` under it. */
  readonly sessionDir: string;
  readonly makeStageId?: () => string;
  /** Runs `pnpm install` for a typescript stage. Injectable so tests never touch the network. */
  readonly runInstall?: InstallRunner;
}

function defaultMakeStageId(): string {
  return randomBytes(4).toString("hex");
}

const defaultRunInstall: InstallRunner = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stderr }));
  });

/** PEP 508 / npm-style spec split on the last "@" past position 0, so "@types/node@^24" parses. */
export function splitDependencySpec(spec: string): { name: string; version: string | undefined } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, version: undefined };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/** Maps a spawn's raw ENOENT message to an install hint for a known binary; passes any other error through. */
export function mapSpawnError(error: string | undefined, argv0: string): string | undefined {
  if (!error || !error.includes("ENOENT")) return error;
  const hint = INSTALL_HINTS[basename(argv0)];
  return hint ? `${basename(argv0)} was not found on PATH. ${hint}` : error;
}

function resolveExisting(pathValue: string, base: string, kind: string): string {
  const resolved = isAbsolute(pathValue) ? pathValue : resolve(base, pathValue);
  if (!existsSync(resolved)) throw new Error(`run ${kind} does not exist: ${resolved}`);
  return resolved;
}

function buildTypescriptPackageJson(dependencies: readonly string[]): Record<string, unknown> {
  const deps: Record<string, string> = {};
  for (const spec of dependencies) {
    const { name, version } = splitDependencySpec(spec);
    deps[name] = version ?? "latest";
  }
  const packageJson: Record<string, unknown> = {
    type: "module",
    devDependencies: { tsx: TSX_VERSION },
  };
  if (Object.keys(deps).length > 0) packageJson.dependencies = deps;
  return packageJson;
}

// tsx's only transitive build script is esbuild's; this is the allowlist
// pnpm otherwise wants approved interactively before it will run. pnpm 11
// reads this from pnpm-workspace.yaml's `allowBuilds` — package.json's
// "pnpm" field (and the older onlyBuiltDependencies key) is no longer read.
const PNPM_WORKSPACE_YAML = "allowBuilds:\n  esbuild: true\n";

/**
 * Stages one `run` call: writes the script into `run-<id>/` under the
 * session's runtime dir (a copy, even for `file`, so what ran stays
 * auditable after the original changes), installs dependencies for the
 * language that needs them, and resolves the final argv. The caller then
 * hands `{ argv, cwd }` to `registry.start()`'s prepared-invocation path.
 */
export async function prepareRun(
  input: PrepareRunInput,
  deps: PrepareRunDeps,
): Promise<PreparedRun> {
  if ((input.script === undefined) === (input.file === undefined)) {
    throw new Error("run requires exactly one of script or file");
  }
  const dependencies = input.dependencies ?? [];
  if (input.language === "zsh" && dependencies.length > 0) {
    throw new Error("run does not support dependencies for zsh scripts");
  }

  const cwd = input.path ? resolveExisting(input.path, deps.ctxCwd, "path") : deps.ctxCwd;
  if (input.path && !statSync(cwd).isDirectory()) {
    throw new Error(`run path is not a directory: ${cwd}`);
  }

  const stageId = (deps.makeStageId ?? defaultMakeStageId)();
  const stageDir = join(deps.sessionDir, `run-${stageId}`);
  await mkdir(stageDir, { recursive: true });

  const scriptPath = join(stageDir, `script.${SCRIPT_EXTENSION[input.language]}`);
  if (input.script !== undefined) {
    await writeFile(scriptPath, input.script, "utf8");
  } else {
    const sourcePath = resolveExisting(input.file!, deps.ctxCwd, "file");
    await copyFile(sourcePath, scriptPath);
  }

  if (input.language === "zsh") {
    return {
      argv: ["zsh", scriptPath],
      cwd,
      stageDir,
      displayCommand: "zsh script.zsh",
      language: "zsh",
    };
  }

  if (input.language === "python") {
    const withFlags = dependencies.flatMap((dep) => ["--with", dep]);
    return {
      argv: ["uv", "run", ...withFlags, scriptPath],
      cwd,
      stageDir,
      displayCommand: ["uv run", ...withFlags, "script.py"].join(" "),
      language: "python",
    };
  }

  const packageJson = buildTypescriptPackageJson(dependencies);
  await writeFile(
    join(stageDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(stageDir, "pnpm-workspace.yaml"), PNPM_WORKSPACE_YAML, "utf8");
  const install = deps.runInstall ?? defaultRunInstall;
  let result: { code: number | null; stderr: string };
  try {
    // pnpm blocks a dependency's build script pending interactive approval;
    // the stage's pnpm-workspace.yaml allowlists esbuild's (what tsx needs).
    result = await install("pnpm", ["install"], { cwd: stageDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(mapSpawnError(message, "pnpm") ?? message);
  }
  if (result.code !== 0) {
    throw new Error(
      `pnpm install failed in ${stageDir} (exit ${result.code}): ${result.stderr.trim()}`,
    );
  }

  const tsxBin = join(stageDir, "node_modules", ".bin", "tsx");
  return {
    argv: [tsxBin, scriptPath],
    cwd,
    stageDir,
    displayCommand: "tsx script.ts",
    language: "typescript",
  };
}
