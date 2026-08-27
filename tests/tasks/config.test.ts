/**
 * The `tasks { }` section of the shared jpi.kdl config file: defaults, valid
 * overrides, and how an invalid value is reported and falls back.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { Config, injectEnabled } from "../../src/core/index.ts";
import { tasksSchema } from "../../modules/tasks/config.ts";

function makeConfig(agentDir: string) {
  return new Config("tasks", injectEnabled("tasks", tasksSchema), {
    PI_CODING_AGENT_DIR: agentDir,
  });
}

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-tasks-config-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe("tasks config", () => {
  it("defaults to session scope and on_list_complete auto-clear", async () => {
    const config = makeConfig(agentDir);
    const { value, issues } = await config.load();

    expect(issues).toEqual([]);
    expect(value).toEqual({
      enabled: true,
      scope: "session",
      autoClearCompleted: "on_list_complete",
    });
  });

  it("creates the tasks section in jpi.kdl on first load", async () => {
    const config = makeConfig(agentDir);
    await config.load();

    const text = readFileSync(config.path, "utf8");
    expect(text).toMatch(/tasks \{/);
  });

  it("reads valid overrides from an existing jpi.kdl", async () => {
    const config = makeConfig(agentDir);
    writeFileSync(
      config.path,
      ["tasks {", '  scope "project"', '  auto-clear-completed "never"', "}"].join("\n"),
    );

    const { value, issues } = await config.load();
    expect(issues).toEqual([]);
    expect(value).toEqual({ enabled: true, scope: "project", autoClearCompleted: "never" });
  });

  it("accepts every documented scope value", async () => {
    for (const scope of ["memory", "session", "project"] as const) {
      const dir = mkdtempSync(join(tmpdir(), "pi-tasks-config-scope-"));
      try {
        const config = makeConfig(dir);
        writeFileSync(config.path, ["tasks {", `  scope "${scope}"`, "}"].join("\n"));
        const { value, issues } = await config.load();
        expect(issues).toEqual([]);
        expect(value.scope).toBe(scope);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("reports an issue and falls back to defaults for an unrecognized scope", async () => {
    const config = makeConfig(agentDir);
    writeFileSync(config.path, ["tasks {", '  scope "workspace"', "}"].join("\n"));

    const { value, issues } = await config.load();
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/^tasks\.scope: /);
    expect(value).toEqual({
      enabled: true,
      scope: "session",
      autoClearCompleted: "on_list_complete",
    });
  });

  it("reports an issue and falls back to defaults for an unrecognized autoClearCompleted", async () => {
    const config = makeConfig(agentDir);
    writeFileSync(config.path, ["tasks {", '  auto-clear-completed "sometimes"', "}"].join("\n"));

    const { value, issues } = await config.load();
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/^tasks\.autoClearCompleted: /);
    expect(value).toEqual({
      enabled: true,
      scope: "session",
      autoClearCompleted: "on_list_complete",
    });
  });
});
