/**
 * settings.test.ts — canary for src/pi/settings.ts.
 *
 * `getAgentDirectory` is pinned against pi's own exported `getAgentDir()`
 * under both env states. `settingsFilePaths`/`readSettingsField` are pinned
 * against a real `SettingsManager`'s own project-over-global merge, reading
 * `defaultModel`/`defaultProvider` — fields pi's `SettingsManager` exposes a
 * getter for — rather than settling for "partial": pi DOES expose a way to
 * check the merge (`SettingsManager.create` + its field getters), it just
 * has no *generic* per-field getter, which is exactly why `readSettingsField`
 * exists.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { CONFIG_DIR_NAME, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getAgentDirectory, readSettingsField, settingsFilePaths } from "../../src/pi/settings.ts";

function isString(value: unknown): value is string {
  return typeof value === "string";
}

describe("settings: getAgentDirectory vs the real getAgentDir() (real pi-coding-agent)", () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  afterEach(() => {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  });

  it("agrees with getAgentDir() when PI_CODING_AGENT_DIR is set", () => {
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-canary-agent-dir";
    expect(getAgentDirectory()).toBe(getAgentDir());
  });

  it("agrees with getAgentDir() when PI_CODING_AGENT_DIR is unset", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    expect(getAgentDirectory()).toBe(getAgentDir());
  });

  it("agrees with getAgentDir() for a tilde-relative PI_CODING_AGENT_DIR", () => {
    process.env.PI_CODING_AGENT_DIR = "~/custom-agent-dir";
    expect(getAgentDirectory()).toBe(getAgentDir());
  });
});

describe("settings: settingsFilePaths/readSettingsField vs a real SettingsManager (real pi-coding-agent)", () => {
  let cwd: string;
  let agentDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-canary-settings-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-canary-settings-agentdir-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("settingsFilePaths matches SettingsManager's own path construction (real CONFIG_DIR_NAME)", () => {
    const [project, global] = settingsFilePaths(cwd, agentDir);
    expect(project).toBe(join(cwd, CONFIG_DIR_NAME, "settings.json"));
    expect(global).toBe(join(agentDir, "settings.json"));
  });

  it("readSettingsField's project-over-global merge agrees with a real SettingsManager", () => {
    mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(
      join(cwd, CONFIG_DIR_NAME, "settings.json"),
      JSON.stringify({ defaultModel: "project-model" }),
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultModel: "global-model", defaultProvider: "global-provider" }),
    );

    const real = SettingsManager.create(cwd, agentDir);
    const [project, global] = settingsFilePaths(cwd, agentDir);
    const jpiModel =
      readSettingsField(project, "defaultModel", isString) ??
      readSettingsField(global, "defaultModel", isString);
    const jpiProvider =
      readSettingsField(project, "defaultProvider", isString) ??
      readSettingsField(global, "defaultProvider", isString);

    // Project overrides global for a field both files set.
    expect(jpiModel).toBe(real.getDefaultModel());
    expect(jpiModel).toBe("project-model");
    // Global-only field still surfaces when project doesn't set it.
    expect(jpiProvider).toBe(real.getDefaultProvider());
    expect(jpiProvider).toBe("global-provider");
  });

  it("readSettingsField is undefined for a missing settings.json, matching an absent file", () => {
    const [project] = settingsFilePaths(cwd, agentDir);
    expect(readSettingsField(project, "defaultModel", isString)).toBeUndefined();
  });

  it("readSettingsField is undefined for a corrupt settings.json", () => {
    mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), "{ not json");
    const [project] = settingsFilePaths(cwd, agentDir);
    expect(readSettingsField(project, "defaultModel", isString)).toBeUndefined();
  });
});
